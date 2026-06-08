import assert from "node:assert/strict";
import { test } from "node:test";

import {
  executeMemoryTuiCommand,
  LocalMemoryTuiController,
  parseMemoryTuiCommand,
  type MemoryMaintenanceApplyRequest,
  type MemoryMaintenanceApplyResult,
  type MemoryMaintenanceOptions,
  type MemoryMaintenanceReport,
  type MemoryRecord,
  type MemorySurface,
} from "../src/index.ts";

function projectRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-project-1",
    scope: "project",
    content: "Use pnpm test for this repository",
    sourceEventIds: ["evt-1"],
    confidence: "high",
    freshness: "fresh",
    loadPolicy: "project_entry",
    ...overrides,
  };
}

test("parseMemoryTuiCommand parses list/analyze/apply/quit", () => {
  assert.deepEqual(parseMemoryTuiCommand("list"), { type: "list" });
  assert.deepEqual(parseMemoryTuiCommand("analyze"), { type: "analyze" });
  assert.deepEqual(parseMemoryTuiCommand("apply"), { type: "apply" });
  assert.deepEqual(parseMemoryTuiCommand("quit"), { type: "quit" });
});

test("parseMemoryTuiCommand parses filter and select commands", () => {
  assert.deepEqual(parseMemoryTuiCommand("filter scope project"), { type: "filter_scope", scope: "project" });
  assert.deepEqual(parseMemoryTuiCommand("filter scope all"), { type: "filter_scope" });
  assert.deepEqual(parseMemoryTuiCommand("filter text pnpm test"), { type: "filter_text", text: "pnpm test" });
  assert.deepEqual(parseMemoryTuiCommand("filter text clear"), { type: "filter_text" });
  assert.deepEqual(parseMemoryTuiCommand("select issue 2"), { type: "select_issue", index: 2 });
  assert.deepEqual(parseMemoryTuiCommand("select freshness 1"), { type: "select_freshness", index: 1 });
});

test("parseMemoryTuiCommand returns deterministic errors for invalid input", () => {
  assert.throws(() => parseMemoryTuiCommand(""), /memory_tui_empty_command/);
  assert.throws(() => parseMemoryTuiCommand("unknown"), /memory_tui_unknown_command/);
  assert.throws(() => parseMemoryTuiCommand("filter scope"), /memory_tui_missing_scope_filter/);
  assert.throws(() => parseMemoryTuiCommand("filter text"), /memory_tui_missing_text_filter/);
  assert.throws(() => parseMemoryTuiCommand("select issue nope"), /memory_tui_invalid_index/);
});

test("executeMemoryTuiCommand dispatches list/analyze/filter/apply against the controller", async () => {
  const surface = createFakeSurface({
    inspectRecords: [projectRecord({ id: "mem-a" })],
    maintenance: emptyMaintenanceReport(),
  });
  const controller = new LocalMemoryTuiController(surface.surface);
  await controller.load();

  const listResult = await executeMemoryTuiCommand("list", controller);
  assert.equal(listResult.done, false);
  assert.match(listResult.output, /Records \(1\)/);

  const analyzeResult = await executeMemoryTuiCommand("analyze", controller);
  assert.equal(analyzeResult.done, false);
  assert.equal(surface.analyzeCalls.length >= 2, true);

  const filterResult = await executeMemoryTuiCommand("filter text pnpm", controller);
  assert.equal(filterResult.done, false);
  assert.match(filterResult.output, /Filters: scope=all text=pnpm/);

  const applyResult = await executeMemoryTuiCommand("apply", controller);
  assert.equal(applyResult.done, false);
  assert.equal(surface.applyCalls.length, 0);
  assert.match(applyResult.output, /Status: nothing_selected/);
});

test("executeMemoryTuiCommand dispatches selection commands and quit", async () => {
  const surface = createFakeSurface({
    inspectRecords: [projectRecord({ id: "mem-a" })],
    maintenance: {
      checkedAt: "2026-06-08T00:00:00.000Z",
      issues: [{ type: "conflict", recordId: "mem-a", otherRecordId: "mem-b", reason: "explicit_conflicts_with" }],
      freshnessSuggestions: [{ recordId: "mem-a", currentFreshness: "fresh", suggestedFreshness: "aging", reason: "last_seen_threshold_reached" }],
    },
  });
  const controller = new LocalMemoryTuiController(surface.surface);
  await controller.load();

  const issueResult = await executeMemoryTuiCommand("select issue 0", controller);
  assert.match(issueResult.output, /\[0\] \*/);

  const freshnessResult = await executeMemoryTuiCommand("select freshness 0", controller);
  assert.match(freshnessResult.output, /Freshness \(1\)/);

  const quitResult = await executeMemoryTuiCommand("quit", controller);
  assert.equal(quitResult.done, true);
  assert.equal(quitResult.output, "Goodbye.\n");
});

test("executeMemoryTuiCommand returns deterministic text errors", async () => {
  const surface = createFakeSurface({
    inspectRecords: [projectRecord({ id: "mem-a" })],
    maintenance: emptyMaintenanceReport(),
  });
  const controller = new LocalMemoryTuiController(surface.surface);
  await controller.load();

  const invalidCommand = await executeMemoryTuiCommand("unknown", controller);
  assert.equal(invalidCommand.done, false);
  assert.equal(invalidCommand.output, "memory_tui_unknown_command\n");

  const invalidIndex = await executeMemoryTuiCommand("select issue 3", controller);
  assert.equal(invalidIndex.done, false);
  assert.equal(invalidIndex.output, "memory_tui_invalid_issue_index\n");
});

function emptyMaintenanceReport(): MemoryMaintenanceReport {
  return {
    checkedAt: "2026-06-08T00:00:00.000Z",
    issues: [],
    freshnessSuggestions: [],
  };
}

function emptyApplyResult(records: MemoryRecord[]): MemoryMaintenanceApplyResult {
  return {
    appliedAt: "2026-06-08T00:00:00.000Z",
    appliedConflictCount: 0,
    appliedFreshnessCount: 0,
    records,
  };
}

function createFakeSurface(options: {
  inspectRecords: MemoryRecord[];
  maintenance: MemoryMaintenanceReport;
  applyResult?: MemoryMaintenanceApplyResult;
}) {
  const analyzeCalls: Array<MemoryMaintenanceOptions | undefined> = [];
  const applyCalls: Array<MemoryMaintenanceApplyRequest> = [];
  const surface: MemorySurface = {
    async inspect() {
      return { records: options.inspectRecords };
    },
    async analyze(optionsArg) {
      analyzeCalls.push(optionsArg);
      return options.maintenance;
    },
    async apply(request) {
      applyCalls.push(request);
      return options.applyResult ?? emptyApplyResult(options.inspectRecords);
    },
  };
  return { surface, analyzeCalls, applyCalls };
}
