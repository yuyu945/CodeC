export type ToolName = "read_file" | "search_text" | "edit_file" | "shell";

export interface WorkspacePolicy {
  cwd: string;
  root?: string;
}

export interface TurnRequest {
  sessionId: string;
  userMessage: string;
  workspace: WorkspacePolicy;
  memorySelections?: MemoryContextSelection[];
  abortSignal?: AbortSignal;
}

export interface ApprovalResumeRequest {
  sessionId: string;
  approvalId: string;
  resolution: "allow" | "deny";
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
  memorySuggestions?: MemoryWriteSuggestion[];
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
  summaryKind: "instructions" | "workspace" | "task" | "observation" | "memory" | "summary";
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
  applyMaintenance(request: MemoryMaintenanceApplyRequest): Promise<MemoryMaintenanceApplyResult>;
}

export interface RedactedMemoryRecord {
  id: string;
  scope: MemoryScope;
  content: string;
  confidence: MemoryConfidence;
  freshness: MemoryFreshness;
  loadPolicy: MemoryLoadPolicy;
  tags?: string[];
}

export interface MemoryContextSelection {
  manager: MemoryManager;
  query: MemoryQuery;
  maxRecords?: number;
}

export interface MemoryContextPayload {
  type: "memory_context";
  records: RedactedMemoryRecord[];
  selectedCount: number;
  truncated: boolean;
}

