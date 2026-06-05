export type ToolName = "read_file" | "search_text" | "edit_file" | "shell";

export interface WorkspacePolicy {
  cwd: string;
  root?: string;
}

export interface TurnRequest {
  sessionId: string;
  userMessage: string;
  workspace: WorkspacePolicy;
  abortSignal?: AbortSignal;
}

export type CompactionTier = "none" | "micro_compact" | "auto_compact" | "reactive_compact" | "snip";

export interface ContextBudgetReport {
  estimatedUnits: number;
  limit: number;
  threshold: number;
  mustCompact: boolean;
  tier: CompactionTier;
  overflowBy?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult<T = unknown> {
  callId: string;
  toolName: string;
  ok: boolean;
  output?: T;
  error?: string;
  metadata: Record<string, unknown>;
  durationMs: number;
}

export interface ModelResponse {
  finalMessage?: string;
  toolCalls?: ToolCall[];
}

export interface ModelRequest {
  sessionId: string;
  messages: RuntimeMessage[];
  toolDefinitions: ToolDefinition[];
  budgetReport: ContextBudgetReport;
}

export interface RuntimeMessage {
  role: "system" | "user" | "tool";
  content: unknown;
}

export interface ToolObservation {
  type: "tool_result";
  callId: string;
  toolName: string;
  status: "ok" | "error";
  output?: unknown;
  error?: string;
  metadata: Record<string, unknown>;
}

export interface HistoricalToolResultPlaceholder {
  replacementKind: "historical_tool_result_placeholder";
  toolName: string;
  originalHash: string;
  originalSize: number;
  summaryLabel: string;
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ContextFragment {
  id: string;
  role: RuntimeMessage["role"];
  content: unknown;
  priority: number;
  pinned: boolean;
  discardable: boolean;
  source: "system" | "user" | "tool";
  summaryKind: "instructions" | "workspace" | "task" | "observation" | "summary";
}

export interface InstructionSource {
  absolutePath: string;
  relativePath: string;
  scopeDepth: number;
  byteSize: number;
  rawText: string;
  normalizedText: string;
}

export interface InstructionFragment extends InstructionSource {
  priority: number;
  pinned: boolean;
}

export interface InstructionBundle {
  fragments: InstructionFragment[];
  sources: InstructionSource[];
  totalBytes: number;
  trimmed: boolean;
  trimmedSources: string[];
}

export type MemoryScope = "project" | "reference";

export type MemoryConfidence = "low" | "medium" | "high";

export type MemoryFreshness = "fresh" | "aging" | "stale";

export type MemoryLoadPolicy = "project_entry" | "on_demand" | "always" | "search_only";

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  content: string;
  sourceEventIds: string[];
  confidence: MemoryConfidence;
  freshness: MemoryFreshness;
  loadPolicy: MemoryLoadPolicy;
  tags?: string[];
  expiresAt?: string;
  conflictsWith?: string[];
  metadata?: Record<string, unknown>;
}

export interface MemoryQuery {
  scope?: MemoryScope;
  text?: string;
  tags?: string[];
  sourceEventIds?: string[];
}

export interface MemoryManager {
  write(record: MemoryRecord): Promise<MemoryRecord>;
  retrieve(query: MemoryQuery): Promise<MemoryRecord[]>;
  list(): Promise<MemoryRecord[]>;
}

export interface ContextBundle {
  sessionId: string;
  messages: RuntimeMessage[];
  fragments: ContextFragment[];
  toolDefinitions: ToolDefinition[];
  instructions: InstructionBundle;
  budgetReport: ContextBudgetReport;
}

export interface ModelAdapter {
  readonly provider?: string;
  readonly model?: string;
  estimateBudget?(request: ModelRequest): ContextBudgetReport;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface FakeModelAdapterConfig {
  provider: "fake";
  model: string;
  scriptedResponses?: ModelResponse[];
  contextWindow?: number;
  compactThreshold?: number;
}

export interface OpenAIModelAdapterConfig {
  provider: "openai";
  model: string;
  apiKey?: string;
  apiKeyEnvVar?: string;
  baseUrl?: string;
  contextWindow?: number;
  compactThreshold?: number;
}

export interface AnthropicModelAdapterConfig {
  provider: "anthropic";
  model: string;
  apiKey?: string;
  apiKeyEnvVar?: string;
  baseUrl?: string;
  contextWindow?: number;
  compactThreshold?: number;
  maxTokens?: number;
}

export type ModelAdapterConfig = FakeModelAdapterConfig | OpenAIModelAdapterConfig | AnthropicModelAdapterConfig;

export type PermissionDecision =
  | { kind: "allow"; reason: string; snapshot: Record<string, unknown> }
  | { kind: "ask"; reason: string; snapshot: Record<string, unknown> }
  | { kind: "deny"; reason: string; snapshot: Record<string, unknown> };

type AgentEventBase = {
  id: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
};

export type AgentEvent =
  | (AgentEventBase & { type: "UserMessage"; text: string })
  | (AgentEventBase & { type: "ContextBuilt"; messageCount: number; toolCount: number })
  | (AgentEventBase & { type: "InstructionsResolved"; appliedSources: string[]; totalBytes: number })
  | (AgentEventBase & { type: "InstructionsTrimmed"; trimmedSources: string[]; totalBytes: number })
  | (AgentEventBase & {
      type: "ContextCompacted";
      tier: Exclude<CompactionTier, "none">;
      beforeUnits: number;
      afterUnits: number;
      retainedConstraintHash: string;
      discardedClasses: string[];
      summaryHash: string;
    })
  | (AgentEventBase & { type: "ModelRequestStarted"; provider: string; model: string })
  | (AgentEventBase & { type: "ModelResponseReceived"; finalMessage: boolean; toolCallCount: number })
  | (AgentEventBase & { type: "ModelError"; provider: string; model: string; code: string; message: string })
  | (AgentEventBase & { type: "TurnAborted"; reason: string })
  | (AgentEventBase & { type: "PermissionEvaluated"; callId: string; toolName: string; decision: PermissionDecision["kind"]; reason: string })
  | (AgentEventBase & { type: "ToolCallStarted"; callId: string; toolName: string; inputHash: string })
  | (AgentEventBase & { type: "ToolCallFinished"; callId: string; toolName: string; status: "ok" | "error"; durationMs: number; outputHash: string; metadataHash: string; summary: string; errorSummary?: string })
  | (AgentEventBase & { type: "ToolResultInjected"; callId: string; toolName: string; status: "ok" | "error"; observationHash: string; summary: string; errorSummary?: string })
  | (AgentEventBase & { type: "AgentFinished"; reason: "final_message" | "tool_iteration_limit" | "model_error" | "aborted" });

export interface TurnResult {
  finalMessage: string;
  finishReason?: "final_message" | "tool_iteration_limit" | "model_error" | "aborted";
  nextAction?: {
    type: "approval_required";
    call: ToolCall;
    decision: PermissionDecision;
  };
  events: AgentEvent[];
}
