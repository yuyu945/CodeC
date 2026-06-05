import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  classifyMemoryScope,
  FileMemoryStore,
  JsonlEventStore,
  LocalMemoryManager,
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
