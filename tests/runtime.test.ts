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

class CountingApprovalPermissionManager extends PermissionManager {
  evaluateCalls: Array<{ callId: string; toolName: string }> = [];

  override async evaluate(call: { id: string; name: string }, workspace: { cwd: string }) {
    this.evaluateCalls.push({ callId: call.id, toolName: call.name });
    if (call.name === "edit_file") {
      return {
        kind: "ask" as const,
        reason: "edit_requires_approval",
        snapshot: { cwd: workspace.cwd, policy: "counting-test" },
      };
    }
    return await super.evaluate(call as never, workspace);
  }
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

test("runtime injects actionable invalid tool input errors so the model can self-correct", async () => {
  const cwd = await workspace();
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  let calls = 0;
  const runtime = new AgentRuntime({
    model: {
      async complete(context): Promise<ModelResponse> {
        calls += 1;
        if (calls === 1) {
          return {
            toolCalls: [{ id: "call-bad-read", name: "read_file", input: {} }],
          };
        }
        const observation = context.messages.find((message) => message.role === "tool");
        assert.ok(observation);
        assert.equal(observation.content.status, "error");
        assert.equal(observation.content.error, "invalid_read_file_input: expected { path: string }");
        if (calls === 2) {
          return {
            toolCalls: [{ id: "call-good-read", name: "read_file", input: { path: "notes.txt" } }],
          };
        }
        return { finalMessage: "self-corrected" };
      },
    },
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
    limits: { maxToolIterations: 4 },
  });

  const result = await runtime.runTurn({
    sessionId: "s-self-correct",
    userMessage: "read notes even if the first tool input is malformed",
    workspace: { cwd },
  });

  assert.equal(result.finalMessage, "self-corrected");
});

test("approval_required stores a pending snapshot with remaining tool calls and emits approval events", async () => {
  const cwd = await workspace();
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  const permissionManager = new CountingApprovalPermissionManager();
  const runtime = new AgentRuntime({
    model: {
      async complete(): Promise<ModelResponse> {
        return {
          toolCalls: [
            { id: "call-edit-pending", name: "edit_file", input: { path: "notes.txt", content: "changed\n" } },
            { id: "call-read-pending", name: "read_file", input: { path: "notes.txt" } },
          ],
          memorySuggestions: [suggestion("pending snapshot memory")],
        };
      },
    },
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager,
    toolExecutor: new ToolExecutor(),
  });

  const result = await runtime.runTurn({
    sessionId: "s-pending",
    userMessage: "edit then read",
    workspace: { cwd },
  });

  assert.equal(result.nextAction?.type, "approval_required");
  assert.equal(result.nextAction?.approvalId, "approval-call-edit-pending");
  assert.deepEqual(permissionManager.evaluateCalls, [{ callId: "call-edit-pending", toolName: "edit_file" }]);
  assert.deepEqual(result.memorySuggestions?.map((item) => item.content), ["pending snapshot memory"]);

  const pending = runtime.getPendingApproval("s-pending");
  assert.ok(pending);
  assert.equal(pending.approvalId, "approval-call-edit-pending");
  assert.equal(pending.request.sessionId, "s-pending");
  assert.equal(pending.request.workspace.cwd, cwd);
  assert.equal(pending.iteration, 0);
  assert.equal(pending.pendingCall.id, "call-edit-pending");
  assert.deepEqual(pending.remainingToolCalls.map((call) => call.id), ["call-read-pending"]);
  assert.deepEqual(pending.memorySuggestions.map((item) => item.content), ["pending snapshot memory"]);
  assert.equal(await readFile(join(cwd, "notes.txt"), "utf8"), "alpha\nbeta\n");

  const events = await eventStore.forSession("s-pending");
  assert.equal(events.at(-1)?.type, "ApprovalPending");
});

test("resumeAfterApproval allow executes the pending call without re-evaluating permissions and preserves tool order", async () => {
  const cwd = await workspace();
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  const permissionManager = new CountingApprovalPermissionManager();
  let modelCalls = 0;
  const runtime = new AgentRuntime({
    model: {
      async complete(context): Promise<ModelResponse> {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            toolCalls: [
              { id: "call-edit-allow", name: "edit_file", input: { path: "notes.txt", content: "changed\n" } },
              { id: "call-read-allow", name: "read_file", input: { path: "notes.txt" } },
            ],
            memorySuggestions: [suggestion("before approval"), suggestion("before approval second")],
          };
        }
        const toolMessages = context.messages.filter((message) => message.role === "tool");
        assert.deepEqual(toolMessages.map((message) => message.content.callId), ["call-edit-allow", "call-read-allow"]);
        return {
          finalMessage: "allow resumed",
          memorySuggestions: [suggestion("after approval")],
        };
      },
    },
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager,
    toolExecutor: new ToolExecutor(),
    limits: { maxToolIterations: 4 },
  });

