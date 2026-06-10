import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AgentRuntime,
  ContextBuilder,
  FileSessionStateStore,
  JsonlEventStore,
  PermissionManager,
  ToolExecutor,
  type ModelResponse,
  type PersistedSessionMetadata,
} from "../src/index.ts";

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "codec-session-state-"));
  await writeFile(join(dir, "notes.txt"), "alpha\nbeta\n");
  return dir;
}

function metadata(cwd: string, overrides: Partial<PersistedSessionMetadata> = {}): PersistedSessionMetadata {
  return {
    provider: "openai",
    model: "gpt-5-mini",
    cwd,
    eventStorePath: join(cwd, ".events.jsonl"),
    allowEdits: false,
    baseUrl: "https://example.test/v1",
    ...overrides,
  };
}

function storePath(cwd: string) {
  return join(cwd, ".agent-session-state");
}

test("approval_required persists serializable pending state with full session metadata", async () => {
  const cwd = await workspace();
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  const sessionStateStore = new FileSessionStateStore(storePath(cwd));
  const runtime = new AgentRuntime({
    model: {
      async complete(): Promise<ModelResponse> {
        return {
          toolCalls: [{ id: "call-edit-persisted", name: "edit_file", input: { path: "notes.txt", content: "changed\n" } }],
        };
      },
    },
    eventStore,
    sessionStateStore,
    sessionMetadata: metadata(cwd),
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });

  const result = await runtime.runTurn({
    sessionId: "session-persisted",
    userMessage: "edit notes",
    workspace: { cwd },
    abortSignal: new AbortController().signal,
  });

  assert.equal(result.nextAction?.type, "approval_required");

  const persisted = await sessionStateStore.loadPending("session-persisted");
  assert.ok(persisted);
  assert.equal(persisted.metadata.baseUrl, "https://example.test/v1");
  assert.equal(persisted.metadata.eventStorePath, join(cwd, ".events.jsonl"));
  assert.equal(persisted.pending.sessionId, "session-persisted");
  assert.equal(persisted.pending.pendingCall.id, "call-edit-persisted");
  assert.equal("abortSignal" in persisted.pending.workspace, false);
  assert.equal(JSON.stringify(persisted).includes("abortSignal"), false);
});

test("new runtime can restore persisted pending state and clear it only after successful terminal continuation", async () => {
  const cwd = await workspace();
  const eventStorePath = join(cwd, ".events.jsonl");
  const sessionStateStore = new FileSessionStateStore(storePath(cwd));

  const firstRuntime = new AgentRuntime({
    model: {
      async complete(): Promise<ModelResponse> {
        return {
          toolCalls: [
            { id: "call-edit-restore", name: "edit_file", input: { path: "notes.txt", content: "changed\n" } },
            { id: "call-read-restore", name: "read_file", input: { path: "notes.txt" } },
          ],
        };
      },
    },
    eventStore: new JsonlEventStore(eventStorePath),
    sessionStateStore,
    sessionMetadata: metadata(cwd),
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });

  const initial = await firstRuntime.runTurn({
    sessionId: "session-restore",
    userMessage: "edit then read",
    workspace: { cwd },
  });
  assert.equal(initial.nextAction?.type, "approval_required");
  assert.ok(await sessionStateStore.loadPending("session-restore"));

  let modelCalls = 0;
  const secondRuntime = new AgentRuntime({
    model: {
      async complete(): Promise<ModelResponse> {
        modelCalls += 1;
        return { finalMessage: `restored-${modelCalls}` };
      },
    },
    eventStore: new JsonlEventStore(eventStorePath),
    sessionStateStore,
    sessionMetadata: metadata(cwd),
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });

  const restored = await secondRuntime.restorePersistedPending("session-restore");
  assert.equal(restored.approvalId, "approval-call-edit-restore");
  assert.ok(secondRuntime.getPendingApproval("session-restore"));
  assert.ok(await sessionStateStore.loadPending("session-restore"));

  const resumed = await secondRuntime.resumeAfterApproval({
    sessionId: "session-restore",
    approvalId: "approval-call-edit-restore",
    resolution: "allow",
  });

  assert.equal(resumed.finalMessage, "restored-1");
  assert.equal(await readFile(join(cwd, "notes.txt"), "utf8"), "changed\n");
  assert.equal(await sessionStateStore.loadPending("session-restore"), undefined);
});

