import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AgentRuntime,
  ContextBuilder,
  JsonlEventStore,
  PermissionManager,
  Replay,
  ToolExecutor,
  type ContextBundle,
  type ModelAdapter,
  type ModelResponse,
} from "../src/index.ts";

test("E2E vertical slice edits a workspace file and replays ordered causal events", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codec-e2e-"));
  await writeFile(join(cwd, "todo.txt"), "ship mvp0\n");
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  const contexts: ContextBundle[] = [];
  const model: ModelAdapter = {
    async complete(context): Promise<ModelResponse> {
      contexts.push(context);
      if (contexts.length === 1) {
        return { toolCalls: [{ id: "read", name: "read_file", input: { path: "todo.txt" } }] };
      }
      if (contexts.length === 2) {
        assert.equal(context.messages.at(-1)?.content.toolName, "read_file");
        return { toolCalls: [{ id: "search", name: "search_text", input: { pattern: "mvp0", path: "." } }] };
      }
      if (contexts.length === 3) {
        assert.equal(context.messages.at(-1)?.content.toolName, "search_text");
        return {
          toolCalls: [
            {
              id: "edit",
              name: "edit_file",
              input: { path: "todo.txt", content: "ship mvp0\nverified\n" },
            },
          ],
        };
      }
      assert.equal(context.messages.at(-1)?.content.toolName, "edit_file");
      return { finalMessage: "MVP-0 file updated from typed observations" };
    },
  };

  const runtime = new AgentRuntime({
    model,
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager({ allowEdits: true }),
    toolExecutor: new ToolExecutor(),
    limits: { maxToolIterations: 5 },
  });

  const result = await runtime.runTurn({
    sessionId: "e2e",
    userMessage: "verify and update todo",
    workspace: { cwd },
  });

  assert.equal(result.finalMessage, "MVP-0 file updated from typed observations");
  assert.equal(await readFile(join(cwd, "todo.txt"), "utf8"), "ship mvp0\nverified\n");

  const replay = Replay.fromEvents(await eventStore.forSession("e2e"));
  assert.deepEqual(replay.toolPairs, [
    { callId: "read", toolName: "read_file", status: "ok" },
    { callId: "search", toolName: "search_text", status: "ok" },
    { callId: "edit", toolName: "edit_file", status: "ok" },
  ]);
  assert.equal(replay.hasPermissionForEveryToolCall, true);
  assert.equal(replay.toolResultsInjectedBeforeNextModelCall, true);
  assert.equal(replay.inspectedToolCalls.read.injection.status, "ok");
  assert.match(replay.inspectedToolCalls.read.injection.observationHash, /^[a-f0-9]{64}$/);
  assert.equal(typeof replay.inspectedToolCalls.read.injection.summary, "string");
  assert.equal(replay.inspectedToolCalls.search.finished.metadataHash.length, 64);
});
