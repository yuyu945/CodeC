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
  ToolExecutor,
  type ContextBundle,
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
