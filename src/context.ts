import crypto from "node:crypto";

import type { CompactionTier, ContextBundle, ContextFragment, ToolCall, ToolObservation, ToolResult, TurnRequest } from "./types.ts";
import { capString, hashJson, redactSecretsInString, redactStructuredValue, summarizeValue } from "./shared.ts";
import { toolDefinitions } from "./tools.ts";

export class ContextBuilder {
  private readonly observations = new Map<string, ToolObservation[]>();

  build(request: TurnRequest): ContextBundle {
    const observations = this.observations.get(request.sessionId) ?? [];
    const fragments: ContextFragment[] = [
      createFragment("system", "MVP-0 single-agent runtime. Use only declared tools. Tool results are typed observations.", 100, true, false, "system", "instructions"),
      createFragment(
        "system",
        ["no memory", "no multi-agent", "no retrieval", "no IDE/TUI/API surface"],
        95,
        true,
        false,
        "system",
        "workspace",
      ),
      createFragment("system", { workspace: request.workspace.cwd }, 40, false, true, "system", "workspace"),
      createFragment("user", request.userMessage, 90, true, false, "user", "task"),
      ...observations.map((observation) => createFragment("tool", observation, 50, false, true, "tool", "observation")),
    ];
    return {
      sessionId: request.sessionId,
      messages: fragmentsToMessages(fragments),
      fragments,
      toolDefinitions: toolDefinitions(),
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
}

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