  const initial = await runtime.runTurn({
    sessionId: "s-allow",
    userMessage: "edit then read",
    workspace: { cwd },
  });
  assert.equal(initial.nextAction?.type, "approval_required");

  const resumed = await runtime.resumeAfterApproval({
    sessionId: "s-allow",
    approvalId: "approval-call-edit-allow",
    resolution: "allow",
  });

  assert.equal(resumed.finalMessage, "allow resumed");
  assert.equal(resumed.finishReason, "final_message");
  assert.deepEqual(permissionManager.evaluateCalls, [
    { callId: "call-edit-allow", toolName: "edit_file" },
    { callId: "call-read-allow", toolName: "read_file" },
  ]);
  assert.equal(runtime.getPendingApproval("s-allow"), undefined);
  assert.equal(await readFile(join(cwd, "notes.txt"), "utf8"), "changed\n");
  assert.deepEqual(resumed.memorySuggestions?.map((item) => item.content), ["before approval", "before approval second", "after approval"]);

  const events = await eventStore.forSession("s-allow");
  assert.deepEqual(
    events.filter((event) => event.type === "ApprovalPending" || event.type === "ApprovalResolved" || event.type === "TurnResumed").map((event) => event.type),
    ["ApprovalPending", "ApprovalResolved", "TurnResumed"],
  );
});

test("resumeAfterApproval deny injects a permission error, continues remaining tool calls, and leaves the file unchanged", async () => {
  const cwd = await workspace();
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  const permissionManager = new CountingApprovalPermissionManager();
  let modelCalls = 0;
  const runtime = new AgentRuntime({
    model: {
      async complete(context): Promise<ModelResponse> {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            toolCalls: [
              { id: "call-edit-deny", name: "edit_file", input: { path: "notes.txt", content: "changed\n" } },
              { id: "call-read-deny", name: "read_file", input: { path: "notes.txt" } },
            ],
          };
        }
        const toolMessages = context.messages.filter((message) => message.role === "tool");
        assert.deepEqual(toolMessages.map((message) => [message.content.callId, message.content.status]), [
          ["call-edit-deny", "error"],
          ["call-read-deny", "ok"],
        ]);
        assert.equal(toolMessages[0].content.error, "permission_denied");
        return { finalMessage: "deny resumed" };
      },
    },
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager,
    toolExecutor: new ToolExecutor(),
    limits: { maxToolIterations: 4 },
  });

  const initial = await runtime.runTurn({
    sessionId: "s-deny-resume",
    userMessage: "edit then read",
    workspace: { cwd },
  });
  assert.equal(initial.nextAction?.type, "approval_required");

  const resumed = await runtime.resumeAfterApproval({
    sessionId: "s-deny-resume",
    approvalId: "approval-call-edit-deny",
    resolution: "deny",
  });

  assert.equal(resumed.finalMessage, "deny resumed");
  assert.equal(await readFile(join(cwd, "notes.txt"), "utf8"), "alpha\nbeta\n");
  assert.deepEqual(permissionManager.evaluateCalls, [
    { callId: "call-edit-deny", toolName: "edit_file" },
    { callId: "call-read-deny", toolName: "read_file" },
  ]);
});

test("resumeAfterApproval returns deterministic results for invalid or repeated resume attempts", async () => {
  const cwd = await workspace();
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  let modelCalls = 0;
  const runtime = new AgentRuntime({
    model: {
      async complete(): Promise<ModelResponse> {
        modelCalls += 1;
        if (modelCalls > 1) return { finalMessage: "done after denial" };
        return {
          toolCalls: [{ id: "call-edit-repeat", name: "edit_file", input: { path: "notes.txt", content: "changed\n" } }],
        };
      },
    },
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });

  const missing = await runtime.resumeAfterApproval({
    sessionId: "missing-session",
    approvalId: "approval-missing",
    resolution: "allow",
  });
  assert.equal(missing.finalMessage, "Cannot resume: no pending approval for session missing-session.");
  assert.equal(missing.nextAction, undefined);

  const initial = await runtime.runTurn({
    sessionId: "s-repeat",
    userMessage: "edit once",
    workspace: { cwd },
  });
  assert.equal(initial.nextAction?.type, "approval_required");

  const wrongId = await runtime.resumeAfterApproval({
    sessionId: "s-repeat",
    approvalId: "approval-other",
    resolution: "allow",
  });
  assert.equal(wrongId.finalMessage, "Cannot resume: approval approval-other does not match pending approval for session s-repeat.");

  const resumed = await runtime.resumeAfterApproval({
    sessionId: "s-repeat",
    approvalId: "approval-call-edit-repeat",
    resolution: "deny",
  });
  assert.equal(resumed.finalMessage, "done after denial");
  assert.equal(resumed.nextAction, undefined);

  const repeated = await runtime.resumeAfterApproval({
    sessionId: "s-repeat",
    approvalId: "approval-call-edit-repeat",
    resolution: "deny",
  });
  assert.equal(repeated.finalMessage, "Cannot resume: no pending approval for session s-repeat.");
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