export interface MemoryWriteSuggestion {
  scope: MemoryScope;
  content: string;
  confidence: MemoryConfidence;
  freshness: MemoryFreshness;
  loadPolicy: MemoryLoadPolicy;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface MemoryMaintenanceIssue {
  type: "conflict";
  recordId: string;
  otherRecordId: string;
  reason: string;
}

export interface MemoryFreshnessSuggestion {
  recordId: string;
  currentFreshness: MemoryFreshness;
  suggestedFreshness: MemoryFreshness;
  reason: string;
}

export interface MemoryMaintenanceReport {
  checkedAt: string;
  issues: MemoryMaintenanceIssue[];
  freshnessSuggestions: MemoryFreshnessSuggestion[];
}

export interface MemoryMaintenanceOptions {
  now?: Date | string;
  agingAfterDays?: number;
  staleAfterDays?: number;
}

export interface MemoryMaintenanceApplyRequest {
  now?: Date | string;
  issues?: MemoryMaintenanceIssue[];
  freshnessSuggestions?: MemoryFreshnessSuggestion[];
}

export interface MemoryMaintenanceApplyResult {
  appliedAt: string;
  appliedConflictCount: number;
  appliedFreshnessCount: number;
  records: MemoryRecord[];
}

export interface MemoryInspectRequest {
  query?: MemoryQuery;
  includeMaintenance?: boolean;
  maintenanceOptions?: MemoryMaintenanceOptions;
}

export interface MemoryInspectResult {
  records: MemoryRecord[];
  maintenance?: MemoryMaintenanceReport;
}

export interface MemorySurface {
  inspect(request?: MemoryInspectRequest): Promise<MemoryInspectResult>;
  analyze(options?: MemoryMaintenanceOptions): Promise<MemoryMaintenanceReport>;
  apply(request: MemoryMaintenanceApplyRequest): Promise<MemoryMaintenanceApplyResult>;
}

export type MemoryCliCommand =
  | {
      type: "inspect";
      cwd: string;
      storePath?: string;
      query?: MemoryQuery;
      includeMaintenance?: boolean;
      maintenanceOptions?: MemoryMaintenanceOptions;
    }
  | {
      type: "analyze";
      cwd: string;
      storePath?: string;
      maintenanceOptions?: MemoryMaintenanceOptions;
    }
  | {
      type: "apply";
      cwd: string;
      storePath?: string;
      applyRequest: MemoryMaintenanceApplyRequest;
    };

export interface MemoryCliExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface MemoryTuiState {
  records: MemoryRecord[];
  maintenance: MemoryMaintenanceReport;
  visibleIssues: MemoryMaintenanceIssue[];
  visibleFreshnessSuggestions: MemoryFreshnessSuggestion[];
  selectedIssueKeys: string[];
  selectedFreshnessRecordIds: string[];
  scopeFilter?: MemoryScope;
  textFilter?: string;
  statusMessage: string;
}

export interface MemoryTuiResult {
  applied?: MemoryMaintenanceApplyResult;
  finalState: MemoryTuiState;
}

export type MemoryTuiCommand =
  | { type: "list" }
  | { type: "analyze" }
  | { type: "filter_scope"; scope?: MemoryScope }
  | { type: "filter_text"; text?: string }
  | { type: "select_issue"; index: number }
  | { type: "select_freshness"; index: number }
  | { type: "apply" }
  | { type: "quit" };

export interface ContextBundle {
  sessionId: string;
  messages: RuntimeMessage[];
  fragments: ContextFragment[];
  toolDefinitions: ToolDefinition[];
  instructions: InstructionBundle;
  budgetReport: ContextBudgetReport;
}

export interface PendingApprovalSnapshot {
  approvalId: string;
  request: Pick<TurnRequest, "sessionId" | "workspace" | "abortSignal">;
  context: ContextBundle;
  iteration: number;
  pendingCall: ToolCall;
  remainingToolCalls: ToolCall[];
  memorySuggestions: MemoryWriteSuggestion[];
  decision: PermissionDecision;
}

export interface PersistedPendingApprovalSnapshot {
  approvalId: string;
  sessionId: string;
  context: ContextBundle;
  iteration: number;
  pendingCall: ToolCall;
  remainingToolCalls: ToolCall[];
  memorySuggestions: MemoryWriteSuggestion[];
  decision: PermissionDecision;
  workspace: WorkspacePolicy;
}

export interface PersistedSessionMetadata {
  provider: "openai" | "anthropic";
  model: string;
  cwd: string;
  eventStorePath: string;
  allowEdits: boolean;
  baseUrl?: string;
}

export interface PersistedSessionState {
  updatedAt: string;
  metadata: PersistedSessionMetadata;
  pending: PersistedPendingApprovalSnapshot;
}

export interface ResumeCandidate {
  sessionId: string;
  approvalId: string;
  toolName: string;
  updatedAt: string;
  metadata: PersistedSessionMetadata;
}

export interface SessionStateStore {
  savePending(snapshot: PersistedPendingApprovalSnapshot, metadata: PersistedSessionMetadata): Promise<void>;
  listPending(): Promise<ResumeCandidate[]>;
  loadPending(sessionId: string): Promise<PersistedSessionState | undefined>;
  clearPending(sessionId: string): Promise<void>;
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

export interface AgentCliOptions {
  provider: "openai" | "anthropic";
  model: string;
  cwd: string;
  sessionId?: string;
  eventStorePath?: string;
  allowEdits: boolean;
  baseUrl?: string;
}

export interface AgentCliExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProviderProbeResult {
  status: "ok" | "failed";
  code?: string;
  summary: string;
}

export interface ProviderCompatibilityReport {
  textProbe: ProviderProbeResult;
  toolProbe: ProviderProbeResult;
  summary: string;
  details: string[];
}

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
  | (AgentEventBase & { type: "ApprovalPending"; approvalId: string; callId: string; toolName: string; remainingToolCallCount: number })
  | (AgentEventBase & { type: "ApprovalResolved"; approvalId: string; resolution: ApprovalResumeRequest["resolution"] })
  | (AgentEventBase & { type: "TurnResumed"; approvalId: string; resumedFromCallId: string; remainingToolCallCount: number })
  | (AgentEventBase & { type: "ToolCallStarted"; callId: string; toolName: string; inputHash: string })
  | (AgentEventBase & { type: "ToolCallFinished"; callId: string; toolName: string; status: "ok" | "error"; durationMs: number; outputHash: string; metadataHash: string; summary: string; errorSummary?: string })
  | (AgentEventBase & { type: "ToolResultInjected"; callId: string; toolName: string; status: "ok" | "error"; observationHash: string; summary: string; errorSummary?: string })
  | (AgentEventBase & { type: "AgentFinished"; reason: "final_message" | "tool_iteration_limit" | "model_error" | "aborted" });

export interface TurnResult {
  finalMessage: string;
  finishReason?: "final_message" | "tool_iteration_limit" | "model_error" | "aborted";
  nextAction?: {
    type: "approval_required";
    approvalId: string;
    call: ToolCall;
    decision: PermissionDecision;
  };
  events: AgentEvent[];
  memorySuggestions?: MemoryWriteSuggestion[];
}
