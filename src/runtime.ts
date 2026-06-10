import { resolve } from "node:path";

import { ContextBuilder } from "./context.ts";
import { JsonlEventStore } from "./events.ts";
import { ProviderError, redactProviderMessage, summarizeProviderErrorCode } from "./models.ts";
import { PermissionManager } from "./permissions.ts";
import { hashJson, summarizeValue } from "./shared.ts";
import { normalizeToolCall, ToolExecutor, validateToolCall } from "./tools.ts";
import type {
  ApprovalResumeRequest,
  CompactionTier,
  ContextBundle,
  ContextBudgetReport,
  ModelAdapter,
  ModelResponse,
  PendingApprovalSnapshot,
  PersistedPendingApprovalSnapshot,
  PersistedSessionMetadata,
  SessionStateStore,
  ToolCall,
  ToolResult,
  TurnRequest,
  TurnResult,
} from "./types.ts";

export class AgentRuntime {
  private readonly deps: {
    model: ModelAdapter;
    eventStore: JsonlEventStore;
    sessionStateStore?: SessionStateStore;
    sessionMetadata?: PersistedSessionMetadata;
    contextBuilder: ContextBuilder;
    permissionManager: PermissionManager;
    toolExecutor: ToolExecutor;
    limits?: { maxToolIterations?: number; maxModelRetries?: number; modelRetryDelayMs?: number };
  };
  private readonly maxToolIterations: number;
  private readonly maxModelRetries: number;
  private readonly modelRetryDelayMs: number;
  private readonly pendingApprovals = new Map<string, PendingApprovalSnapshot>();

