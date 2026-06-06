import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  classifyMemoryScope,
  ContextBuilder,
  FileMemoryStore,
  JsonlEventStore,
  LocalMemorySurface,
  LocalMemoryManager,
  MemoryMaintenanceAnalyzer,
  type MemoryMaintenanceApplyResult,
  type MemoryMaintenanceApplyRequest,
  type MemoryMaintenanceApplyResult as MaintenanceApplyResult,
  type MemoryMaintenanceReport,
  type MemoryMaintenanceOptions,
  type MemoryContextPayload,
  type MemoryManager,
  type MemoryQuery,
  type MemoryRecord,
} from "../src/index.ts";

async function workspace() {
  return await mkdtemp(join(tmpdir(), "codec-memory-"));
}

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

test("classifyMemoryScope distinguishes project facts from reference locators", () => {
  assert.equal(classifyMemoryScope("Run pnpm test in this repository"), "project");
  assert.equal(classifyMemoryScope("Code freeze starts on Friday"), "project");
  assert.equal(classifyMemoryScope("PR link: https://github.com/org/repo/pull/12"), "reference");
  assert.equal(classifyMemoryScope("Issue: https://linear.app/acme/issue/ABC-1"), "reference");
  assert.equal(classifyMemoryScope("Entry point is src/runtime.ts"), "reference");
});

test("FileMemoryStore persists and retrieves project/reference records deterministically", async () => {
  const cwd = await workspace();
  const store = new FileMemoryStore(join(cwd, ".memory.jsonl"));

  await store.write(projectRecord({ id: "mem-project-1" }));
  await store.write(
    projectRecord({
      id: "mem-ref-1",
      scope: "reference",
      content: "Runbook: https://example.test/runbook",
      loadPolicy: "on_demand",
    }),
  );

  const all = await store.list();
  assert.deepEqual(all.map((record) => record.id), ["mem-project-1", "mem-ref-1"]);

  const projectOnly = await store.retrieve({ scope: "project" });
  assert.deepEqual(projectOnly.map((record) => record.id), ["mem-project-1"]);
});

test("LocalMemoryManager enforces explicit writes and preserves provenance", async () => {
  const cwd = await workspace();
  const manager = new LocalMemoryManager(new FileMemoryStore(join(cwd, ".memory.jsonl")));

  await manager.write(projectRecord({ id: "mem-project-2", sourceEventIds: ["evt-1", "evt-2"] }));
  const records = await manager.retrieve({ scope: "project" });

  assert.deepEqual(records[0].sourceEventIds, ["evt-1", "evt-2"]);
});

test("LocalMemoryManager redacts sensitive content before persistence", async () => {
  const cwd = await workspace();
  const path = join(cwd, ".memory.jsonl");
  const manager = new LocalMemoryManager(new FileMemoryStore(path));

  await manager.write(
    projectRecord({
      id: "mem-project-redacted",
      content: "OPENAI_API_KEY=sk-secret-123",
    }),
  );

  const records = await manager.retrieve({ scope: "project" });
  assert.doesNotMatch(records[0].content, /sk-secret-123/);
  assert.equal(records[0].metadata?.redacted, true);

  const persisted = await readFile(path, "utf8");
  assert.doesNotMatch(persisted, /sk-secret-123/);
});

test("ordinary event-store activity does not create durable memory automatically", async () => {
  const cwd = await workspace();
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  const memoryStore = new FileMemoryStore(join(cwd, ".memory.jsonl"));

  await eventStore.append({ type: "UserMessage", sessionId: "session-1", text: "hello" });
  const records = await memoryStore.list();
  assert.equal(records.length, 0);
});

test("LocalMemoryManager retrieval supports exact scope and basic text match", async () => {
  const cwd = await workspace();
  const manager = new LocalMemoryManager(new FileMemoryStore(join(cwd, ".memory.jsonl")));

  await manager.write(projectRecord({ id: "mem-a", content: "Use pnpm test" }));
  await manager.write(projectRecord({ id: "mem-b", content: "Runbook at https://example.test/runbook", scope: "reference", loadPolicy: "on_demand" }));

  const textMatch = await manager.retrieve({ text: "pnpm", scope: "project" });
  assert.deepEqual(textMatch.map((record) => record.id), ["mem-a"]);
});

