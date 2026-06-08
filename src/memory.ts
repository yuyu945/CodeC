import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { redactSecretsInString } from "./shared.ts";
import type {
  MemoryMaintenanceApplyRequest,
  MemoryMaintenanceApplyResult,
  MemoryFreshness,
  MemoryInspectRequest,
  MemoryInspectResult,
  MemoryMaintenanceIssue,
  MemoryMaintenanceOptions,
  MemoryMaintenanceReport,
  MemoryCliCommand,
  MemoryCliExecutionResult,
  MemoryTuiCommand,
  MemoryTuiResult,
  MemoryTuiState,
  MemoryManager,
  MemoryQuery,
  MemoryRecord,
  MemoryScope,
  MemorySurface,
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

  async replaceAll(records: MemoryRecord[]): Promise<MemoryRecord[]> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const content = records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    await writeFile(this.filePath, content, "utf8");
    return records;
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

  async applyMaintenance(request: MemoryMaintenanceApplyRequest): Promise<MemoryMaintenanceApplyResult> {
    const now = resolveNow(request.now);
    const issues = request.issues ?? [];
    const freshnessSuggestions = request.freshnessSuggestions ?? [];
    const currentRecords = await this.store.list();
    const nextRecords = currentRecords.map(cloneRecord);
    const recordIndexes = new Map(nextRecords.map((record, index) => [record.id, index] as const));

    let appliedFreshnessCount = 0;
    for (const suggestion of freshnessSuggestions) {
      const index = recordIndexes.get(suggestion.recordId);
      if (index === undefined) continue;
      const record = nextRecords[index];
      if (record.freshness !== suggestion.currentFreshness) continue;
      if (record.freshness === suggestion.suggestedFreshness) continue;
      record.freshness = suggestion.suggestedFreshness;
      appliedFreshnessCount += 1;
    }

    let appliedConflictCount = 0;
    for (const issue of issues) {
      if (applyConflictIssue(nextRecords, recordIndexes, issue)) {
        appliedConflictCount += 1;
      }
    }

    if (appliedConflictCount === 0 && appliedFreshnessCount === 0) {
      return {
        appliedAt: now.toISOString(),
        appliedConflictCount,
        appliedFreshnessCount,
        records: currentRecords,
      };
    }

    await this.store.replaceAll(nextRecords);
    return {
      appliedAt: now.toISOString(),
      appliedConflictCount,
      appliedFreshnessCount,
      records: nextRecords,
    };
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

export class LocalMemorySurface implements MemorySurface {
  private readonly manager: MemoryManager;
  private readonly analyzer: MemoryMaintenanceAnalyzer;

  constructor(manager: MemoryManager, analyzer?: MemoryMaintenanceAnalyzer) {
    this.manager = manager;
    this.analyzer = analyzer ?? new MemoryMaintenanceAnalyzer();
  }

  async inspect(request: MemoryInspectRequest = {}): Promise<MemoryInspectResult> {
    const records = request.query
      ? await this.manager.retrieve(request.query)
      : await this.manager.list();
    if (request.includeMaintenance !== true) {
      return { records };
    }
    return {
      records,
      maintenance: this.analyzer.analyze(records, request.maintenanceOptions),
    };
  }

  async analyze(options: MemoryMaintenanceOptions = {}): Promise<MemoryMaintenanceReport> {
    return this.analyzer.analyze(await this.manager.list(), options);
  }

  async apply(request: MemoryMaintenanceApplyRequest): Promise<MemoryMaintenanceApplyResult> {
    return await this.manager.applyMaintenance(request);
  }
}

export class LocalMemoryTuiController {
  private readonly surface: MemorySurface;
  private state: MemoryTuiState = {
    records: [],
    maintenance: {
      checkedAt: new Date(0).toISOString(),
      issues: [],
      freshnessSuggestions: [],
    },
    visibleIssues: [],
    visibleFreshnessSuggestions: [],
    selectedIssueKeys: [],
    selectedFreshnessRecordIds: [],
    scopeFilter: undefined,
    textFilter: undefined,
    statusMessage: "ready",
  };

  constructor(surface: MemorySurface) {
    this.surface = surface;
  }

  getState(): MemoryTuiState {
    return cloneTuiState(this.state);
  }

  async load(): Promise<MemoryTuiState> {
    return await this.refresh("ready");
  }

  async setScopeFilter(scope?: MemoryScope): Promise<MemoryTuiState> {
    this.state.scopeFilter = scope;
    return await this.refresh("ready");
  }

  async setTextFilter(text?: string): Promise<MemoryTuiState> {
    this.state.textFilter = text?.trim() ? text.trim() : undefined;
    return await this.refresh("ready");
  }

  toggleIssue(index: number): MemoryTuiState {
    const issue = this.state.visibleIssues[index];
    if (!issue) throw new Error("memory_tui_invalid_issue_index");
    const key = issueKey(issue);
    const selected = new Set(this.state.selectedIssueKeys);
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    this.state.selectedIssueKeys = [...selected];
    this.state.statusMessage = "selection_updated";
    return this.getState();
  }

  toggleFreshness(index: number): MemoryTuiState {
    const suggestion = this.state.visibleFreshnessSuggestions[index];
    if (!suggestion) throw new Error("memory_tui_invalid_freshness_index");
    const selected = new Set(this.state.selectedFreshnessRecordIds);
    if (selected.has(suggestion.recordId)) selected.delete(suggestion.recordId);
    else selected.add(suggestion.recordId);
    this.state.selectedFreshnessRecordIds = [...selected];
    this.state.statusMessage = "selection_updated";
    return this.getState();
  }

  async applySelected(): Promise<MemoryTuiResult> {
    const selectedIssues = this.state.visibleIssues.filter((issue) => this.state.selectedIssueKeys.includes(issueKey(issue)));
    const selectedFreshnessSuggestions = this.state.visibleFreshnessSuggestions.filter((item) => this.state.selectedFreshnessRecordIds.includes(item.recordId));
    if (selectedIssues.length === 0 && selectedFreshnessSuggestions.length === 0) {
      this.state.statusMessage = "nothing_selected";
      return { finalState: this.getState() };
    }

    const applied = await this.surface.apply({
      issues: selectedIssues,
      freshnessSuggestions: selectedFreshnessSuggestions,
    });
    this.state.selectedIssueKeys = [];
    this.state.selectedFreshnessRecordIds = [];
    const finalState = await this.refresh(`applied conflicts=${applied.appliedConflictCount} freshness=${applied.appliedFreshnessCount}`);
    return { applied, finalState };
  }

  async analyze(): Promise<MemoryTuiState> {
    return await this.refresh("analysis_refreshed");
  }

  private async refresh(statusMessage: string): Promise<MemoryTuiState> {
    const inspect = await this.surface.inspect({
      query: currentQuery(this.state.scopeFilter, this.state.textFilter),
      includeMaintenance: false,
    });
    const maintenance = await this.surface.analyze();
    const visibleIssues = deriveVisibleIssues(inspect.records, maintenance.issues);
    const visibleFreshnessSuggestions = deriveVisibleFreshnessSuggestions(inspect.records, maintenance.freshnessSuggestions);
    const visibleIssueKeys = new Set(visibleIssues.map(issueKey));
    const visibleFreshnessIds = new Set(visibleFreshnessSuggestions.map((item) => item.recordId));

    this.state = {
      ...this.state,
      records: inspect.records,
      maintenance,
      visibleIssues,
      visibleFreshnessSuggestions,
      selectedIssueKeys: this.state.selectedIssueKeys.filter((key) => visibleIssueKeys.has(key)),
      selectedFreshnessRecordIds: this.state.selectedFreshnessRecordIds.filter((id) => visibleFreshnessIds.has(id)),
      statusMessage,
    };
    return this.getState();
  }
}

export async function runMemoryCli(command: MemoryCliCommand): Promise<MemoryInspectResult | MemoryMaintenanceReport | MemoryMaintenanceApplyResult> {
  const storePath = command.storePath ? resolve(command.cwd, command.storePath) : join(command.cwd, ".memory.jsonl");
  const surface = new LocalMemorySurface(new LocalMemoryManager(new FileMemoryStore(storePath)));

  if (command.type === "inspect") {
    return await surface.inspect({
      query: command.query,
      includeMaintenance: command.includeMaintenance,
      maintenanceOptions: command.maintenanceOptions,
    });
  }
  if (command.type === "analyze") {
    return await surface.analyze(command.maintenanceOptions);
  }
  if (command.type === "apply") {
    if (!command.applyRequest) {
      throw new Error("memory_cli_apply_requires_request");
    }
    return await surface.apply(command.applyRequest);
  }
  throw new Error("unsupported_memory_cli_command");
}

export function parseMemoryCliArgv(argv: string[]): MemoryCliCommand {
  const [commandName, ...rest] = argv;
  if (!commandName) throw new Error("memory_cli_requires_command");
  if (commandName !== "inspect" && commandName !== "analyze" && commandName !== "apply") {
    throw new Error("unsupported_memory_cli_command");
  }

  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      throw new Error("memory_cli_invalid_flag");
    }
    if (token === "--include-maintenance") {
      flags.add(token);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("memory_cli_missing_flag_value");
    }
    const existing = values.get(token) ?? [];
    existing.push(value);
    values.set(token, existing);
    index += 1;
  }

  const cwd = singleRequired(values, "--cwd", "memory_cli_requires_cwd");
  const storePath = singleOptional(values, "--store-path");

  if (commandName === "inspect") {
    const tags = values.get("--tag");
    return {
      type: "inspect",
      cwd,
      storePath,
      query: buildQuery({
        scope: singleOptional(values, "--scope"),
        text: singleOptional(values, "--text"),
        tags,
      }),
      includeMaintenance: flags.has("--include-maintenance") ? true : undefined,
      maintenanceOptions: buildMaintenanceOptions(values),
    };
  }

  if (commandName === "analyze") {
    return {
      type: "analyze",
      cwd,
      storePath,
      maintenanceOptions: buildMaintenanceOptions(values),
    };
  }

  const requestFile = singleRequired(values, "--request-file", "memory_cli_apply_requires_request_file");
  return {
    type: "apply",
    cwd,
    storePath,
    requestFile,
  } as unknown as MemoryCliCommand;
}