test("persisted pending state survives continuation failure after restore", async () => {
  const cwd = await workspace();
  const eventStorePath = join(cwd, ".events.jsonl");
  const sessionStateStore = new FileSessionStateStore(storePath(cwd));

  const firstRuntime = new AgentRuntime({
    model: {
      async complete(): Promise<ModelResponse> {
        return {
          toolCalls: [{ id: "call-edit-crash", name: "edit_file", input: { path: "notes.txt", content: "changed\n" } }],
        };
      },
    },
    eventStore: new JsonlEventStore(eventStorePath),
    sessionStateStore,
    sessionMetadata: metadata(cwd),
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });
  await firstRuntime.runTurn({
    sessionId: "session-crash",
    userMessage: "edit notes",
    workspace: { cwd },
  });

  class ThrowingToolExecutor extends ToolExecutor {
    override async execute() {
      throw new Error("tool_executor_crashed");
    }
  }

  const secondRuntime = new AgentRuntime({
    model: {
      async complete(): Promise<ModelResponse> {
        return { finalMessage: "unreachable" };
      },
    },
    eventStore: new JsonlEventStore(eventStorePath),
    sessionStateStore,
    sessionMetadata: metadata(cwd),
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ThrowingToolExecutor(),
  });

  await secondRuntime.restorePersistedPending("session-crash");
  await assert.rejects(
    () =>
      secondRuntime.resumeAfterApproval({
        sessionId: "session-crash",
        approvalId: "approval-call-edit-crash",
        resolution: "allow",
      }),
    /tool_executor_crashed/,
  );
  assert.ok(await sessionStateStore.loadPending("session-crash"));
});

test("restorePersistedPending rejects event-log mismatch deterministically", async () => {
  const cwd = await workspace();
  const eventStorePath = join(cwd, ".events.jsonl");
  const sessionStateStore = new FileSessionStateStore(storePath(cwd));
  const eventStore = new JsonlEventStore(eventStorePath);

  const runtime = new AgentRuntime({
    model: {
      async complete(): Promise<ModelResponse> {
        return {
          toolCalls: [{ id: "call-edit-mismatch", name: "edit_file", input: { path: "notes.txt", content: "changed\n" } }],
        };
      },
    },
    eventStore,
    sessionStateStore,
    sessionMetadata: metadata(cwd),
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });

  await runtime.runTurn({
    sessionId: "session-mismatch",
    userMessage: "edit notes",
    workspace: { cwd },
  });
  await eventStore.append({
    type: "ApprovalResolved",
    sessionId: "session-mismatch",
    approvalId: "approval-call-edit-mismatch",
    resolution: "deny",
  });

  const restoredRuntime = new AgentRuntime({
    model: {
      async complete(): Promise<ModelResponse> {
        return { finalMessage: "unused" };
      },
    },
    eventStore: new JsonlEventStore(eventStorePath),
    sessionStateStore,
    sessionMetadata: metadata(cwd),
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });

  await assert.rejects(() => restoredRuntime.restorePersistedPending("session-mismatch"), /resume_state_mismatch/);
});

test("restored pending state can continue through deny and clear persisted snapshot on terminal completion", async () => {
  const cwd = await workspace();
  const eventStorePath = join(cwd, ".events.jsonl");
  const sessionStateStore = new FileSessionStateStore(storePath(cwd));

  const firstRuntime = new AgentRuntime({
    model: {
      async complete(): Promise<ModelResponse> {
        return {
          toolCalls: [
            { id: "call-edit-deny-persisted", name: "edit_file", input: { path: "notes.txt", content: "changed\n" } },
            { id: "call-read-deny-persisted", name: "read_file", input: { path: "notes.txt" } },
          ],
        };
      },
    },
    eventStore: new JsonlEventStore(eventStorePath),
    sessionStateStore,
    sessionMetadata: metadata(cwd),
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });
  await firstRuntime.runTurn({
    sessionId: "session-deny-persisted",
    userMessage: "edit then read",
    workspace: { cwd },
  });

  let modelCalls = 0;
  const secondRuntime = new AgentRuntime({
    model: {
      async complete(context): Promise<ModelResponse> {
        modelCalls += 1;
        const toolMessages = context.messages.filter((message) => message.role === "tool");
        assert.deepEqual(toolMessages.map((message) => [message.content.callId, message.content.status]), [
          ["call-edit-deny-persisted", "error"],
          ["call-read-deny-persisted", "ok"],
        ]);
        return { finalMessage: `deny-restored-${modelCalls}` };
      },
    },
    eventStore: new JsonlEventStore(eventStorePath),
    sessionStateStore,
    sessionMetadata: metadata(cwd),
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });

  await secondRuntime.restorePersistedPending("session-deny-persisted");
  const resumed = await secondRuntime.resumeAfterApproval({
    sessionId: "session-deny-persisted",
    approvalId: "approval-call-edit-deny-persisted",
    resolution: "deny",
  });

  assert.equal(resumed.finalMessage, "deny-restored-1");
  assert.equal(await readFile(join(cwd, "notes.txt"), "utf8"), "alpha\nbeta\n");
  assert.equal(await sessionStateStore.loadPending("session-deny-persisted"), undefined);
});
