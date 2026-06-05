import type { AgentEvent, CompactionTier, PermissionDecision } from "./types.ts";

export interface EventCoverageChecklist {
  toolCounts: boolean;
  finishReason: boolean;
  compactionDetails: boolean;
  instructionDetails: boolean;
  abortPath: boolean;
  retryCount: boolean;
}

export interface SessionSummary {
  sessionId: string;
  finishReason: string | null;
  providerNames: string[];
  modelNames: string[];
  instructionsApplied: boolean;
  instructionTrimmed: boolean;
  compactionRan: boolean;
  compactionTiers: CompactionTier[];
  toolNames: string[];
}

export interface SessionMetrics {
  modelCallCount: number;
  toolCallCounts: Record<string, number>;
  permissionDecisionCounts: Record<PermissionDecision["kind"], number>;
  compactionCounts: Record<Exclude<CompactionTier, "none">, number>;
  finishReasonCounts: Record<string, number>;
}

export function eventCoverageChecklist(events: AgentEvent[]): EventCoverageChecklist {
  return {
    toolCounts: true,
    finishReason: true,
    compactionDetails: events.every((event) => event.type !== "ContextCompacted" || Boolean(event.tier && typeof event.beforeUnits === "number" && typeof event.afterUnits === "number")),
    instructionDetails: true,
    abortPath: true,
    retryCount: false,
  };
}

export class SessionInspector {
  private readonly events: AgentEvent[];

  constructor(events: AgentEvent[]) {
    this.events = [...events].sort((left, right) => left.sequence - right.sequence);
  }

  summary(): SessionSummary {
    const modelStarts = this.events.filter((event): event is Extract<AgentEvent, { type: "ModelRequestStarted" }> => event.type === "ModelRequestStarted");
    const finish = this.events.findLast((event): event is Extract<AgentEvent, { type: "AgentFinished" }> => event.type === "AgentFinished") ?? null;
    const toolCalls = this.events.filter((event): event is Extract<AgentEvent, { type: "ToolCallStarted" }> => event.type === "ToolCallStarted");
    const compactions = this.events.filter((event): event is Extract<AgentEvent, { type: "ContextCompacted" }> => event.type === "ContextCompacted");

    return {
      sessionId: this.events[0]?.sessionId ?? "",
      finishReason: finish?.reason ?? null,
      providerNames: [...new Set(modelStarts.map((event) => event.provider))],
      modelNames: [...new Set(modelStarts.map((event) => event.model))],
      instructionsApplied: this.events.some((event) => event.type === "InstructionsResolved"),
      instructionTrimmed: this.events.some((event) => event.type === "InstructionsTrimmed"),
      compactionRan: compactions.length > 0,
      compactionTiers: [...new Set(compactions.map((event) => event.tier))],
      toolNames: [...new Set(toolCalls.map((event) => event.toolName))],
    };
  }

  metrics(): SessionMetrics {
    const toolCallCounts = Object.fromEntries(countBy(this.events.filter((event): event is Extract<AgentEvent, { type: "ToolCallStarted" }> => event.type === "ToolCallStarted"), (event) => event.toolName));
    const permissionDecisionCounts = Object.assign(
      { allow: 0, ask: 0, deny: 0 },
      Object.fromEntries(countBy(this.events.filter((event): event is Extract<AgentEvent, { type: "PermissionEvaluated" }> => event.type === "PermissionEvaluated"), (event) => event.decision)),
    ) as Record<PermissionDecision["kind"], number>;
    const compactionCounts = Object.assign(
      { micro_compact: 0, auto_compact: 0, reactive_compact: 0, snip: 0 },
      Object.fromEntries(countBy(this.events.filter((event): event is Extract<AgentEvent, { type: "ContextCompacted" }> => event.type === "ContextCompacted"), (event) => event.tier)),
    ) as Record<Exclude<CompactionTier, "none">, number>;
    const finishReasonCounts = Object.fromEntries(
      countBy(this.events.filter((event): event is Extract<AgentEvent, { type: "AgentFinished" }> => event.type === "AgentFinished"), (event) => event.reason),
    );

    return {
      modelCallCount: this.events.filter((event) => event.type === "ModelRequestStarted").length,
      toolCallCounts,
      permissionDecisionCounts,
      compactionCounts,
      finishReasonCounts,
    };
  }

  toJsonReport(): string {
    return JSON.stringify(
      {
        coverage: eventCoverageChecklist(this.events),
        summary: this.summary(),
        metrics: this.metrics(),
      },
      null,
      2,
    );
  }
}

function countBy<T>(items: T[], select: (item: T) => string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = select(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()];
}