export async function executeMemoryCli(argv: string[]): Promise<MemoryCliExecutionResult> {
  try {
    const command = parseMemoryCliArgv(argv);
    const resolvedCommand = command.type === "apply"
      ? {
          ...command,
          applyRequest: await readApplyRequest(command.cwd, (command as { requestFile: string }).requestFile),
        }
      : command;
    const result = await runMemoryCli(resolvedCommand as MemoryCliCommand);
    return {
      exitCode: 0,
      stdout: `${JSON.stringify(result, null, 2)}\n`,
      stderr: "",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${normalizeCliError(error)}\n`,
    };
  }
}

export function parseMemoryTuiCommand(line: string): MemoryTuiCommand {
  const trimmed = line.trim();
  if (!trimmed) throw new Error("memory_tui_empty_command");
  const parts = trimmed.split(/\s+/);
  const [command, subcommand, ...rest] = parts;

  if (command === "list") return { type: "list" };
  if (command === "analyze") return { type: "analyze" };
  if (command === "apply") return { type: "apply" };
  if (command === "quit") return { type: "quit" };
  if (command === "filter" && subcommand === "scope") {
    if (rest.length === 0) throw new Error("memory_tui_missing_scope_filter");
    if (rest[0] === "all") return { type: "filter_scope" };
    if (rest[0] === "project" || rest[0] === "reference") {
      return { type: "filter_scope", scope: rest[0] };
    }
    throw new Error("memory_tui_invalid_scope_filter");
  }
  if (command === "filter" && subcommand === "text") {
    if (rest.length === 0) throw new Error("memory_tui_missing_text_filter");
    if (rest[0] === "clear") return { type: "filter_text" };
    return { type: "filter_text", text: rest.join(" ") };
  }
  if (command === "select" && subcommand === "issue") {
    if (rest.length === 0) throw new Error("memory_tui_missing_issue_index");
    return { type: "select_issue", index: parseTuiIndex(rest[0]) };
  }
  if (command === "select" && subcommand === "freshness") {
    if (rest.length === 0) throw new Error("memory_tui_missing_freshness_index");
    return { type: "select_freshness", index: parseTuiIndex(rest[0]) };
  }

  throw new Error("memory_tui_unknown_command");
}

export async function executeMemoryTuiCommand(
  line: string,
  controller: LocalMemoryTuiController,
): Promise<{ done: boolean; output: string; result?: MemoryTuiResult }> {
  try {
    const command = parseMemoryTuiCommand(line);
    if (command.type === "quit") {
      return { done: true, output: "Goodbye.\n" };
    }
    if (command.type === "list") {
      return { done: false, output: renderMemoryTuiState(controller.getState()) };
    }
    if (command.type === "analyze") {
      const state = await controller.analyze();
      return { done: false, output: renderMemoryTuiState(state) };
    }
    if (command.type === "filter_scope") {
      const state = await controller.setScopeFilter(command.scope);
      return { done: false, output: renderMemoryTuiState(state) };
    }
    if (command.type === "filter_text") {
      const state = await controller.setTextFilter(command.text);
      return { done: false, output: renderMemoryTuiState(state) };
    }
    if (command.type === "select_issue") {
      const state = controller.toggleIssue(command.index);
      return { done: false, output: renderMemoryTuiState(state) };
    }
    if (command.type === "select_freshness") {
      const state = controller.toggleFreshness(command.index);
      return { done: false, output: renderMemoryTuiState(state) };
    }
    const result = await controller.applySelected();
    return { done: false, output: renderMemoryTuiState(result.finalState), result };
  } catch (error) {
    return {
      done: false,
      output: `${normalizeTuiError(error)}\n`,
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

function cloneRecord(record: MemoryRecord): MemoryRecord {
  return {
    ...record,
    tags: record.tags ? [...record.tags] : undefined,
    conflictsWith: record.conflictsWith ? [...record.conflictsWith] : undefined,
    metadata: record.metadata ? { ...record.metadata } : undefined,
  };
}

function applyConflictIssue(
  records: MemoryRecord[],
  recordIndexes: Map<string, number>,
  issue: MemoryMaintenanceIssue,
): boolean {
  const leftIndex = recordIndexes.get(issue.recordId);
  const rightIndex = recordIndexes.get(issue.otherRecordId);
  let changed = false;

  if (leftIndex !== undefined) {
    changed = appendConflict(records[leftIndex], issue.otherRecordId) || changed;
  }
  if (rightIndex !== undefined) {
    changed = appendConflict(records[rightIndex], issue.recordId) || changed;
  }

  return changed;
}

function appendConflict(record: MemoryRecord, otherRecordId: string): boolean {
  const conflictsWith = record.conflictsWith ? [...record.conflictsWith] : [];
  if (conflictsWith.includes(otherRecordId)) return false;
  conflictsWith.push(otherRecordId);
  record.conflictsWith = conflictsWith;
  return true;
}

function singleRequired(values: Map<string, string[]>, flag: string, errorCode: string): string {
  const value = singleOptional(values, flag);
  if (!value) throw new Error(errorCode);
  return value;
}

function singleOptional(values: Map<string, string[]>, flag: string): string | undefined {
  const entries = values.get(flag);
  return entries?.at(-1);
}

function buildQuery(input: { scope?: string; text?: string; tags?: string[] }): MemoryQuery | undefined {
  const query: MemoryQuery = {};
  if (input.scope) query.scope = input.scope as MemoryQuery["scope"];
  if (input.text) query.text = input.text;
  if (input.tags && input.tags.length > 0) query.tags = input.tags;
  return Object.keys(query).length > 0 ? query : undefined;
}

function buildMaintenanceOptions(values: Map<string, string[]>): MemoryMaintenanceOptions | undefined {
  const options: MemoryMaintenanceOptions = {};
  const now = singleOptional(values, "--now");
  if (now) options.now = now;
  const agingAfterDays = singleOptional(values, "--aging-after-days");
  if (agingAfterDays !== undefined) options.agingAfterDays = parseNumberFlag(agingAfterDays);
  const staleAfterDays = singleOptional(values, "--stale-after-days");
  if (staleAfterDays !== undefined) options.staleAfterDays = parseNumberFlag(staleAfterDays);
  return Object.keys(options).length > 0 ? options : undefined;
}

function parseNumberFlag(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("memory_cli_invalid_number");
  return parsed;
}

async function readApplyRequest(cwd: string, requestFile: string): Promise<MemoryMaintenanceApplyRequest> {
  const absolutePath = resolve(cwd, requestFile);
  let text: string;
  try {
    text = await readFile(absolutePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("memory_cli_request_file_not_found");
    }
    throw error;
  }
  try {
    return JSON.parse(text) as MemoryMaintenanceApplyRequest;
  } catch {
    throw new Error("memory_cli_invalid_request_file_json");
  }
}

function normalizeCliError(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return "memory_cli_execution_failed";
}

function currentQuery(scopeFilter: MemoryScope | undefined, textFilter: string | undefined): MemoryQuery | undefined {
  const query: MemoryQuery = {};
  if (scopeFilter) query.scope = scopeFilter;
  if (textFilter) query.text = textFilter;
  return Object.keys(query).length > 0 ? query : undefined;
}

function deriveVisibleIssues(records: MemoryRecord[], issues: MemoryMaintenanceIssue[]): MemoryMaintenanceIssue[] {
  const visibleRecordIds = new Set(records.map((record) => record.id));
  return issues.filter((issue) => visibleRecordIds.has(issue.recordId) || visibleRecordIds.has(issue.otherRecordId));
}

function deriveVisibleFreshnessSuggestions(
  records: MemoryRecord[],
  suggestions: MemoryMaintenanceReport["freshnessSuggestions"],
) {
  const visibleRecordIds = new Set(records.map((record) => record.id));
  return suggestions.filter((item) => visibleRecordIds.has(item.recordId));
}

function cloneTuiState(state: MemoryTuiState): MemoryTuiState {
  return {
    ...state,
    records: state.records.map(cloneRecord),
    maintenance: {
      checkedAt: state.maintenance.checkedAt,
      issues: state.maintenance.issues.map((issue) => ({ ...issue })),
      freshnessSuggestions: state.maintenance.freshnessSuggestions.map((item) => ({ ...item })),
    },
    visibleIssues: state.visibleIssues.map((issue) => ({ ...issue })),
    visibleFreshnessSuggestions: state.visibleFreshnessSuggestions.map((item) => ({ ...item })),
    selectedIssueKeys: [...state.selectedIssueKeys],
    selectedFreshnessRecordIds: [...state.selectedFreshnessRecordIds],
  };
}

function issueKey(issue: MemoryMaintenanceIssue): string {
  return [issue.recordId, issue.otherRecordId].sort().join("::");
}

function parseTuiIndex(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error("memory_tui_invalid_index");
  return parsed;
}

function renderMemoryTuiState(state: MemoryTuiState): string {
  const lines = [
    `Status: ${state.statusMessage}`,
    `Filters: scope=${state.scopeFilter ?? "all"} text=${state.textFilter ?? "-"}`,
    `Records (${state.records.length})`,
    ...state.records.map((record, index) => `[${index}] ${record.id} ${record.scope} ${record.freshness} ${record.content}`),
    `Issues (${state.visibleIssues.length})`,
    ...state.visibleIssues.map((issue, index) => `[${index}] ${state.selectedIssueKeys.includes(issueKey(issue)) ? "*" : " "} ${issue.recordId} <-> ${issue.otherRecordId} ${issue.reason}`),
    `Freshness (${state.visibleFreshnessSuggestions.length})`,
    ...state.visibleFreshnessSuggestions.map((item, index) => `[${index}] ${state.selectedFreshnessRecordIds.includes(item.recordId) ? "*" : " "} ${item.recordId} ${item.currentFreshness} -> ${item.suggestedFreshness} ${item.reason}`),
  ];
  return `${lines.join("\n")}\n`;
}

function normalizeTuiError(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return "memory_tui_execution_failed";
}
