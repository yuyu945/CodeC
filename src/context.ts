import crypto from "node:crypto";

import { InstructionResolver } from "./instructions.ts";
import type {
  CompactionTier,
  ContextBundle,
  ContextFragment,
  HistoricalToolResultPlaceholder,
  InstructionBundle,
  MemoryContextPayload,
  MemoryContextSelection,
  RedactedMemoryRecord,
  ToolCall,
  ToolObservation,
  ToolResult,
  TurnRequest,
} from "./types.ts";
import { capString, hashJson, redactSecretsInString, redactStructuredValue, summarizeValue } from "./shared.ts";
import { toolDefinitionsForUserMessage } from "./tools.ts";

export class ContextBuilder {
  private readonly observations = new Map<string, ToolObservation[]>();
  private readonly touchedPaths = new Map<string, Set<string>>();
  private readonly instructionResolver?: InstructionResolver;

  constructor(options: { instructionResolver?: InstructionResolver } = {}) {
    this.instructionResolver = options.instructionResolver;
  }

  async build(request: TurnRequest): Promise<ContextBundle> {
    const observations = this.observations.get(request.sessionId) ?? [];
    const memoryContext = await buildMemoryContext(request.memorySelections ?? []);
    const instructionBundle = this.instructionResolver
      ? await this.instructionResolver.resolve({
          workspaceRoot: request.workspace.root ?? request.workspace.cwd,
          cwd: request.workspace.cwd,
          touchedPaths: [...(this.touchedPaths.get(request.sessionId) ?? new Set<string>())],
        })
      : emptyInstructionBundle();
    const fragments: ContextFragment[] = [
      createFragment("system", "MVP-0 single-agent runtime. Use only declared tools. Tool results are typed observations.", 100, true, false, "system", "instructions"),
      ...instructionBundle.fragments.map((fragment) =>
        createFragment("system", fragment.normalizedText, fragment.priority, true, false, "system", "instructions"),
      ),
      createFragment(
        "system",
        [
          "no automatic memory persistence",
          "memory retrieval only when explicitly selected by caller",
          "no non-memory retrieval surface",
          "no multi-agent",
          "no IDE/TUI/API surface",
        ],
        95,
        true,
        false,
        "system",
        "workspace",
      ),
      createFragment("system", { workspace: request.workspace.cwd }, 40, false, true, "system", "workspace"),
      ...(memoryContext.records.length > 0
        ? [createFragment("system", memoryContext, 70, false, true, "system", "memory")]
        : []),
      createFragment("user", request.userMessage, 90, true, false, "user", "task"),
      ...observations.map((observation) => createFragment("tool", observation, 50, false, true, "tool", "observation")),
    ];
    return {
      sessionId: request.sessionId,
      messages: fragmentsToMessages(fragments),
      fragments,
      toolDefinitions: toolDefinitionsForUserMessage(request.userMessage),
      instructions: instructionBundle,
      budgetReport: {
        estimatedUnits: 0,
        limit: 0,
        threshold: 0,
        mustCompact: false,
        tier: "none",
      },
    };
  }

  injectToolResult(context: ContextBundle, call: ToolCall, result: ToolResult): ContextBundle {
    const output = redactStructuredValue(result.output);
    const error = result.error ? redactSecretsInString(capString(result.error)) : undefined;
    const observation: ToolObservation = {
      type: "tool_result",
      callId: call.id,
      toolName: call.name,
      status: result.ok ? "ok" : "error",
      output: output.value,
      error: error?.text,
      metadata: {
        ...result.metadata,
        redacted: Boolean(result.metadata.redacted || output.redacted || error?.redacted),
        outputHash: hashJson(output.value ?? error?.text ?? ""),
      },
    };
    const sessionObservations = this.observations.get(context.sessionId) ?? [];
    sessionObservations.push(observation);
    this.observations.set(context.sessionId, sessionObservations);
    const fragment = createFragment("tool", observation, 50, false, true, "tool", "observation");
    const fragments = [...context.fragments, fragment];
    return {
      ...context,
      messages: fragmentsToMessages(fragments),
      fragments,
    };
  }

  injectToolError(context: ContextBundle, call: ToolCall, error: string): ContextBundle {
    return this.injectToolResult(context, call, {
      callId: call.id,
      toolName: call.name,
      ok: false,
      error,
      metadata: {},
      durationMs: 0,
    });
  }

