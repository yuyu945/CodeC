import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AgentRuntime,
  ContextBuilder,
  eventCoverageChecklist,
  JsonlEventStore,
  PermissionManager,
  SessionInspector,
  ToolExecutor,
  type ModelAdapter,
  type ModelResponse,
} from "../src/index.ts";

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "codec-observability-"));
  await writeFile(join(cwd, "todo.txt"), "ship observability\n");
  return cwd;
}

test("eventCoverageChecklist reports which metrics are safely inferable from current AgentEvent", async () => {
  const cwd = await workspace();
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  const model: ModelAdapter = {
    async complete(): Promise<ModelResponse> {
      return { finalMessage: "done" };
    },
  };

  const runtime = new AgentRuntime({
    model,
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });

  await runtime.runTurn({
    sessionId: "coverage",
    userMessage: "simple",
    workspace: { cwd },
  });

  const events = await eventStore.forSession("coverage");
  const coverage = eventCoverageChecklist(events);

  assert.equal(coverage.toolCounts, true);
  assert.equal(coverage.finishReason, true);
  assert.equal(coverage.compactionDetails, true);
  assert.equal(coverage.instructionDetails, true);
  assert.equal(coverage.abortPath, true);
  assert.equal(coverage.retryCount, false);
});

test("SessionInspector derives SessionSummary and SessionMetrics from an existing session", async () => {
  const cwd = await workspace();
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  let turns = 0;
  const model: ModelAdapter = {
    async complete(): Promise<ModelResponse> {
      turns += 1;
      if (turns === 1) {
        return { toolCalls: [{ id: "read", name: "read_file", input: { path: "todo.txt" } }] };
      }
      return { finalMessage: "done" };
    },
  };

  const runtime = new AgentRuntime({
    model,
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });

  await runtime.runTurn({
    sessionId: "inspect",
    userMessage: "read todo",
    workspace: { cwd },
  });

  const inspector = new SessionInspector(await eventStore.forSession("inspect"));
  const summary = inspector.summary();
  const metrics = inspector.metrics();

  assert.equal(summary.sessionId, "inspect");
  assert.equal(summary.finishReason, "final_message");
  assert.equal(summary.instructionsApplied, true);
  assert.equal(summary.compactionRan, false);
  assert.equal(summary.providerNames.length >= 1, true);

  assert.equal(metrics.modelCallCount, 2);
  assert.equal(metrics.toolCallCounts.read_file, 1);
  assert.equal(metrics.permissionDecisionCounts.allow, 1);
  assert.equal(metrics.finishReasonCounts.final_message, 1);
});

test("SessionInspector keeps outputs redacted and can emit a local JSON report", async () => {
  const cwd = await workspace();
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  const model: ModelAdapter = {
    async complete(): Promise<ModelResponse> {
      return { finalMessage: "done" };
    },
  };

  const runtime = new AgentRuntime({
    model,
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });

  await runtime.runTurn({
    sessionId: "json-report",
    userMessage: "secret sk-test-123 should not leak",
    workspace: { cwd },
  });

  const inspector = new SessionInspector(await eventStore.forSession("json-report"));
  const summary = inspector.summary();
  const report = inspector.toJsonReport();

  assert.doesNotMatch(JSON.stringify(summary), /sk-test-123/);
  assert.doesNotMatch(report, /sk-test-123/);

  const parsed = JSON.parse(report);
  assert.equal(parsed.summary.sessionId, "json-report");
  assert.equal(typeof parsed.metrics.modelCallCount, "number");
});