  constructor(
    deps: {
      model: ModelAdapter;
      eventStore: JsonlEventStore;
      sessionStateStore?: SessionStateStore;
      sessionMetadata?: PersistedSessionMetadata;
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
    const memorySuggestions: NonNullable<TurnResult["memorySuggestions"]> = [];
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

    return await this.continueTurn({
      request: { sessionId: request.sessionId, workspace: request.workspace, abortSignal: request.abortSignal },
      context,
      iteration: 0,
      memorySuggestions,
    });
  }

  getPendingApproval(sessionId: string): PendingApprovalSnapshot | undefined {
    return this.pendingApprovals.get(sessionId);
  }

  async restorePersistedPending(sessionId: string): Promise<PendingApprovalSnapshot> {
    const store = this.deps.sessionStateStore;
    if (!store) throw new Error("resume_state_store_unavailable");
    const persisted = await store.loadPending(sessionId);
    if (!persisted) throw new Error("resume_state_not_found");
    try {
      await this.assertApprovalStateMatchesEvents(sessionId, persisted.pending.approvalId);
    } catch (error) {
      await store.clearPending(sessionId);
      throw error;
    }
    const hydrated = hydratePendingApproval(persisted.pending);
    this.pendingApprovals.set(sessionId, hydrated);
    return hydrated;
  }

  async resumeAfterApproval(request: ApprovalResumeRequest): Promise<TurnResult> {
    const pending = this.pendingApprovals.get(request.sessionId);
    if (!pending) {
      return await this.resumeErrorResult(
        request.sessionId,
        `Cannot resume: no pending approval for session ${request.sessionId}.`,
      );
    }
    if (pending.approvalId !== request.approvalId) {
      return await this.resumeErrorResult(
        request.sessionId,
        `Cannot resume: approval ${request.approvalId} does not match pending approval for session ${request.sessionId}.`,
      );
    }

    this.pendingApprovals.delete(request.sessionId);
    try {
      let context = pending.context;
      if (request.resolution === "allow") {
        context = await this.executeApprovedCall(context, pending.pendingCall, pending.request.workspace);
      } else {
        context = await this.injectPermissionDenied(context, pending.pendingCall, request.sessionId);
      }

      const result = await this.continueTurn({
        request: pending.request,
        context,
        iteration: pending.iteration,
        pendingToolCalls: [...pending.remainingToolCalls],
        memorySuggestions: [...pending.memorySuggestions],
        resolvedApproval: {
          approvalId: pending.approvalId,
          resolution: request.resolution,
          resumedFromCallId: pending.pendingCall.id,
          remainingToolCallCount: pending.remainingToolCalls.length,
        },
      });
      if (result.nextAction?.type !== "approval_required") {
        await this.deps.sessionStateStore?.clearPending(request.sessionId);
      }
      return result;
    } catch (error) {
      this.pendingApprovals.set(request.sessionId, pending);
      throw error;
    }
  }

  private async continueTurn(state: {
    request: Pick<TurnRequest, "sessionId" | "workspace" | "abortSignal">;
    context: ContextBundle;
    iteration: number;
    memorySuggestions: NonNullable<TurnResult["memorySuggestions"]>;
    pendingToolCalls?: ToolCall[];
    resolvedApproval?: {
      approvalId: string;
      resolution: ApprovalResumeRequest["resolution"];
      resumedFromCallId: string;
      remainingToolCallCount: number;
    };
  }): Promise<TurnResult> {
    let { request, context, memorySuggestions } = state;
    let queuedToolCalls = state.pendingToolCalls;
    let resolvedApproval = state.resolvedApproval;

    for (let iteration = state.iteration; iteration < this.maxToolIterations; iteration += 1) {
      if (!queuedToolCalls) {
        let microCompactedThisIteration = false;
        if (this.deps.contextBuilder.shouldMicroCompact(context)) {
          context = await this.compactContext(context, request, "micro_compact");
          microCompactedThisIteration = true;
        }

        if (!microCompactedThisIteration && context.budgetReport.mustCompact) {
          context = await this.compactContext(context, request, "auto_compact");
        }

        const response = await this.requestModel(context, request, memorySuggestions);
        if ("error" in response) {
          await this.emitResolvedApprovalIfNeeded(request.sessionId, resolvedApproval);
          await this.deps.eventStore.append({ type: "AgentFinished", sessionId: request.sessionId, reason: "model_error" });
          return {
            finalMessage: `Stopped: model error (${response.error.code}). ${summarizeProviderErrorCode(response.error.code)}`,
            finishReason: "model_error",
            events: await this.deps.eventStore.forSession(request.sessionId),
            memorySuggestions,
          };
        }
        if (response.aborted) {
          await this.emitResolvedApprovalIfNeeded(request.sessionId, resolvedApproval);
          return {
            finalMessage: `Stopped: aborted. ${abortReason(request.abortSignal?.reason)}`,
            finishReason: "aborted",
            events: await this.deps.eventStore.forSession(request.sessionId),
            memorySuggestions,
          };
        }
        if (response.finalMessage !== undefined) {
          await this.emitResolvedApprovalIfNeeded(request.sessionId, resolvedApproval);
          await this.deps.eventStore.append({ type: "AgentFinished", sessionId: request.sessionId, reason: "final_message" });
          return {
            finalMessage: response.finalMessage,
            finishReason: "final_message",
            events: await this.deps.eventStore.forSession(request.sessionId),
            memorySuggestions,
          };
        }
        queuedToolCalls = response.toolCalls ?? [];
      }

      while (queuedToolCalls.length > 0) {
        const [rawCall, ...remainingToolCalls] = queuedToolCalls;
        const call = normalizeToolCall(rawCall);
        const validationError = validateToolCall(call);
        if (validationError) {
          context = this.deps.contextBuilder.injectToolError(context, call, formatToolValidationError(validationError));
          await this.appendToolInjectionEvent(request.sessionId, call, "error", undefined, context);
          queuedToolCalls = remainingToolCalls;
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
          context = await this.injectPermissionDenied(context, call, request.sessionId);
          queuedToolCalls = remainingToolCalls;
          continue;
        }

        if (decision.kind === "ask") {
          await this.emitResolvedApprovalIfNeeded(request.sessionId, resolvedApproval);
          resolvedApproval = undefined;
          const approvalId = `approval-${call.id}`;
          const pending: PendingApprovalSnapshot = {
            approvalId,
            request,
            context,
            iteration,
            pendingCall: call,
            remainingToolCalls,
            memorySuggestions: [...memorySuggestions],
            decision,
          };
          this.pendingApprovals.set(request.sessionId, pending);
          await this.deps.eventStore.append({
            type: "ApprovalPending",
            sessionId: request.sessionId,
            approvalId,
            callId: call.id,
            toolName: call.name,
            remainingToolCallCount: remainingToolCalls.length,
          });
          await this.persistPendingApproval(pending);
          return {
            finalMessage: "",
            nextAction: { type: "approval_required", approvalId, call, decision },
            events: await this.deps.eventStore.forSession(request.sessionId),
            memorySuggestions,
          };
        }

        context = await this.executeApprovedCall(context, call, request.workspace);
        queuedToolCalls = remainingToolCalls;
      }

      queuedToolCalls = undefined;
    }

    await this.emitResolvedApprovalIfNeeded(request.sessionId, resolvedApproval);
    await this.deps.eventStore.append({ type: "AgentFinished", sessionId: request.sessionId, reason: "tool_iteration_limit" });
    return {
      finalMessage: "Stopped: tool iteration limit reached.",
      finishReason: "tool_iteration_limit",
      events: await this.deps.eventStore.forSession(request.sessionId),
      memorySuggestions,
    };
  }

  private async persistPendingApproval(pending: PendingApprovalSnapshot): Promise<void> {
    if (!this.deps.sessionStateStore || !this.deps.sessionMetadata) return;
    await this.deps.sessionStateStore.savePending(serializePendingApproval(pending), this.deps.sessionMetadata);
  }

  private async emitResolvedApprovalIfNeeded(
    sessionId: string,
    resolvedApproval?: {
      approvalId: string;
      resolution: ApprovalResumeRequest["resolution"];
      resumedFromCallId: string;
      remainingToolCallCount: number;
    },
  ): Promise<void> {
    if (!resolvedApproval) return;
    await this.deps.eventStore.append({
      type: "ApprovalResolved",
      sessionId,
      approvalId: resolvedApproval.approvalId,
      resolution: resolvedApproval.resolution,
    });
    await this.deps.eventStore.append({
      type: "TurnResumed",
      sessionId,
      approvalId: resolvedApproval.approvalId,
      resumedFromCallId: resolvedApproval.resumedFromCallId,
      remainingToolCallCount: resolvedApproval.remainingToolCallCount,
    });
  }

  private async requestModel(
    initialContext: ContextBundle,
    request: Pick<TurnRequest, "sessionId" | "workspace" | "abortSignal">,
    memorySuggestions: NonNullable<TurnResult["memorySuggestions"]>,
  ): Promise<(ModelResponse & { aborted?: false }) | { error: ProviderError } | { aborted: true }> {
    let context = initialContext;
    const provider = this.deps.model.provider ?? "unknown";
    const model = this.deps.model.model ?? "unknown";
    let finalProviderError: ProviderError | undefined;
    let reactiveCompactionAttempted = false;

    for (let attempt = 0; attempt <= this.maxModelRetries; attempt += 1) {
      if (request.abortSignal?.aborted) {
        await this.deps.eventStore.append({
          type: "TurnAborted",
          sessionId: request.sessionId,
          reason: abortReason(request.abortSignal.reason),
        });
        await this.deps.eventStore.append({ type: "AgentFinished", sessionId: request.sessionId, reason: "aborted" });
        return { aborted: true };
      }

      await this.deps.eventStore.append({
        type: "ModelRequestStarted",
        sessionId: request.sessionId,
        provider,
        model,
      });

      try {
        const response = await this.deps.model.complete(context);
        memorySuggestions.push(...(response.memorySuggestions ?? []));
        await this.deps.eventStore.append({
          type: "ModelResponseReceived",
          sessionId: request.sessionId,
          finalMessage: Boolean(response.finalMessage),
          toolCallCount: response.toolCalls?.length ?? 0,
        });
        return response;
      } catch (error) {
        const providerError =
          error instanceof ProviderError
            ? error
            : new ProviderError(error instanceof Error ? error.message : String(error), "provider_request_failed", true);
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

    return { error: finalProviderError ?? new ProviderError("unknown provider error") };
  }

  private async injectPermissionDenied(context: ContextBundle, call: ToolCall, sessionId: string): Promise<ContextBundle> {
    const nextContext = this.deps.contextBuilder.injectToolError(context, call, "permission_denied");
    await this.appendToolInjectionEvent(sessionId, call, "error", undefined, nextContext);
    return nextContext;
  }

  private async executeApprovedCall(
    context: ContextBundle,
    call: ToolCall,
    workspace: TurnRequest["workspace"],
  ): Promise<ContextBundle> {
    await this.deps.eventStore.append({
      type: "ToolCallStarted",
      sessionId: context.sessionId,
      callId: call.id,
      toolName: call.name,
      inputHash: hashJson(call.input),
    });
    const result = await this.deps.toolExecutor.execute(call, workspace);
    this.deps.contextBuilder.recordTouchedPaths(
      context.sessionId,
      extractTouchedPaths(result).map((path) => resolve(workspace.cwd, path)),
    );
    await this.deps.eventStore.append({
      type: "ToolCallFinished",
      sessionId: context.sessionId,
      callId: call.id,
      toolName: call.name,
      status: result.ok ? "ok" : "error",
      durationMs: result.durationMs,
      outputHash: hashJson(result.output ?? result.error ?? ""),
      metadataHash: hashJson(result.metadata),
      summary: summarizeValue(result.output ?? result.error ?? ""),
      errorSummary: result.error ? summarizeValue(result.error) : undefined,
    });
    const nextContext = this.deps.contextBuilder.injectToolResult(context, call, result);
    await this.appendToolInjectionEvent(context.sessionId, call, result.ok ? "ok" : "error", result, nextContext);
    return nextContext;
  }

  private async appendToolInjectionEvent(
    sessionId: string,
    call: ToolCall,
    status: "ok" | "error",
    result?: ToolResult,
    context?: ContextBundle,
  ): Promise<void> {
    const latestObservation = context?.messages.at(-1)?.content;
    await this.deps.eventStore.append({
      type: "ToolResultInjected",
      sessionId,
      callId: call.id,
      toolName: call.name,
      status,
      observationHash: hashJson(latestObservation ?? ""),
      summary: summarizeValue(latestObservation),
      errorSummary: result?.error ? summarizeValue(result.error) : undefined,
    });
  }

  private async resumeErrorResult(sessionId: string, finalMessage: string): Promise<TurnResult> {
    return {
      finalMessage,
      events: await this.deps.eventStore.forSession(sessionId),
      memorySuggestions: [],
    };
  }

  private refreshBudget(context: ContextBundle): ContextBundle {
    const estimate = typeof this.deps.model.estimateBudget === "function" ? this.deps.model.estimateBudget(context) : fallbackBudgetEstimate(context);
    return {
      ...context,
      budgetReport: estimate,
    };
  }

  private async compactContext(
    context: ContextBundle,
    request: Pick<TurnRequest, "sessionId" | "workspace" | "abortSignal">,
    tier: Exclude<CompactionTier, "none">,
  ): Promise<ContextBundle> {
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

  private async assertApprovalStateMatchesEvents(sessionId: string, approvalId: string): Promise<void> {
    const events = await this.deps.eventStore.forSession(sessionId);
    const approvalEvents = events.filter(
      (event) => event.type === "ApprovalPending" || event.type === "ApprovalResolved" || event.type === "TurnResumed",
    );
    const latestApprovalEvent = approvalEvents.at(-1);
    if (!latestApprovalEvent || latestApprovalEvent.type !== "ApprovalPending") {
      throw new Error("resume_state_mismatch");
    }
    if (latestApprovalEvent.approvalId !== approvalId) {
      throw new Error("resume_state_mismatch");
    }
    const pendingSequence = latestApprovalEvent.sequence;
    const hasLaterResolution = approvalEvents.some(
      (event) =>
        event.sequence > pendingSequence &&
        ((event.type === "ApprovalResolved" && event.approvalId === approvalId) ||
          (event.type === "TurnResumed" && event.approvalId === approvalId)),
    );
    if (hasLaterResolution) {
      throw new Error("resume_state_mismatch");
    }
  }
}

function serializePendingApproval(pending: PendingApprovalSnapshot): PersistedPendingApprovalSnapshot {
  return {
    approvalId: pending.approvalId,
    sessionId: pending.request.sessionId,
    context: pending.context,
    iteration: pending.iteration,
    pendingCall: pending.pendingCall,
    remainingToolCalls: pending.remainingToolCalls,
    memorySuggestions: pending.memorySuggestions,
    decision: pending.decision,
    workspace: pending.request.workspace,
  };
}

function hydratePendingApproval(snapshot: PersistedPendingApprovalSnapshot): PendingApprovalSnapshot {
  return {
    approvalId: snapshot.approvalId,
    request: {
      sessionId: snapshot.sessionId,
      workspace: snapshot.workspace,
    },
    context: snapshot.context,
    iteration: snapshot.iteration,
    pendingCall: snapshot.pendingCall,
    remainingToolCalls: snapshot.remainingToolCalls,
    memorySuggestions: snapshot.memorySuggestions,
    decision: snapshot.decision,
  };
}

function abortReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return "request aborted";
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
    return;
  }
  if (signal.aborted) {
    throw new ProviderError(abortReason(signal.reason), "request_aborted", false);
  }
  await new Promise<void>((resolveDelay, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
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

function formatToolValidationError(code: string): string {
  if (code === "invalid_read_file_input") return "invalid_read_file_input: expected { path: string }";
  if (code === "invalid_search_text_input") return "invalid_search_text_input: expected { pattern: string, path?: string }";
  if (code === "invalid_edit_file_input") return "invalid_edit_file_input: expected { path: string, content: string }";
  if (code === "invalid_shell_input") return "invalid_shell_input: expected { command: string }";
  return code;
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
