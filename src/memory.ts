import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { redactSecretsInString } from "./shared.ts";
import type { MemoryManager, MemoryQuery, MemoryRecord, MemoryScope } from "./types.ts";

export class FileMemoryStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async write(record: MemoryRecord): Promise<MemoryRecord> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  async list(): Promise<MemoryRecord[]> {
    try {
      const text = await readFile(this.filePath, "utf8");
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as MemoryRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async retrieve(query: MemoryQuery): Promise<MemoryRecord[]> {
    const records = await this.list();
    return records.filter((record) => {
      if (query.scope && record.scope !== query.scope) return false;
      if (query.text && !record.content.toLowerCase().includes(query.text.toLowerCase())) return false;
      if (query.tags && query.tags.some((tag) => !(record.tags ?? []).includes(tag))) return false;
      if (query.sourceEventIds && query.sourceEventIds.some((sourceEventId) => !record.sourceEventIds.includes(sourceEventId))) return false;
      return true;
    });
  }
}

export class LocalMemoryManager implements MemoryManager {
  private readonly store: FileMemoryStore;

  constructor(store: FileMemoryStore) {
    this.store = store;
  }

  async write(record: MemoryRecord): Promise<MemoryRecord> {
    validateRecord(record);
    const redacted = redactSecretsInString(record.content);
    const normalized: MemoryRecord = {
      ...record,
      metadata: {
        ...record.metadata,
        redacted: redacted.redacted,
      },
      content: redacted.text,
    };
    return await this.store.write(normalized);
  }

  async retrieve(query: MemoryQuery): Promise<MemoryRecord[]> {
    return await this.store.retrieve(query);
  }

  async list(): Promise<MemoryRecord[]> {
    return await this.store.list();
  }
}

export function classifyMemoryScope(content: string): MemoryScope {
  const normalized = content.toLowerCase();
  if (normalized.includes("http://") || normalized.includes("https://") || normalized.includes("issue") || normalized.includes("pr ") || normalized.includes("pull request") || normalized.includes("runbook") || normalized.includes("entry point") || normalized.includes(".ts") || normalized.includes(".py")) {
    return "reference";
  }
  return "project";
}

function validateRecord(record: MemoryRecord): void {
  if (record.scope !== "project" && record.scope !== "reference") {
    throw new Error("invalid_memory_scope");
  }
  if (record.loadPolicy !== "project_entry" && record.loadPolicy !== "on_demand" && record.loadPolicy !== "always" && record.loadPolicy !== "search_only") {
    throw new Error("invalid_memory_load_policy");
  }
  if (!record.sourceEventIds.length) {
    throw new Error("memory_record_requires_provenance");
  }
  if (!record.id) {
    record.id = randomUUID();
  }
}
