import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AgentRuntime,
  ContextBuilder,
  JsonlEventStore,
  PermissionManager,
  ProviderError,
  ToolExecutor,
  type ContextBundle,
  type MemoryManager,
  type MemoryRecord,
  type MemoryWriteSuggestion,
  type ModelAdapter,
  type ModelResponse,
} from "../src/index.ts";

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "codec-runtime-"));
  await writeFile(join(dir, "notes.txt"), "alpha\nbeta\n");
  return dir;
}

test("runTurn alternates model, tool, typed observation, and final message", async () => {
  const cwd = await workspace();
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  const seenContexts: ContextBundle[] = [];
  const model: ModelAdapter = {
    async complete(context): Promise<ModelResponse> {
      seenContexts.push(context);
      if (seenContexts.length === 1) {
        return {
          toolCalls: [
            {
              id: "call-read",
              name: "read_file",
              input: { path: "notes.txt" },
            },
          ],
        };
      }
      const observation = context.messages.find((message) => message.role === "tool");
      assert.ok(observation);
      assert.equal(observation.content.type, "tool_result");
      assert.equal(observation.content.callId, "call-read");
      assert.equal(observation.content.toolName, "read_file");
      return { finalMessage: `saw ${observation.content.status}` };
    },
  };

  const runtime = new AgentRuntime({
    model,
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
    limits: { maxToolIterations: 4 },
  });

  const result = await runtime.runTurn({
    sessionId: "s1",
    userMessage: "read notes",
    workspace: { cwd },
  });

  assert.equal(result.finalMessage, "saw ok");
  assert.equal(result.finishReason, "final_message");
  assert.equal(seenContexts.length, 2);

  const events = await eventStore.forSession("s1");
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "UserMessage",
      "ContextBuilt",
      "InstructionsResolved",
      "ModelRequestStarted",
      "ModelResponseReceived",
      "PermissionEvaluated",
      "ToolCallStarted",
      "ToolCallFinished",
      "ToolResultInjected",
      "ModelRequestStarted",
      "ModelResponseReceived",
      "AgentFinished",
    ],
  );
});

test("permission deny injects a typed error observation instead of executing a tool", async () => {
  const cwd = await workspace();
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  const model: ModelAdapter = {
    async complete(context): Promise<ModelResponse> {
      const observation = context.messages.find((message) => message.role === "tool");
      if (!observation) {
        return {
          toolCalls: [
            {
              id: "call-deny",
              name: "read_file",
              input: { path: "../secret.txt" },
            },
          ],
        };
      }
      assert.equal(observation.content.status, "error");
      assert.equal(observation.content.error, "permission_denied");
      return { finalMessage: "denied observed" };
    },
  };

  const runtime = new AgentRuntime({
    model,
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
    limits: { maxToolIterations: 4 },
  });

  const result = await runtime.runTurn({
    sessionId: "s-deny",
    userMessage: "read outside",
    workspace: { cwd },
  });

  assert.equal(result.finalMessage, "denied observed");
  const events = await eventStore.forSession("s-deny");
  assert.equal(events.some((event) => event.type === "ToolCallStarted"), false);
  assert.equal(events.some((event) => event.type === "ToolResultInjected"), true);
});

test("permission ask pauses the turn without product UI", async () => {
  const cwd = await workspace();
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  const model: ModelAdapter = {
    async complete(): Promise<ModelResponse> {
      return {
        toolCalls: [
          {
            id: "call-edit",
            name: "edit_file",
            input: { path: "notes.txt", content: "changed\n" },
          },
        ],
      };
    },
  };

  const runtime = new AgentRuntime({
    model,
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });

  const result = await runtime.runTurn({
    sessionId: "s-ask",
    userMessage: "edit notes",
    workspace: { cwd },
  });

  assert.equal(result.finalMessage, "");
  assert.equal(result.nextAction?.type, "approval_required");
  assert.equal(await readFile(join(cwd, "notes.txt"), "utf8"), "alpha\nbeta\n");
});

test("max tool iteration limit stops repeated tool calls", async () => {
  const cwd = await workspace();
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  const model: ModelAdapter = {
    async complete(): Promise<ModelResponse> {
      return {
        toolCalls: [
          {
            id: crypto.randomUUID(),
            name: "read_file",
            input: { path: "notes.txt" },
          },
        ],
      };
    },
  };

  const runtime = new AgentRuntime({
    model,
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
    limits: { maxToolIterations: 2 },
  });

  const result = await runtime.runTurn({
    sessionId: "s-limit",
    userMessage: "loop",
    workspace: { cwd },
  });

  assert.equal(result.finishReason, "tool_iteration_limit");
});

function projectMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-runtime-1",
    scope: "project",
    content: "Use npm.cmd test before committing",
    sourceEventIds: ["evt-runtime-1"],
    confidence: "high",
    freshness: "fresh",
    loadPolicy: "project_entry",
    ...overrides,
  };
}

function suggestion(content: string): MemoryWriteSuggestion {
  return {
    scope: "project",
    content,
    confidence: "medium",
    freshness: "fresh",
    loadPolicy: "on_demand",
  };
}

