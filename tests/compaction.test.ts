import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AgentRuntime,
  ContextBuilder,
  FakeModelAdapter,
  JsonlEventStore,
  PermissionManager,
  ProviderError,
  Replay,
  ToolExecutor,
  createOpenAIResponsesAdapter,
} from "../src/index.ts";

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "codec-compaction-"));
  await writeFile(join(dir, "notes.txt"), "alpha\nbeta\n");
  return dir;
}

test("FakeModelAdapter exposes deterministic provider-owned budget estimation", () => {
  const adapter = new FakeModelAdapter([], {
    model: "deterministic",
    contextWindow: 120,
    compactThreshold: 90,
  });

  const budget = adapter.estimateBudget({
    sessionId: "budget",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "x".repeat(200) },
    ],
    toolDefinitions: [],
    budgetReport: {
      estimatedUnits: 0,
      limit: 0,
      threshold: 0,
      mustCompact: false,
      tier: "none",
    },
  });

  assert.equal(budget.limit, 120);
  assert.equal(budget.threshold, 90);
  assert.equal(typeof budget.estimatedUnits, "number");
  assert.equal(budget.mustCompact, true);
});

test("OpenAI adapter classifies oversized-context provider failures distinctly", async () => {
  const adapter = createOpenAIResponsesAdapter(
    { provider: "openai", model: "gpt-5-mini", apiKey: "test-key" },
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "context_length_exceeded",
            message: "This model's maximum context length is exceeded.",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
  );

  await assert.rejects(
    adapter.complete({
      sessionId: "oversized",
      messages: [{ role: "user", content: "hello" }],
      toolDefinitions: [],
      budgetReport: {
        estimatedUnits: 0,
        limit: 0,
        threshold: 0,
        mustCompact: false,
        tier: "none",
      },
    }),
    (error: unknown) => error instanceof ProviderError && error.code === "provider_context_too_large",
  );
});

test("AgentRuntime proactively auto-compacts oversized context before the first model call", async () => {
  const cwd = await workspace();
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  const seenMessageCounts: number[] = [];

  const runtime = new AgentRuntime({
    model: new FakeModelAdapter([], {
      model: "deterministic",
      contextWindow: 160,
      compactThreshold: 120,
      responder: async (request) => {
        seenMessageCounts.push(request.messages.length);
        return { finalMessage: "compacted" };
      },
    }),
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });

  const result = await runtime.runTurn({
    sessionId: "auto-compact",
    userMessage: "x ".repeat(400),
    workspace: { cwd },
  });

  assert.equal(result.finalMessage, "compacted");
  assert.equal(seenMessageCounts.length, 1);

  const events = await eventStore.forSession("auto-compact");
  assert.equal(events.some((event) => event.type === "ContextCompacted" && event.tier === "auto_compact"), true);
});

test("AgentRuntime reactively compacts after provider_context_too_large and recovers", async () => {
  const cwd = await workspace();
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  let calls = 0;

  const runtime = new AgentRuntime({
    model: new FakeModelAdapter([], {
      model: "deterministic",
      contextWindow: 300,
      compactThreshold: 220,
      responder: async (request) => {
        calls += 1;
        if (calls === 1) {
          throw new ProviderError("too large", "provider_context_too_large", true);
        }
        assert.equal(request.budgetReport.tier === "reactive_compact" || request.budgetReport.tier === "snip", true);
        return { finalMessage: "recovered after reactive compact" };
      },
    }),
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });

  const result = await runtime.runTurn({
    sessionId: "reactive-compact",
    userMessage: "y ".repeat(500),
    workspace: { cwd },
  });

  assert.equal(result.finalMessage, "recovered after reactive compact");
  const replay = Replay.fromEvents(await eventStore.forSession("reactive-compact"));
  assert.equal(replay.compactions.some((event) => event.tier === "reactive_compact"), true);
});

test("AgentRuntime falls through to snip and records dropped fragment classes", async () => {
  const cwd = await workspace();
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));

  const runtime = new AgentRuntime({
    model: new FakeModelAdapter([], {
      model: "deterministic",
      contextWindow: 80,
      compactThreshold: 60,
      responder: async (request) => {
        if ((request.budgetReport.overflowBy ?? 0) > 0) {
          throw new ProviderError("still too large", "provider_context_too_large", true);
        }
        return { finalMessage: "snipped enough" };
      },
    }),
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });

  const result = await runtime.runTurn({
    sessionId: "snip",
    userMessage: "z ".repeat(600),
    workspace: { cwd },
  });

  assert.equal(result.finalMessage, "snipped enough");
  const replay = Replay.fromEvents(await eventStore.forSession("snip"));
  assert.equal(replay.compactions.some((event) => event.tier === "snip"), true);
  assert.equal(replay.compactions.some((event) => event.discardedClasses.length > 0), true);
});
