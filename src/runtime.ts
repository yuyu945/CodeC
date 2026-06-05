import { resolve } from "node:path";

import { ContextBuilder } from "./context.ts";
import { JsonlEventStore } from "./events.ts";
import { ProviderError, redactProviderMessage } from "./models.ts";
import { PermissionManager } from "./permissions.ts";
import { hashJson, summarizeValue } from "./shared.ts";
import { ToolExecutor, validateToolCall } from "./tools.ts";
import type { CompactionTier, ContextBundle, ContextBudgetReport, ModelAdapter, TurnRequest, TurnResult } from "./types.ts";

export class AgentRuntime {
  private readonly deps: {
    model: ModelAdapter;
    eventStore: JsonlEventStore;
    contextBuilder: ContextBuilder;
    permissionManager: PermissionManager;
    toolExecutor: ToolExecutor;
    limits?: { maxToolIterations?: number; maxModelRetries?: number; modelRetryDelayMs?: number };
  };
  private readonly maxToolIterations: number;
  private readonly maxModelRetries: number;
  private readonly modelRetryDelayMs: number;

  constructor(
    deps: {
      model: ModelAdapter;
      eventStore: JsonlEventStore;
      contextBuilder: ContextBuilder;
      permissionManager: PermissionManager;
      toolExecutor: ToolExecutor;
      limits?: { maxToolIterations?: number; maxModelRetries?: number; modelRetryDelayMs?: number };
    },
  ) {
    this.deps = deps;
    this.maxToolIterations = deps.limits?.maxToolIterations ?? 8;
    this.maxModelRetries = deps.limits?.maxModelRetries ?? 0;
    this.modelRetryDelayMs = deps.limits?.modelRetryDelayMs ?? 100;
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    const memorySuggestions: TurnResult["memorySuggestions"] = [];
    if (request.abortSignal?.aborted) {
      await this.deps.eventStore.append({ type: "UserMessage", sessionId: request.sessionId, text: request.userMessage });
      await this.deps.eventStore.append({
        type: "TurnAborted",
        sessionId: request.sessionId,
        reason: abortReason(request.abortSignal.reason),
      });
      await this.deps.eventStore.append({ type: "AgentFinished", sessionId: request.sessionId, reason: "aborted" });
      return {
        finalMessage: `Stopped: aborted. ${abortReason(request.abortSignal.reason)}`,
        finishReason: "aborted",
        events: await this.deps.eventStore.forSession(request.sessionId),
        memorySuggestions,
      };
    }

    await this.deps.eventStore.append({ type: "UserMessage", sessionId: request.sessionId, text: request.userMessage });
    let context = await this.deps.contextBuilder.build(request);
    await this.deps.eventStore.append({
      type: "ContextBuilt",
      sessionId: request.sessionId,
      messageCount: context.messages.length,
      toolCount: context.toolDefinitions.length,
    });
    await this.deps.eventStore.append({
      type: "InstructionsResolved",
      sessionId: request.sessionId,
      appliedSources: context.instructions.sources.map((source) => source.relativePath),
      totalBytes: context.instructions.totalBytes,
    });
    if (context.instructions.trimmed) {
      await this.deps.eventStore.append({
        type: "InstructionsTrimmed",
        sessionId: request.sessionId,
        trimmedSources: context.instructions.trimmedSources,
        totalBytes: context.instructions.totalBytes,
      });
    }
    context = this.refreshBudget(context);

    for (let iteration = 0; iteration < this.maxToolIterations; iteration++) {
      let microCompactedThisIteration = false;
      if (this.deps.contextBuilder.shouldMicroCompact(context)) {
        context = await this.compactContext(context, request, "micro_compact");
        microCompactedThisIteration = true;
      }

      if (!microCompactedThisIteration && context.budgetReport.mustCompact) {
        context = await this.compactContext(context, request, "auto_compact");
      }

      const provider = this.deps.model.provider ?? "unknown";
      const model = this.deps.model.model ?? "unknown";
      let response;
      let finalProviderError: ProviderError | undefined;
      let reactiveCompactionAttempted = false;

      for (let attempt = 0; attempt <= this.maxModelRetries; attempt++) {
        if (request.abortSignal?.aborted) {
          await this.deps.eventStore.append({
            type: "TurnAborted",
            sessionId: request.sessionId,
            reason: abortReason(request.abortSignal.reason),
          });
          await this.deps.eventStore.append({ type: "AgentFinished", sessionId: request.sessionId, reason: "aborted" });
          return {
            finalMessage: `Stopped: aborted. ${abortReason(request.abortSignal.reason)}`,
            finishReason: "aborted",
            events: await this.deps.eventStore.forSession(request.sessionId),
            memorySuggestions,
          };
        }

        await this.deps.eventStore.append({
          type: "ModelRequestStarted",
          sessionId: request.sessionId,
          provider,
          model,
        });

        try {
          response = await this.deps.model.complete(context);
          memorySuggestions.push(...(response.memorySuggestions ?? []));
          finalProviderError = undefined;
          break;
        } catch (error) {
          const providerError =
            error instanceof ProviderError ? error : new ProviderError(error instanceof Error ? error.message : String(error));
          finalProviderError = providerError;
          await this.deps.eventStore.append({
            type: "ModelError",
            sessionId: request.sessionId,
            provider,
            model,
            code: providerError.code,
            message: redactProviderMessage(providerError.message),
          });
          if (providerError.code === "provider_context_too_large" && !reactiveCompactionAttempted) {
            reactiveCompactionAttempted = true;
            context = await this.compactContext(context, request, "reactive_compact");
            if (context.budgetReport.mustCompact) {
              context = await this.compactContext(context, request, "snip");
            }
            attempt -= 1;
            continue;
          }
          if (!providerError.retryable || attempt >= this.maxModelRetries) {
            break;
          }
          await delay(this.modelRetryDelayMs, request.abortSignal);
        }
      }

      if (finalProviderError) {
        await this.deps.eventStore.append({ type: "AgentFinished", sessionId: request.sessionId, reason: "model_error" });
        return {
          finalMessage: `Stopped: model error (${finalProviderError.code}). ${redactProviderMessage(finalProviderError.message)}`,
          finishReason: "model_error",
          events: await this.deps.eventStore.forSession(request.sessionId),
          memorySuggestions,
        };
      }

      await this.deps.eventStore.append({
        type: "ModelResponseReceived",
        sessionId: request.sessionId,
        finalMessage: Boolean(response.finalMessage),
        toolCallCount: response.toolCalls?.length ?? 0,
      });

      if (response.finalMessage !== undefined) {
        await this.deps.eventStore.append({ type: "AgentFinished", sessionId: request.sessionId, reason: "final_message" });
        return {
          finalMessage: response.finalMessage,
          finishReason: "final_message",
          events: await this.deps.eventStore.forSession(request.sessionId),
          memorySuggestions,
        };
      }

      for (const call of response.toolCalls ?? []) {
        const validationError = validateToolCall(call);
        if (validationError) {
          context = this.deps.contextBuilder.injectToolError(context, call, validationError);
          await this.deps.eventStore.append({
            type: "ToolResultInjected",
            sessionId: request.sessionId,
            callId: call.id,
            toolName: call.name,
            status: "error",
          });
          continue;
        }

        const decision = await this.deps.permissionManager.evaluate(call, request.workspace);
        await this.deps.eventStore.append({
          type: "PermissionEvaluated",
          sessionId: request.sessionId,
          callId: call.id,
          toolName: call.name,
          decision: decision.kind,
          reason: decision.reason,
        });

        if (decision.kind === "deny") {
          context = this.deps.contextBuilder.injectToolError(context, call, "permission_denied");
          await this.deps.eventStore.append({
            type: "ToolResultInjected",
            sessionId: request.sessionId,
            callId: call.id,
            toolName: call.name,
            status: "error",
          });
          continue;
        }

        if (decision.kind === "ask") {
          return {
            finalMessage: "",
            nextAction: { type: "approval_required", call, decision },
            events: await this.deps.eventStore.forSession(request.sessionId),
            memorySuggestions,
          };
        }

        await this.deps.eventStore.append({
          type: "ToolCallStarted",
          sessionId: request.sessionId,
          callId: call.id,
          toolName: call.name,
          inputHash: hashJson(call.input),
        });
        const result = await this.deps.toolExecutor.execute(call, request.workspace);
        this.deps.contextBuilder.recordTouchedPaths(
          request.sessionId,
          extractTouchedPaths(result).map((path) => resolve(request.workspace.cwd, path)),
        );
        await this.deps.eventStore.append({
          type: "ToolCallFinished",
          sessionId: request.sessionId,
          callId: call.id,
          toolName: call.name,
          status: result.ok ? "ok" : "error",
          durationMs: result.durationMs,
          outputHash: hashJson(result.output ?? result.error ?? ""),
          metadataHash: hashJson(result.metadata),
          summary: summarizeValue(result.output ?? result.error ?? ""),
          errorSummary: result.error ? summarizeValue(result.error) : undefined,
        });
        context = this.deps.contextBuilder.injectToolResult(context, call, result);
        const latestObservation = context.messages.at(-1)?.content;
        await this.deps.eventStore.append({
          type: "ToolResultInjected",
          sessionId: request.sessionId,
          callId: call.id,
          toolName: call.name,
          status: result.ok ? "ok" : "error",
          observationHash: hashJson(latestObservation ?? ""),
          summary: summarizeValue(latestObservation),
          errorSummary: result.error ? summarizeValue(result.error) : undefined,
        });
      }
    }

    await this.deps.eventStore.append({ type: "AgentFinished", sessionId: request.sessionId, reason: "tool_iteration_limit" });
    return {
      finalMessage: "Stopped: tool iteration limit reached.",
      finishReason: "tool_iteration_limit",
      events: await this.deps.eventStore.forSession(request.sessionId),
      memorySuggestions,
    };
  }