test("runTurn exposes explicit memory context to the first model request without durable writes", async () => {
  const cwd = await workspace();
  let writes = 0;
  const memoryManager: MemoryManager = {
    async retrieve() {
      return [projectMemory()];
    },
    async write(record) {
      writes += 1;
      return record;
    },
    async applyMaintenance() {
      return {
        appliedAt: "2026-06-06T00:00:00.000Z",
        appliedConflictCount: 0,
        appliedFreshnessCount: 0,
        records: [projectMemory()],
      };
    },
    async list() {
      return [projectMemory()];
    },
  };
  const model: ModelAdapter = {
    async complete(context): Promise<ModelResponse> {
      const memory = context.messages.find(
        (message) => message.role === "system" && message.content && typeof message.content === "object" && message.content.type === "memory_context",
      );
      assert.ok(memory);
      assert.deepEqual(memory.content.records.map((record: { id: string }) => record.id), ["mem-runtime-1"]);
      return { finalMessage: "memory visible" };
    },
  };

  const runtime = new AgentRuntime({
    model,
    eventStore: new JsonlEventStore(join(cwd, ".events.jsonl")),
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });

  const result = await runtime.runTurn({
    sessionId: "runtime-memory",
    userMessage: "use memory",
    workspace: { cwd },
    memorySelections: [{ manager: memoryManager, query: { scope: "project" } }],
  });

  assert.equal(result.finalMessage, "memory visible");
  assert.deepEqual(result.memorySuggestions, []);
  assert.equal(writes, 0);
});

test("runTurn accumulates memory suggestions from multiple successful model responses", async () => {
  const cwd = await workspace();
  const runtime = new AgentRuntime({
    model: {
      async complete(context): Promise<ModelResponse> {
        if (!context.messages.some((message) => message.role === "tool")) {
          return {
            toolCalls: [{ id: "call-read-memory-suggestion", name: "read_file", input: { path: "notes.txt" } }],
            memorySuggestions: [suggestion("remember first")],
          };
        }
        return {
          finalMessage: "done",
          memorySuggestions: [suggestion("remember second")],
        };
      },
    },
    eventStore: new JsonlEventStore(join(cwd, ".events.jsonl")),
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
    limits: { maxToolIterations: 4 },
  });

  const result = await runtime.runTurn({
    sessionId: "runtime-memory-suggestions",
    userMessage: "read and finish",
    workspace: { cwd },
  });

  assert.deepEqual(result.memorySuggestions?.map((item) => item.content), ["remember first", "remember second"]);
});

test("runTurn returns memory suggestions consistently on early return paths", async () => {
  const cwd = await workspace();

  const initialAbort = new AbortController();
  initialAbort.abort("stop before start");
  const initialAbortResult = await new AgentRuntime({
    model: { async complete(): Promise<ModelResponse> { return { finalMessage: "unused" }; } },
    eventStore: new JsonlEventStore(join(cwd, ".events-initial-abort.jsonl")),
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  }).runTurn({
    sessionId: "runtime-initial-abort",
    userMessage: "abort",
    workspace: { cwd },
    abortSignal: initialAbort.signal,
  });
  assert.deepEqual(initialAbortResult.memorySuggestions, []);

  const approvalResult = await new AgentRuntime({
    model: {
      async complete(): Promise<ModelResponse> {
        return {
          toolCalls: [{ id: "call-approval-memory", name: "edit_file", input: { path: "notes.txt", content: "changed\n" } }],
          memorySuggestions: [suggestion("approval path")],
        };
      },
    },
    eventStore: new JsonlEventStore(join(cwd, ".events-approval.jsonl")),
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  }).runTurn({
    sessionId: "runtime-approval-memory",
    userMessage: "edit",
    workspace: { cwd },
  });
  assert.deepEqual(approvalResult.memorySuggestions?.map((item) => item.content), ["approval path"]);

  let modelErrorCalls = 0;
  const modelErrorResult = await new AgentRuntime({
    model: {
      async complete(): Promise<ModelResponse> {
        modelErrorCalls += 1;
        if (modelErrorCalls === 1) {
          return {
            toolCalls: [{ id: "call-model-error-memory", name: "read_file", input: { path: "notes.txt" } }],
            memorySuggestions: [suggestion("before model error")],
          };
        }
        throw new ProviderError("failed", "provider_request_failed", false);
      },
    },
    eventStore: new JsonlEventStore(join(cwd, ".events-model-error.jsonl")),
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
    limits: { maxToolIterations: 4 },
  }).runTurn({
    sessionId: "runtime-model-error-memory",
    userMessage: "read then fail",
    workspace: { cwd },
  });
  assert.deepEqual(modelErrorResult.memorySuggestions?.map((item) => item.content), ["before model error"]);

  const limitResult = await new AgentRuntime({
    model: {
      async complete(): Promise<ModelResponse> {
        return {
          toolCalls: [{ id: crypto.randomUUID(), name: "read_file", input: { path: "notes.txt" } }],
          memorySuggestions: [suggestion("limit path")],
        };
      },
    },
    eventStore: new JsonlEventStore(join(cwd, ".events-limit.jsonl")),
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
    limits: { maxToolIterations: 1 },
  }).runTurn({
    sessionId: "runtime-limit-memory",
    userMessage: "loop once",
    workspace: { cwd },
  });
  assert.deepEqual(limitResult.memorySuggestions?.map((item) => item.content), ["limit path"]);
});