test("ContextBuilder injects explicit memory selections as one aggregate memory_context", async () => {
  const cwd = await workspace();
  const manager = new LocalMemoryManager(new FileMemoryStore(join(cwd, ".memory.jsonl")));
  await manager.write(projectRecord({ id: "mem-a", content: "Use npm.cmd test for this repository", tags: ["test"] }));
  await manager.write(projectRecord({ id: "mem-b", content: "Project prefers explicit memory selection", tags: ["memory"] }));

  const context = await new ContextBuilder().build({
    sessionId: "memory-context",
    userMessage: "what should I remember?",
    workspace: { cwd },
    memorySelections: [{ manager, query: { scope: "project" } }],
  });

  const memoryFragments = context.fragments.filter((fragment) => fragment.summaryKind === "memory");
  assert.equal(memoryFragments.length, 1);
  assert.equal(memoryFragments[0].role, "system");
  assert.equal(memoryFragments[0].source, "system");
  assert.equal(memoryFragments[0].priority, 70);
  assert.equal(memoryFragments[0].pinned, false);
  assert.equal(memoryFragments[0].discardable, true);

  const payload = memoryFragments[0].content as MemoryContextPayload;
  assert.equal(payload.type, "memory_context");
  assert.deepEqual(payload.records.map((record) => record.id), ["mem-a", "mem-b"]);
  assert.equal(payload.selectedCount, payload.records.length);
  assert.equal(payload.truncated, false);
  assert.equal("sourceEventIds" in payload.records[0], false);
});

test("ContextBuilder memory selection dedupes records and reports per-selection truncation", async () => {
  const cwd = await workspace();
  const manager = new LocalMemoryManager(new FileMemoryStore(join(cwd, ".memory.jsonl")));
  for (let index = 1; index <= 10; index += 1) {
    await manager.write(projectRecord({ id: `mem-${index}`, content: `memory ${index}` }));
  }

  const context = await new ContextBuilder().build({
    sessionId: "memory-dedupe",
    userMessage: "load memory",
    workspace: { cwd },
    memorySelections: [
      { manager, query: { scope: "project" }, maxRecords: 2.9 },
      { manager, query: { text: "memory 2" }, maxRecords: 8 },
    ],
  });

  const payload = context.fragments.find((fragment) => fragment.summaryKind === "memory")?.content as MemoryContextPayload;
  assert.deepEqual(payload.records.map((record) => record.id), ["mem-1", "mem-2"]);
  assert.equal(payload.selectedCount, 2);
  assert.equal(payload.truncated, true);
});

test("ContextBuilder memory selection default limit and non-positive limits are deterministic", async () => {
  const cwd = await workspace();
  const manager = new LocalMemoryManager(new FileMemoryStore(join(cwd, ".memory.jsonl")));
  for (let index = 1; index <= 9; index += 1) {
    await manager.write(projectRecord({ id: `mem-default-${index}`, content: `default limit ${index}` }));
  }

  const context = await new ContextBuilder().build({
    sessionId: "memory-limits",
    userMessage: "load memory",
    workspace: { cwd },
    memorySelections: [
      { manager, query: { scope: "project" } },
      { manager, query: { text: "default limit 9" }, maxRecords: 0 },
    ],
  });

  const payload = context.fragments.find((fragment) => fragment.summaryKind === "memory")?.content as MemoryContextPayload;
  assert.equal(payload.records.length, 8);
  assert.deepEqual(payload.records.map((record) => record.id), [
    "mem-default-1",
    "mem-default-2",
    "mem-default-3",
    "mem-default-4",
    "mem-default-5",
    "mem-default-6",
    "mem-default-7",
    "mem-default-8",
  ]);
  assert.equal(payload.selectedCount, 8);
  assert.equal(payload.truncated, true);
});

test("ContextBuilder does not inject memory without explicit selections", async () => {
  const cwd = await workspace();
  const context = await new ContextBuilder().build({
    sessionId: "memory-none",
    userMessage: "hello",
    workspace: { cwd },
  });

  assert.equal(context.fragments.some((fragment) => fragment.summaryKind === "memory"), false);
});