  compact(context: ContextBundle, tier: Exclude<CompactionTier, "none">): {
    context: ContextBundle;
    discardedClasses: string[];
    retainedConstraintHash: string;
    summaryHash: string;
  } {
    if (tier === "micro_compact") {
      return this.microCompact(context);
    }
    const discardedClasses = new Set<string>();
    const nextFragments = context.fragments.flatMap((fragment) => {
      if (tier === "snip") {
        if (fragment.discardable) {
          discardedClasses.add(fragment.summaryKind);
          return [];
        }
        if (fragment.summaryKind === "task" || fragment.summaryKind === "workspace") {
          return [{ ...fragment, content: summarizeFragment(fragment), summaryKind: "summary" as const }];
        }
        return [fragment];
      }

      if (fragment.summaryKind === "task" || fragment.summaryKind === "workspace" || fragment.summaryKind === "observation") {
        return [{ ...fragment, content: summarizeFragment(fragment), summaryKind: "summary" as const }];
      }
      if (fragment.discardable) {
        discardedClasses.add(fragment.summaryKind);
        return [
          {
            ...fragment,
            content: summarizeFragment(fragment),
            summaryKind: "summary" as const,
            discardable: true,
          },
        ];
      }
      return [fragment];
    });

    const normalizedFragments =
      tier === "snip"
        ? collapseSnippedFragments(nextFragments)
        : nextFragments;

    const retainedConstraints = normalizedFragments.filter((fragment) => fragment.pinned).map((fragment) => fragment.content);
    const nextContext: ContextBundle = {
      ...context,
      fragments: normalizedFragments,
      messages: fragmentsToMessages(normalizedFragments),
      budgetReport: {
        ...context.budgetReport,
        tier,
      },
    };
    return {
      context: nextContext,
      discardedClasses: [...discardedClasses],
      retainedConstraintHash: hashJson(retainedConstraints),
      summaryHash: hashJson(normalizedFragments.map((fragment) => ({ kind: fragment.summaryKind, content: fragment.content }))),
    };
  }

  recordTouchedPaths(sessionId: string, paths: string[]): void {
    const set = this.touchedPaths.get(sessionId) ?? new Set<string>();
    for (const path of paths) {
      set.add(path.replaceAll("\\", "/"));
    }
    this.touchedPaths.set(sessionId, set);
  }

  shouldMicroCompact(context: ContextBundle): boolean {
    const observationFragments = context.fragments.filter((fragment) => fragment.source === "tool" && isToolResultObservation(fragment.content));
    let recentSeen = 0;

    for (let pointer = observationFragments.length - 1; pointer >= 0; pointer--) {
      const observation = observationFragments[pointer].content as ToolObservation;
      if (recentSeen < KEEP_RECENT_TOOL_RESULTS) {
        recentSeen += 1;
        continue;
      }
      if (PRESERVE_RESULT_TOOLS.has(observation.toolName)) continue;
      if (serializedSize(observation) >= MICRO_COMPACT_MIN_SIZE) return true;
    }

    return false;
  }

  private microCompact(context: ContextBundle): {
    context: ContextBundle;
    discardedClasses: string[];
    retainedConstraintHash: string;
    summaryHash: string;
  } {
    const observationIndices = context.fragments
      .map((fragment, index) => ({ fragment, index }))
      .filter(({ fragment }) => fragment.source === "tool" && isToolResultObservation(fragment.content));

    let recentSeen = 0;
    const replaceIndexes = new Set<number>();

    for (let pointer = observationIndices.length - 1; pointer >= 0; pointer--) {
      const { fragment, index } = observationIndices[pointer];
      const observation = fragment.content as ToolObservation;
      if (recentSeen < KEEP_RECENT_TOOL_RESULTS) {
        recentSeen += 1;
        continue;
      }
      if (PRESERVE_RESULT_TOOLS.has(observation.toolName)) continue;
      const originalSize = serializedSize(observation);
      if (originalSize < MICRO_COMPACT_MIN_SIZE) continue;
      replaceIndexes.add(index);
    }

    const nextFragments = context.fragments.map((fragment, index) => {
      if (!replaceIndexes.has(index)) return fragment;
      const observation = fragment.content as ToolObservation;
      const placeholder = createPlaceholder(observation);
      const replacement: ToolObservation = {
        type: "tool_result",
        callId: observation.callId,
        toolName: observation.toolName,
        status: observation.status,
        output: placeholder,
        error: undefined,
        metadata: { microCompacted: true },
      };
      return {
        ...fragment,
        content: replacement,
        summaryKind: "summary" as const,
      };
    });

    const retainedConstraints = nextFragments.filter((fragment) => fragment.pinned).map((fragment) => fragment.content);
    const nextContext: ContextBundle = {
      ...context,
      fragments: nextFragments,
      messages: fragmentsToMessages(nextFragments),
      budgetReport: {
        ...context.budgetReport,
        tier: "micro_compact",
      },
    };

    return {
      context: nextContext,
      discardedClasses: replaceIndexes.size > 0 ? ["observation"] : [],
      retainedConstraintHash: hashJson(retainedConstraints),
      summaryHash: hashJson(nextFragments.map((fragment) => ({ kind: fragment.summaryKind, content: fragment.content }))),
    };
  }
}

