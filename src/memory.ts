import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { redactSecretsInString } from "./shared.ts";
import type {
  MemoryFreshness,
  MemoryMaintenanceIssue,
  MemoryMaintenanceOptions,
  MemoryMaintenanceReport,
  MemoryManager,
  MemoryQuery,
  MemoryRecord,
  MemoryScope,
} from "./types.ts";

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

export class MemoryMaintenanceAnalyzer {
  analyze(records: MemoryRecord[], options: MemoryMaintenanceOptions = {}): MemoryMaintenanceReport {
    const now = resolveNow(options.now);
    const agingAfterDays = normalizeThreshold(options.agingAfterDays, 30);
    const staleAfterDays = normalizeThreshold(options.staleAfterDays, 90);
    const explicitPairs = new Set<string>();
    const issues: MemoryMaintenanceIssue[] = [];
    const freshnessSuggestions = records.flatMap((record) => {
      return maybeSuggestFreshness(record, now, agingAfterDays, staleAfterDays);
    });

    for (const record of records) {
      for (const targetId of record.conflictsWith ?? []) {
        const key = pairKey(record.id, targetId);
        if (explicitPairs.has(key)) continue;
        explicitPairs.add(key);
        issues.push({
          type: "conflict",
          recordId: record.id,
          otherRecordId: targetId,
          reason: "explicit_conflicts_with",
        });
      }
    }

    for (let index = 0; index < records.length; index += 1) {
      for (let otherIndex = index + 1; otherIndex < records.length; otherIndex += 1) {
        const left = records[index];
        const right = records[otherIndex];
        const key = pairKey(left.id, right.id);
        if (explicitPairs.has(key)) continue;
        if (!hasHeuristicConflict(left, right)) continue;
        issues.push({
          type: "conflict",
          recordId: left.id,
          otherRecordId: right.id,
          reason: "heuristic_signal_phrase_conflict",
        });
      }
    }

    return {
      checkedAt: now.toISOString(),
      issues,
      freshnessSuggestions,
    };
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

const SIGNAL_PHRASES = ["do not", "don't", "no longer", "instead", "replace", "deprecated"];
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

function maybeSuggestFreshness(
  record: MemoryRecord,
  now: Date,
  agingAfterDays: number,
  staleAfterDays: number,
) {
  const expiredAt = parseTimestamp(record.expiresAt);
  if (expiredAt && expiredAt.getTime() < now.getTime()) {
    return buildFreshnessSuggestion(record, "stale", "record_expired");
  }

  const lastSeenAt = readMetadataTimestamp(record.metadata, "lastSeenAt");
  const createdAt = readMetadataTimestamp(record.metadata, "createdAt");
  const referenceTime = lastSeenAt ?? createdAt;
  if (!referenceTime) return [];

  const ageDays = Math.floor((now.getTime() - referenceTime.getTime()) / MILLIS_PER_DAY);
  if (ageDays >= staleAfterDays) {
    return buildFreshnessSuggestion(record, "stale", "last_seen_threshold_reached");
  }
  if (ageDays >= agingAfterDays) {
    return buildFreshnessSuggestion(record, "aging", "last_seen_threshold_reached");
  }
  return [];
}

function buildFreshnessSuggestion(
  record: MemoryRecord,
  suggestedFreshness: MemoryFreshness,
  reason: string,
) {
  if (suggestedFreshness === record.freshness) return [];
  return [{
    recordId: record.id,
    currentFreshness: record.freshness,
    suggestedFreshness,
    reason,
  }];
}

function resolveNow(value: Date | string | undefined): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value.getTime());
  if (typeof value === "string") {
    const parsed = parseTimestamp(value);
    if (parsed) return parsed;
  }
  return new Date();
}

function normalizeThreshold(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join("::");
}

function hasHeuristicConflict(left: MemoryRecord, right: MemoryRecord): boolean {
  if (left.scope !== right.scope) return false;
  const leftTags = new Set(left.tags ?? []);
  const rightTags = right.tags ?? [];
  if (!rightTags.some((tag) => leftTags.has(tag))) return false;

  const leftContent = normalizeContent(left.content);
  const rightContent = normalizeContent(right.content);
  return contentImpliesConflict(leftContent, rightContent) || contentImpliesConflict(rightContent, leftContent);
}

function contentImpliesConflict(source: string, target: string): boolean {
  const signal = SIGNAL_PHRASES.find((phrase) => source.includes(phrase));
  if (!signal) return false;
  const stripped = normalizeContent(source.replaceAll(signal, " "));
  return stripped.includes(target);
}

function normalizeContent(content: string): string {
  return content.toLowerCase().replace(/[^a-z0-9. ]+/g, " ").replace(/\s+/g, " ").trim();
}

function readMetadataTimestamp(metadata: Record<string, unknown> | undefined, key: string): Date | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  return parseTimestamp(typeof metadata[key] === "string" ? String(metadata[key]) : undefined);
}

function parseTimestamp(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return undefined;
  return parsed;
}