test("ContextBuilder redacts injected memory content", async () => {
  const cwd = await workspace();
  const manager = new LocalMemoryManager(new FileMemoryStore(join(cwd, ".memory.jsonl")));
  await manager.write(projectRecord({ id: "mem-secret", content: "Use token sk-secret-123 for tests" }));

  const context = await new ContextBuilder().build({
    sessionId: "memory-redacted",
    userMessage: "load memory",
    workspace: { cwd },
    memorySelections: [{ manager, query: { scope: "project" } }],
  });

  const payload = context.fragments.find((fragment) => fragment.summaryKind === "memory")?.content as MemoryContextPayload;
  assert.doesNotMatch(payload.records[0].content, /sk-secret-123/);
});

test("MemoryMaintenanceAnalyzer emits explicit conflict issues even when target record is missing", () => {
  const report = new MemoryMaintenanceAnalyzer().analyze([
    projectRecord({
      id: "mem-explicit",
      conflictsWith: ["mem-missing"],
    }),
  ], { now: "2026-06-06T00:00:00.000Z" });

  assert.match(report.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(report.issues, [
    {
      type: "conflict",
      recordId: "mem-explicit",
      otherRecordId: "mem-missing",
      reason: "explicit_conflicts_with",
    },
  ]);
});

test("MemoryMaintenanceAnalyzer detects heuristic conflicts for shared-tag replacement phrasing", () => {
  const report = new MemoryMaintenanceAnalyzer().analyze([
    projectRecord({
      id: "mem-pnpm",
      content: "Use pnpm test",
      tags: ["test-command"],
    }),
    projectRecord({
      id: "mem-npmcmd",
      content: "Do not use pnpm test, use npm.cmd test instead",
      tags: ["test-command"],
    }),
  ], { now: "2026-06-06T00:00:00.000Z" });

  assert.deepEqual(report.issues, [
    {
      type: "conflict",
      recordId: "mem-pnpm",
      otherRecordId: "mem-npmcmd",
      reason: "heuristic_signal_phrase_conflict",
    },
  ]);
});

test("MemoryMaintenanceAnalyzer skips heuristic conflicts without shared tags or across scopes", () => {
  const analyzer = new MemoryMaintenanceAnalyzer();

  const noSharedTags = analyzer.analyze([
    projectRecord({ id: "mem-a", content: "Use pnpm test", tags: ["a"] }),
    projectRecord({ id: "mem-b", content: "Do not use pnpm test, use npm.cmd test instead", tags: ["b"] }),
  ], { now: "2026-06-06T00:00:00.000Z" });
  assert.deepEqual(noSharedTags.issues, []);

  const crossScope = analyzer.analyze([
    projectRecord({ id: "mem-project", content: "Use pnpm test", tags: ["test-command"], scope: "project" }),
    projectRecord({ id: "mem-reference", content: "Do not use pnpm test, use npm.cmd test instead", tags: ["test-command"], scope: "reference", loadPolicy: "on_demand" }),
  ], { now: "2026-06-06T00:00:00.000Z" });
  assert.deepEqual(crossScope.issues, []);
});

test("MemoryMaintenanceAnalyzer suppresses duplicate conflict pairs when explicit and heuristic both match", () => {
  const report = new MemoryMaintenanceAnalyzer().analyze([
    projectRecord({
      id: "mem-a",
      content: "Use pnpm test",
      tags: ["test-command"],
      conflictsWith: ["mem-b"],
    }),
    projectRecord({
      id: "mem-b",
      content: "Do not use pnpm test, use npm.cmd test instead",
      tags: ["test-command"],
    }),
  ], { now: "2026-06-06T00:00:00.000Z" });

  assert.deepEqual(report.issues, [
    {
      type: "conflict",
      recordId: "mem-a",
      otherRecordId: "mem-b",
      reason: "explicit_conflicts_with",
    },
  ]);
});

test("MemoryMaintenanceAnalyzer prefers lastSeenAt over createdAt for freshness aging", () => {
  const report = new MemoryMaintenanceAnalyzer().analyze([
    projectRecord({
      id: "mem-aging",
      freshness: "fresh",
      metadata: {
        createdAt: "2025-01-01T00:00:00.000Z",
        lastSeenAt: "2026-05-01T00:00:00.000Z",
      },
    }),
  ], { now: "2026-06-06T00:00:00.000Z" });

  assert.deepEqual(report.freshnessSuggestions, [
    {
      recordId: "mem-aging",
      currentFreshness: "fresh",
      suggestedFreshness: "aging",
      reason: "last_seen_threshold_reached",
    },
  ]);
});

test("MemoryMaintenanceAnalyzer suggests stale once age meets the stale threshold", () => {
  const report = new MemoryMaintenanceAnalyzer().analyze([
    projectRecord({
      id: "mem-stale",
      freshness: "fresh",
      metadata: {
        lastSeenAt: "2026-03-08T00:00:00.000Z",
      },
    }),
  ], { now: "2026-06-06T00:00:00.000Z" });

  assert.deepEqual(report.freshnessSuggestions, [
    {
      recordId: "mem-stale",
      currentFreshness: "fresh",
      suggestedFreshness: "stale",
      reason: "last_seen_threshold_reached",
    },
  ]);
});

test("MemoryMaintenanceAnalyzer prioritizes expired records but skips stale no-op suggestions", () => {
  const report = new MemoryMaintenanceAnalyzer().analyze([
    projectRecord({
      id: "mem-expired",
      freshness: "aging",
      expiresAt: "2026-06-05T00:00:00.000Z",
    }),
    projectRecord({
      id: "mem-already-stale",
      freshness: "stale",
      expiresAt: "2026-06-05T00:00:00.000Z",
    }),
  ], { now: "2026-06-06T00:00:00.000Z" });

  assert.deepEqual(report.freshnessSuggestions, [
    {
      recordId: "mem-expired",
      currentFreshness: "aging",
      suggestedFreshness: "stale",
      reason: "record_expired",
    },
  ]);
});

test("MemoryMaintenanceAnalyzer ignores invalid timestamps without throwing", () => {
  const report = new MemoryMaintenanceAnalyzer().analyze([
    projectRecord({
      id: "mem-invalid-timestamps",
      metadata: {
        createdAt: "not-a-date",
        lastSeenAt: "still-not-a-date",
      },
      expiresAt: "also-not-a-date",
    }),
  ], { now: "2026-06-06T00:00:00.000Z" });

  assert.deepEqual(report.freshnessSuggestions, []);
});

test("MemoryMaintenanceAnalyzer does not mutate input records", () => {
  const records = [
    projectRecord({
      id: "mem-immutable",
      tags: ["test-command"],
      conflictsWith: ["mem-other"],
      metadata: {
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }),
  ];
  const before = JSON.stringify(records);

  const report = new MemoryMaintenanceAnalyzer().analyze(records, { now: "2026-06-06T00:00:00.000Z" });

  assert.equal(JSON.stringify(records), before);
  assert.equal(typeof (report as MemoryMaintenanceReport).checkedAt, "string");
});

test("LocalMemoryManager applyMaintenance updates approved freshness suggestions and persists them", async () => {
  const cwd = await workspace();
  const path = join(cwd, ".memory.jsonl");
  const manager = new LocalMemoryManager(new FileMemoryStore(path));
  await manager.write(projectRecord({
    id: "mem-apply-freshness",
    freshness: "fresh",
    metadata: {
      lastSeenAt: "2026-05-01T00:00:00.000Z",
    },
  }));

  const analyzer = new MemoryMaintenanceAnalyzer();
  const report = analyzer.analyze(await manager.list(), { now: "2026-06-06T00:00:00.000Z" });
  const result = await manager.applyMaintenance({
    now: "2026-06-06T00:00:00.000Z",
    freshnessSuggestions: report.freshnessSuggestions,
  });

  assert.equal((result as MemoryMaintenanceApplyResult).appliedAt, "2026-06-06T00:00:00.000Z");
  assert.equal(result.appliedFreshnessCount, 1);
  assert.equal(result.appliedConflictCount, 0);
  assert.deepEqual(result.records.map((record) => record.id), ["mem-apply-freshness"]);
  assert.equal(result.records[0].freshness, "aging");

  const records = await manager.list();
  assert.equal(records[0].freshness, "aging");
  const persisted = await readFile(path, "utf8");
  assert.match(persisted, /"freshness":"aging"/);
});

test("LocalMemoryManager applyMaintenance applies approved conflict issues symmetrically without duplicates", async () => {
  const cwd = await workspace();
  const manager = new LocalMemoryManager(new FileMemoryStore(join(cwd, ".memory.jsonl")));
  await manager.write(projectRecord({
    id: "mem-conflict-a",
    content: "Use pnpm test",
    tags: ["test-command"],
  }));
  await manager.write(projectRecord({
    id: "mem-conflict-b",
    content: "Do not use pnpm test, use npm.cmd test instead",
    tags: ["test-command"],
  }));

  const report = new MemoryMaintenanceAnalyzer().analyze(await manager.list(), { now: "2026-06-06T00:00:00.000Z" });
  const result = await manager.applyMaintenance({
    now: "2026-06-06T00:00:00.000Z",
    issues: report.issues,
  });

  assert.equal(result.appliedConflictCount, 1);
  assert.equal(result.appliedFreshnessCount, 0);

  const records = await manager.list();
  const left = records.find((record) => record.id === "mem-conflict-a");
  const right = records.find((record) => record.id === "mem-conflict-b");
  assert.deepEqual(left?.conflictsWith, ["mem-conflict-b"]);
  assert.deepEqual(right?.conflictsWith, ["mem-conflict-a"]);

  const secondPass = await manager.applyMaintenance({
    now: "2026-06-06T00:00:00.000Z",
    issues: report.issues,
  });
  assert.equal(secondPass.appliedConflictCount, 0);
});

test("LocalMemoryManager applyMaintenance treats repeated approved issues as one applied change", async () => {
  const cwd = await workspace();
  const manager = new LocalMemoryManager(new FileMemoryStore(join(cwd, ".memory.jsonl")));
  await manager.write(projectRecord({ id: "mem-dup-a", content: "Use pnpm test", tags: ["test-command"] }));
  await manager.write(projectRecord({ id: "mem-dup-b", content: "Do not use pnpm test, use npm.cmd test instead", tags: ["test-command"] }));

  const report = new MemoryMaintenanceAnalyzer().analyze(await manager.list(), { now: "2026-06-06T00:00:00.000Z" });
  const result = await manager.applyMaintenance({
    now: "2026-06-06T00:00:00.000Z",
    issues: [...report.issues, ...report.issues],
  });

  assert.equal(result.appliedConflictCount, 1);
});

test("LocalMemoryManager applyMaintenance only applies caller-selected updates", async () => {
  const cwd = await workspace();
  const manager = new LocalMemoryManager(new FileMemoryStore(join(cwd, ".memory.jsonl")));
  await manager.write(projectRecord({
    id: "mem-selective-a",
    freshness: "fresh",
    metadata: {
      lastSeenAt: "2026-05-01T00:00:00.000Z",
    },
  }));
  await manager.write(projectRecord({
    id: "mem-selective-b",
    freshness: "fresh",
    metadata: {
      lastSeenAt: "2026-02-01T00:00:00.000Z",
    },
  }));

  const report = new MemoryMaintenanceAnalyzer().analyze(await manager.list(), { now: "2026-06-06T00:00:00.000Z" });
  const selected = report.freshnessSuggestions.filter((item) => item.recordId === "mem-selective-a");
  const result = await manager.applyMaintenance({
    now: "2026-06-06T00:00:00.000Z",
    freshnessSuggestions: selected,
  });

  assert.equal(result.appliedFreshnessCount, 1);
  const records = await manager.list();
  assert.equal(records.find((record) => record.id === "mem-selective-a")?.freshness, "aging");
  assert.equal(records.find((record) => record.id === "mem-selective-b")?.freshness, "fresh");
});

test("LocalMemoryManager applyMaintenance skips freshness suggestions when store freshness has drifted", async () => {
  const cwd = await workspace();
  const manager = new LocalMemoryManager(new FileMemoryStore(join(cwd, ".memory.jsonl")));
  await manager.write(projectRecord({
    id: "mem-drift",
    freshness: "fresh",
    metadata: {
      lastSeenAt: "2026-05-01T00:00:00.000Z",
    },
  }));

  const report = new MemoryMaintenanceAnalyzer().analyze(await manager.list(), { now: "2026-06-06T00:00:00.000Z" });
  await manager.applyMaintenance({
    now: "2026-06-06T00:00:00.000Z",
    freshnessSuggestions: report.freshnessSuggestions,
  });

  const driftedResult = await manager.applyMaintenance({
    now: "2026-06-06T00:00:00.000Z",
    freshnessSuggestions: report.freshnessSuggestions,
  });

  assert.equal(driftedResult.appliedFreshnessCount, 0);
  assert.equal(driftedResult.records[0].freshness, "aging");
});

test("LocalMemoryManager applyMaintenance treats repeated approved freshness suggestions as one applied change", async () => {
  const cwd = await workspace();
  const manager = new LocalMemoryManager(new FileMemoryStore(join(cwd, ".memory.jsonl")));
  await manager.write(projectRecord({
    id: "mem-repeat-freshness",
    freshness: "fresh",
    metadata: {
      lastSeenAt: "2026-05-01T00:00:00.000Z",
    },
  }));

  const report = new MemoryMaintenanceAnalyzer().analyze(await manager.list(), { now: "2026-06-06T00:00:00.000Z" });
  const result = await manager.applyMaintenance({
    now: "2026-06-06T00:00:00.000Z",
    freshnessSuggestions: [...report.freshnessSuggestions, ...report.freshnessSuggestions],
  });

  assert.equal(result.appliedFreshnessCount, 1);
});

test("LocalMemoryManager applyMaintenance ignores missing records and does not mutate unrelated fields", async () => {
  const cwd = await workspace();
  const manager = new LocalMemoryManager(new FileMemoryStore(join(cwd, ".memory.jsonl")));
  await manager.write(projectRecord({
    id: "mem-stable",
    content: "stable content",
    tags: ["stable"],
    metadata: {
      createdAt: "2026-01-01T00:00:00.000Z",
      custom: "keep-me",
    },
  }));

  const before = await manager.list();
  const result = await manager.applyMaintenance({
    now: "2026-06-06T00:00:00.000Z",
    issues: [{ type: "conflict", recordId: "mem-stable", otherRecordId: "mem-missing", reason: "explicit_conflicts_with" }],
    freshnessSuggestions: [{ recordId: "mem-ghost", currentFreshness: "fresh", suggestedFreshness: "aging", reason: "last_seen_threshold_reached" }],
  });

  assert.equal(result.appliedFreshnessCount, 0);
  assert.equal(result.appliedConflictCount, 1);

  const after = await manager.list();
  assert.deepEqual(after[0].conflictsWith, ["mem-missing"]);
  assert.equal(after[0].content, before[0].content);
  assert.deepEqual(after[0].tags, before[0].tags);
  assert.equal((after[0].metadata as { custom?: string }).custom, "keep-me");
});

test("LocalMemoryManager applyMaintenance treats omitted arrays as empty and avoids rewriting on no-op", async () => {
  const cwd = await workspace();
  const path = join(cwd, ".memory.jsonl");
  const manager = new LocalMemoryManager(new FileMemoryStore(path));

  const result = await manager.applyMaintenance({});

  assert.equal(result.appliedConflictCount, 0);
  assert.equal(result.appliedFreshnessCount, 0);
  assert.deepEqual(result.records, []);
  await assert.rejects(access(path));
});

test("LocalMemoryManager applyMaintenance falls back to current time when request.now is invalid", async () => {
  const cwd = await workspace();
  const manager = new LocalMemoryManager(new FileMemoryStore(join(cwd, ".memory.jsonl")));
  await manager.write(projectRecord({
    id: "mem-invalid-now",
    freshness: "fresh",
    metadata: {
      lastSeenAt: "2026-05-01T00:00:00.000Z",
    },
  }));

  const report = new MemoryMaintenanceAnalyzer().analyze(await manager.list(), { now: "2026-06-06T00:00:00.000Z" });
  const result = await manager.applyMaintenance({
    now: "not-a-date",
    freshnessSuggestions: report.freshnessSuggestions,
  });

  assert.match(result.appliedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.records[0].freshness, "aging");
});

test("LocalMemorySurface inspect defaults to list and returns records without maintenance", async () => {
  const calls = { list: 0, retrieve: 0, apply: 0 };
  const manager: MemoryManager = {
    async write(record) {
      return record;
    },
    async retrieve() {
      calls.retrieve += 1;
      return [];
    },
    async list() {
      calls.list += 1;
      return [projectRecord({ id: "mem-surface-list" })];
    },
    async applyMaintenance() {
      calls.apply += 1;
      return emptyApplyResult([]);
    },
  };

  const result = await new LocalMemorySurface(manager).inspect();

  assert.deepEqual(result.records.map((record) => record.id), ["mem-surface-list"]);
  assert.equal(result.maintenance, undefined);
  assert.equal(calls.list, 1);
  assert.equal(calls.retrieve, 0);
  assert.equal(calls.apply, 0);
});

test("LocalMemorySurface inspect with query routes to retrieve and forwards maintenance options to analyzer", async () => {
  const calls = { list: 0, retrieve: 0, apply: 0 };
  const query: MemoryQuery = { scope: "project", text: "pnpm" };
  const records = [projectRecord({ id: "mem-surface-query" })];
  const analyzerCalls: Array<{ records: MemoryRecord[]; options: MemoryMaintenanceOptions | undefined }> = [];
  const analyzer = {
    analyze(input: MemoryRecord[], options?: MemoryMaintenanceOptions): MemoryMaintenanceReport {
      analyzerCalls.push({ records: input, options });
      return {
        checkedAt: "2026-06-06T00:00:00.000Z",
        issues: [],
        freshnessSuggestions: [],
      };
    },
  } as MemoryMaintenanceAnalyzer;
  const manager: MemoryManager = {
    async write(record) {
      return record;
    },
    async retrieve(receivedQuery) {
      calls.retrieve += 1;
      assert.deepEqual(receivedQuery, query);
      return records;
    },
    async list() {
      calls.list += 1;
      return [];
    },
    async applyMaintenance() {
      calls.apply += 1;
      return emptyApplyResult([]);
    },
  };

  const result = await new LocalMemorySurface(manager, analyzer).inspect({
    query,
    includeMaintenance: true,
    maintenanceOptions: { now: "2026-06-06T00:00:00.000Z", agingAfterDays: 12, staleAfterDays: 34 },
  });

  assert.deepEqual(result.records.map((record) => record.id), ["mem-surface-query"]);
  assert.deepEqual(result.maintenance, {
    checkedAt: "2026-06-06T00:00:00.000Z",
    issues: [],
    freshnessSuggestions: [],
  });
  assert.equal(calls.list, 0);
  assert.equal(calls.retrieve, 1);
  assert.equal(calls.apply, 0);
  assert.equal(analyzerCalls.length, 1);
  assert.deepEqual(analyzerCalls[0].records.map((record) => record.id), ["mem-surface-query"]);
  assert.deepEqual(analyzerCalls[0].options, { now: "2026-06-06T00:00:00.000Z", agingAfterDays: 12, staleAfterDays: 34 });
});

test("LocalMemorySurface inspect with maintenance returns an empty report for an empty result set", async () => {
  const manager: MemoryManager = {
    async write(record) {
      return record;
    },
    async retrieve() {
      return [];
    },
    async list() {
      return [];
    },
    async applyMaintenance() {
      return emptyApplyResult([]);
    },
  };

  const result = await new LocalMemorySurface(manager).inspect({
    query: { scope: "project" },
    includeMaintenance: true,
    maintenanceOptions: { now: "2026-06-06T00:00:00.000Z" },
  });

  assert.deepEqual(result.records, []);
  assert.deepEqual(result.maintenance, {
    checkedAt: "2026-06-06T00:00:00.000Z",
    issues: [],
    freshnessSuggestions: [],
  });
});

test("LocalMemorySurface analyze always uses full list and forwards options to analyzer", async () => {
  const calls = { list: 0, retrieve: 0, apply: 0 };
  const records = [projectRecord({ id: "mem-surface-analyze" })];
  const analyzerCalls: Array<{ records: MemoryRecord[]; options: MemoryMaintenanceOptions | undefined }> = [];
  const analyzer = {
    analyze(input: MemoryRecord[], options?: MemoryMaintenanceOptions): MemoryMaintenanceReport {
      analyzerCalls.push({ records: input, options });
      return {
        checkedAt: "2026-06-06T00:00:00.000Z",
        issues: [],
        freshnessSuggestions: [],
      };
    },
  } as MemoryMaintenanceAnalyzer;
  const manager: MemoryManager = {
    async write(record) {
      return record;
    },
    async retrieve() {
      calls.retrieve += 1;
      return [];
    },
    async list() {
      calls.list += 1;
      return records;
    },
    async applyMaintenance() {
      calls.apply += 1;
      return emptyApplyResult([]);
    },
  };

  const report = await new LocalMemorySurface(manager, analyzer).analyze({
    now: "2026-06-06T00:00:00.000Z",
    agingAfterDays: 40,
  });

  assert.deepEqual(report, {
    checkedAt: "2026-06-06T00:00:00.000Z",
    issues: [],
    freshnessSuggestions: [],
  });
  assert.equal(calls.list, 1);
  assert.equal(calls.retrieve, 0);
  assert.equal(calls.apply, 0);
  assert.deepEqual(analyzerCalls[0].records.map((record) => record.id), ["mem-surface-analyze"]);
  assert.deepEqual(analyzerCalls[0].options, { now: "2026-06-06T00:00:00.000Z", agingAfterDays: 40 });
});

test("LocalMemorySurface apply only forwards the request to manager.applyMaintenance", async () => {
  const captured: { request?: MemoryMaintenanceApplyRequest; applyCalls: number; listCalls: number; retrieveCalls: number } = {
    applyCalls: 0,
    listCalls: 0,
    retrieveCalls: 0,
  };
  const expectedResult = emptyApplyResult([projectRecord({ id: "mem-surface-apply" })]);
  const manager: MemoryManager = {
    async write(record) {
      return record;
    },
    async retrieve() {
      captured.retrieveCalls += 1;
      return [];
    },
    async list() {
      captured.listCalls += 1;
      return [];
    },
    async applyMaintenance(request) {
      captured.applyCalls += 1;
      captured.request = request;
      return expectedResult;
    },
  };

  const request: MemoryMaintenanceApplyRequest = {
    now: "2026-06-06T00:00:00.000Z",
    issues: [{ type: "conflict", recordId: "a", otherRecordId: "b", reason: "explicit_conflicts_with" }],
  };
  const result = await new LocalMemorySurface(manager).apply(request);

  assert.equal(captured.applyCalls, 1);
  assert.equal(captured.listCalls, 0);
  assert.equal(captured.retrieveCalls, 0);
  assert.deepEqual(captured.request, request);
  assert.deepEqual(result, expectedResult);
});

test("LocalMemorySurface reuses the same default analyzer instance within one surface instance", async () => {
  const manager: MemoryManager = {
    async write(record) {
      return record;
    },
    async retrieve() {
      return [];
    },
    async list() {
      return [projectRecord({ id: "mem-default-analyzer" })];
    },
    async applyMaintenance() {
      return emptyApplyResult([]);
    },
  };

  const surface = new LocalMemorySurface(manager);
  const firstAnalyzer = (surface as unknown as { analyzer: unknown }).analyzer;
  await surface.analyze({ now: "2026-06-06T00:00:00.000Z" });
  const secondAnalyzer = (surface as unknown as { analyzer: unknown }).analyzer;

  assert.equal(firstAnalyzer, secondAnalyzer);
});

function emptyApplyResult(records: MemoryRecord[]): MaintenanceApplyResult {
  return {
    appliedAt: "2026-06-06T00:00:00.000Z",
    appliedConflictCount: 0,
    appliedFreshnessCount: 0,
    records,
  };
}