  private refreshBudget(context: ContextBundle): ContextBundle {
    const estimate = typeof this.deps.model.estimateBudget === "function" ? this.deps.model.estimateBudget(context) : fallbackBudgetEstimate(context);
    return {
      ...context,
      budgetReport: estimate,
    };
  }

  private async compactContext(context: ContextBundle, request: TurnRequest, tier: Exclude<CompactionTier, "none">): Promise<ContextBundle> {
    if (request.abortSignal?.aborted) {
      await this.deps.eventStore.append({
        type: "TurnAborted",
        sessionId: request.sessionId,
        reason: abortReason(request.abortSignal.reason),
      });
      await this.deps.eventStore.append({ type: "AgentFinished", sessionId: request.sessionId, reason: "aborted" });
      throw new ProviderError(abortReason(request.abortSignal.reason), "request_aborted", false);
    }

    const before = context.budgetReport;
    const result = this.deps.contextBuilder.compact(context, tier);
    const next = this.refreshBudget(result.context);
    await this.deps.eventStore.append({
      type: "ContextCompacted",
      sessionId: request.sessionId,
      tier,
      beforeUnits: before.estimatedUnits,
      afterUnits: next.budgetReport.estimatedUnits,
      retainedConstraintHash: result.retainedConstraintHash,
      discardedClasses: result.discardedClasses,
      summaryHash: result.summaryHash,
    });
    return next;
  }
}

function abortReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return "request aborted";
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  if (signal.aborted) {
    throw new ProviderError(abortReason(signal.reason), "request_aborted", false);
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(new ProviderError(abortReason(signal.reason), "request_aborted", false));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function fallbackBudgetEstimate(context: ContextBundle): ContextBudgetReport {
  const estimatedUnits = Math.ceil(
    (context.messages.reduce((total, message) => total + JSON.stringify(message.content).length, 0) +
      context.toolDefinitions.reduce((total, tool) => total + JSON.stringify(tool).length, 0)) /
      4,
  );
  const limit = 8_000;
  const threshold = 6_400;
  return {
    estimatedUnits,
    limit,
    threshold,
    mustCompact: estimatedUnits >= threshold,
    tier: context.budgetReport.tier ?? "none",
    overflowBy: estimatedUnits > limit ? estimatedUnits - limit : 0,
  };
}

function extractTouchedPaths(result: { output?: unknown }): string[] {
  const output = result.output;
  if (!output || typeof output !== "object") return [];
  const directPath = typeof (output as { path?: unknown }).path === "string" ? String((output as { path: string }).path) : undefined;
  const matches = Array.isArray((output as { matches?: unknown[] }).matches)
    ? (output as { matches: Array<{ path?: unknown }> }).matches
        .map((match) => (typeof match.path === "string" ? match.path : undefined))
        .filter((path): path is string => Boolean(path))
    : [];
  return [...new Set([...(directPath ? [directPath] : []), ...matches])];
}