const KEEP_RECENT_TOOL_RESULTS = 3;
const PRESERVE_RESULT_TOOLS = new Set(["read_file"]);
const MICRO_COMPACT_MIN_SIZE = 120;

function createFragment(
  role: ContextFragment["role"],
  content: unknown,
  priority: number,
  pinned: boolean,
  discardable: boolean,
  source: ContextFragment["source"],
  summaryKind: ContextFragment["summaryKind"],
): ContextFragment {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    priority,
    pinned,
    discardable,
    source,
    summaryKind,
  };
}

function fragmentsToMessages(fragments: ContextFragment[]) {
  return fragments.map((fragment) => ({ role: fragment.role, content: fragment.content }));
}

function summarizeTask(value: unknown): string {
  return `task:${shortSummary(value, 24)}`;
}

function summarizeFragment(fragment: ContextFragment): string {
  if (fragment.summaryKind === "task") return summarizeTask(fragment.content);
  if (fragment.summaryKind === "workspace") return `workspace:${shortSummary(fragment.content, 24)}`;
  if (fragment.summaryKind === "observation") return `observation:${shortSummary(fragment.content, 32)}`;
  if (fragment.summaryKind === "memory") return `memory:${shortSummary(fragment.content, 32)}`;
  return `summary:${shortSummary(fragment.content, 32)}`;
}

function collapseSnippedFragments(fragments: ContextFragment[]): ContextFragment[] {
  const pinnedSystem = fragments.filter((fragment) => fragment.role === "system");
  const nonSystem = fragments.filter((fragment) => fragment.role !== "system");
  if (pinnedSystem.length <= 1) return fragments;

  const collapsedSystem = createFragment(
    "system",
    `system:${pinnedSystem.map((fragment) => fragment.summaryKind).join("|")}`,
    100,
    true,
    false,
    "system",
    "summary",
  );

  return [collapsedSystem, ...nonSystem];
}

function shortSummary(value: unknown, maxLength: number): string {
  const text = summarizeValue(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function emptyInstructionBundle(): InstructionBundle {
  return {
    fragments: [],
    sources: [],
    totalBytes: 0,
    trimmed: false,
    trimmedSources: [],
  };
}

function isToolResultObservation(value: unknown): value is ToolObservation {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "tool_result");
}

function serializedSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function createPlaceholder(observation: ToolObservation): HistoricalToolResultPlaceholder {
  return {
    replacementKind: "historical_tool_result_placeholder",
    toolName: observation.toolName,
    originalHash: hashJson(observation),
    originalSize: serializedSize(observation),
    summaryLabel: `previous_${observation.toolName}_result`,
  };
}

async function buildMemoryContext(selections: MemoryContextSelection[]): Promise<MemoryContextPayload> {
  const records: RedactedMemoryRecord[] = [];
  const seenIds = new Set<string>();
  let truncated = false;

  for (const selection of selections) {
    const limit = normalizeMemoryLimit(selection.maxRecords);
    const retrieved = await selection.manager.retrieve(selection.query);
    if (retrieved.length > limit) truncated = true;
    for (const record of retrieved.slice(0, limit)) {
      if (seenIds.has(record.id)) continue;
      seenIds.add(record.id);
      const redacted = redactSecretsInString(record.content);
      records.push({
        id: record.id,
        scope: record.scope,
        content: redacted.text,
        confidence: record.confidence,
        freshness: record.freshness,
        loadPolicy: record.loadPolicy,
        tags: record.tags,
      });
    }
  }

  return {
    type: "memory_context",
    records,
    selectedCount: records.length,
    truncated,
  };
}

function normalizeMemoryLimit(maxRecords: number | undefined): number {
  if (maxRecords === undefined) return 8;
  if (!Number.isFinite(maxRecords)) return 8;
  return Math.max(0, Math.floor(maxRecords));
}
