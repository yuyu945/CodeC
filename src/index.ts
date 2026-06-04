import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type ToolName = "read_file" | "search_text" | "edit_file" | "shell";

export interface WorkspacePolicy {
  cwd: string;
}

export interface TurnRequest {
  sessionId: string;
  userMessage: string;
  workspace: WorkspacePolicy;
}

export interface TurnResult {
  finalMessage: string;
  finishReason?: "final_message" | "tool_iteration_limit";
  nextAction?: {
    type: "approval_required";
    call: ToolCall;
    decision: PermissionDecision;
  };
  events: AgentEvent[];
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

export interface ModelAdapter {
  complete(context: ContextBundle): Promise<ModelResponse>;
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

export interface ContextBundle {
  sessionId: string;
  messages: RuntimeMessage[];
  toolDefinitions: ToolDefinition[];
  budgetReport: {
    mustCompact: boolean;
    messageCount: number;
  };
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
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
  | (AgentEventBase & { type: "ModelResponseReceived"; finalMessage: boolean; toolCallCount: number })
  | (AgentEventBase & { type: "PermissionEvaluated"; callId: string; toolName: string; decision: PermissionDecision["kind"]; reason: string })
  | (AgentEventBase & { type: "ToolCallStarted"; callId: string; toolName: string; inputHash: string })
  | (AgentEventBase & { type: "ToolCallFinished"; callId: string; toolName: string; status: "ok" | "error"; durationMs: number })
  | (AgentEventBase & { type: "ToolResultInjected"; callId: string; toolName: string; status: "ok" | "error" })
  | (AgentEventBase & { type: "AgentFinished"; reason: "final_message" | "tool_iteration_limit" });

export class JsonlEventStore {
  private readonly filePath: string;
  private sequences = new Map<string, number>();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async append(event: Omit<AgentEvent, "id" | "sequence" | "timestamp">): Promise<AgentEvent> {
    const sessionId = event.sessionId;
    const nextSequence = (this.sequences.get(sessionId) ?? (await this.loadLastSequence(sessionId))) + 1;
    this.sequences.set(sessionId, nextSequence);
    const fullEvent = {
      ...event,
      id: randomUUID(),
      sequence: nextSequence,
      timestamp: new Date().toISOString(),
    } as AgentEvent;

    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(fullEvent)}\n`, "utf8");
    return fullEvent;
  }

  async forSession(sessionId: string): Promise<AgentEvent[]> {
    const all = await this.readAll();
    return all.filter((event) => event.sessionId === sessionId).sort((a, b) => a.sequence - b.sequence);
  }

  private async loadLastSequence(sessionId: string): Promise<number> {
    const events = await this.forSession(sessionId);
    return events.at(-1)?.sequence ?? 0;
  }

  private async readAll(): Promise<AgentEvent[]> {
    try {
      const text = await readFile(this.filePath, "utf8");
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AgentEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

export class ContextBuilder {
  private readonly observations = new Map<string, ToolObservation[]>();

  build(request: TurnRequest): ContextBundle {
    const observations = this.observations.get(request.sessionId) ?? [];
    return {
      sessionId: request.sessionId,
      messages: [
        {
          role: "system",
          content: "MVP-0 single-agent runtime. Use only declared tools. Tool results are typed observations.",
        },
        {
          role: "system",
          content: {
            workspace: request.workspace.cwd,
            constraints: ["no memory", "no multi-agent", "no retrieval", "no IDE/TUI/API surface"],
          },
        },
        { role: "user", content: request.userMessage },
        ...observations.map((observation) => ({ role: "tool" as const, content: observation })),
      ],
      toolDefinitions: toolDefinitions(),
      budgetReport: {
        mustCompact: false,
        messageCount: 3 + observations.length,
      },
    };
  }

  injectToolResult(context: ContextBundle, call: ToolCall, result: ToolResult): ContextBundle {
    const observation: ToolObservation = {
      type: "tool_result",
      callId: call.id,
      toolName: call.name,
      status: result.ok ? "ok" : "error",
      output: capStructuredValue(result.output),
      error: result.error ? capString(result.error) : undefined,
      metadata: {
        ...result.metadata,
        outputHash: hashJson(result.output ?? result.error ?? ""),
      },
    };
    const sessionObservations = this.observations.get(context.sessionId) ?? [];
    sessionObservations.push(observation);
    this.observations.set(context.sessionId, sessionObservations);
    return {
      ...context,
      messages: [...context.messages, { role: "tool", content: observation }],
      budgetReport: {
        mustCompact: false,
        messageCount: context.messages.length + 1,
      },
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
}

export class PermissionManager {
  private readonly options: { allowEdits?: boolean };

  constructor(options: { allowEdits?: boolean } = {}) {
    this.options = options;
  }

  async evaluate(call: ToolCall, workspace: WorkspacePolicy): Promise<PermissionDecision> {
    const snapshot = { cwd: workspace.cwd, policy: "mvp0" };
    if (!isKnownTool(call.name)) return { kind: "deny", reason: "unknown_tool", snapshot };

    if (call.name === "shell") {
      const command = stringInput(call.input.command);
      if (!command) return { kind: "deny", reason: "missing_command", snapshot };
      if (isDeniedShell(command)) return { kind: "deny", reason: "risky_shell_command", snapshot };
      if (isAllowedShell(command)) return { kind: "allow", reason: "read_only_shell_command", snapshot };
      return { kind: "ask", reason: "shell_requires_approval", snapshot };
    }

    const pathValue = stringInput(call.input.path) ?? ".";
    if (!isInsideWorkspace(pathValue, workspace.cwd)) {
      return { kind: "deny", reason: "path_outside_workspace", snapshot };
    }

    if (call.name === "edit_file") {
      return this.options.allowEdits
        ? { kind: "allow", reason: "test_policy_allows_edit", snapshot }
        : { kind: "ask", reason: "edit_requires_approval", snapshot };
    }

    return { kind: "allow", reason: "workspace_read", snapshot };
  }
}

export class ToolExecutor {
  private readonly options: { timeoutMs?: number; outputLimit?: number; maxSearchMatches?: number };

  constructor(options: { timeoutMs?: number; outputLimit?: number; maxSearchMatches?: number } = {}) {
    this.options = options;
  }

  async execute(call: ToolCall, context: WorkspacePolicy): Promise<ToolResult> {
    const started = performance.now();
    try {
      if (!isKnownTool(call.name)) {
        return toolError(call, "unknown_tool", started);
      }
      if (call.name === "read_file") return await this.readFile(call, context, started);
      if (call.name === "search_text") return await this.searchText(call, context, started);
      if (call.name === "edit_file") return await this.editFile(call, context, started);
      return await this.shell(call, context, started);
    } catch (error) {
      return toolError(call, error instanceof Error ? error.message : String(error), started);
    }
  }

  private async readFile(call: ToolCall, context: WorkspacePolicy, started: number): Promise<ToolResult> {
    const pathValue = requireString(call.input.path, "path");
    const absolute = resolveWorkspacePath(pathValue, context.cwd);
    const text = await readFile(absolute, "utf8");
    return {
      callId: call.id,
      toolName: call.name,
      ok: true,
      output: { path: pathValue, text: capString(text, this.options.outputLimit) },
      metadata: { bytes: Buffer.byteLength(text), hash: hashString(text) },
      durationMs: elapsed(started),
    };
  }

  private async searchText(call: ToolCall, context: WorkspacePolicy, started: number): Promise<ToolResult> {
    const pattern = requireString(call.input.pattern, "pattern");
    const pathValue = stringInput(call.input.path) ?? ".";
    const root = resolveWorkspacePath(pathValue, context.cwd);
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const matcher = new RegExp(escapeRegExp(pattern));
    const maxMatches = this.options.maxSearchMatches ?? 25;

    for (const file of await listFiles(root)) {
      if (matches.length >= maxMatches) break;
      const text = await readFile(file, "utf8").catch(() => "");
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < maxMatches; index++) {
        if (matcher.test(lines[index])) {
          matches.push({
            path: normalizeRelative(context.cwd, file),
            line: index + 1,
            text: capString(lines[index], 300),
          });
        }
      }
    }

    return {
      callId: call.id,
      toolName: call.name,
      ok: true,
      output: { pattern, matches },
      metadata: { matchCount: matches.length, capped: matches.length >= maxMatches },
      durationMs: elapsed(started),
    };
  }

  private async editFile(call: ToolCall, context: WorkspacePolicy, started: number): Promise<ToolResult> {
    const pathValue = requireString(call.input.path, "path");
    const content = requireString(call.input.content, "content");
    const absolute = resolveWorkspacePath(pathValue, context.cwd);
    const before = await readFile(absolute, "utf8").catch(() => "");
    await writeFile(absolute, content, "utf8");
    return {
      callId: call.id,
      toolName: call.name,
      ok: true,
      output: { path: pathValue, bytesWritten: Buffer.byteLength(content) },
      metadata: { beforeHash: hashString(before), afterHash: hashString(content) },
      durationMs: elapsed(started),
    };
  }

  private async shell(call: ToolCall, context: WorkspacePolicy, started: number): Promise<ToolResult> {
    const command = requireString(call.input.command, "command");
    const result = await runShell(command, context.cwd, this.options.timeoutMs ?? 10_000, this.options.outputLimit ?? 8_000);
    return {
      callId: call.id,
      toolName: call.name,
      ok: result.exitCode === 0,
      output: result,
      error: result.exitCode === 0 ? undefined : `exit_code_${result.exitCode}`,
      metadata: { commandHash: hashString(command), timedOut: result.timedOut },
      durationMs: elapsed(started),
    };
  }
}

export class AgentRuntime {
  private readonly deps: {
    model: ModelAdapter;
    eventStore: JsonlEventStore;
    contextBuilder: ContextBuilder;
    permissionManager: PermissionManager;
    toolExecutor: ToolExecutor;
    limits?: { maxToolIterations?: number };
  };
  private readonly maxToolIterations: number;

  constructor(
    deps: {
      model: ModelAdapter;
      eventStore: JsonlEventStore;
      contextBuilder: ContextBuilder;
      permissionManager: PermissionManager;
      toolExecutor: ToolExecutor;
      limits?: { maxToolIterations?: number };
    },
  ) {
    this.deps = deps;
    this.maxToolIterations = deps.limits?.maxToolIterations ?? 8;
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    await this.deps.eventStore.append({ type: "UserMessage", sessionId: request.sessionId, text: request.userMessage });
    let context = this.deps.contextBuilder.build(request);
    await this.deps.eventStore.append({
      type: "ContextBuilt",
      sessionId: request.sessionId,
      messageCount: context.messages.length,
      toolCount: context.toolDefinitions.length,
    });

    for (let iteration = 0; iteration < this.maxToolIterations; iteration++) {
      const response = await this.deps.model.complete(context);
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
        await this.deps.eventStore.append({
          type: "ToolCallFinished",
          sessionId: request.sessionId,
          callId: call.id,
          toolName: call.name,
          status: result.ok ? "ok" : "error",
          durationMs: result.durationMs,
        });
        context = this.deps.contextBuilder.injectToolResult(context, call, result);
        await this.deps.eventStore.append({
          type: "ToolResultInjected",
          sessionId: request.sessionId,
          callId: call.id,
          toolName: call.name,
          status: result.ok ? "ok" : "error",
        });
      }
    }

    await this.deps.eventStore.append({ type: "AgentFinished", sessionId: request.sessionId, reason: "tool_iteration_limit" });
    return {
      finalMessage: "Stopped: tool iteration limit reached.",
      finishReason: "tool_iteration_limit",
      events: await this.deps.eventStore.forSession(request.sessionId),
    };
  }
}

export class Replay {
  static fromEvents(events: AgentEvent[]) {
    const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
    const starts = new Map<string, Extract<AgentEvent, { type: "ToolCallStarted" }>>();
    const finishes = new Map<string, Extract<AgentEvent, { type: "ToolCallFinished" }>>();
    const permissions = new Set<string>();
    let injectedBeforeNextModelCall = true;
    const pendingResults = new Set<string>();

    for (const event of sorted) {
      if (event.type === "PermissionEvaluated") permissions.add(event.callId);
      if (event.type === "ToolCallStarted") starts.set(event.callId, event);
      if (event.type === "ToolCallFinished") {
        finishes.set(event.callId, event);
        pendingResults.add(event.callId);
      }
      if (event.type === "ToolResultInjected") pendingResults.delete(event.callId);
      if (event.type === "ModelResponseReceived" && pendingResults.size > 0) injectedBeforeNextModelCall = false;
    }

    const toolPairs = [...starts.values()].map((start) => {
      const finish = finishes.get(start.callId);
      return {
        callId: start.callId,
        toolName: start.toolName,
        status: finish?.status ?? "error",
      };
    });

    return {
      events: sorted,
      toolPairs,
      hasPermissionForEveryToolCall: [...starts.keys()].every((callId) => permissions.has(callId)),
      toolResultsInjectedBeforeNextModelCall: injectedBeforeNextModelCall,
    };
  }
}

function toolDefinitions(): ToolDefinition[] {
  return [
    { name: "shell", description: "Run an approved read-only shell command in the workspace.", inputSchema: { command: "string" } },
    { name: "read_file", description: "Read a UTF-8 file inside the workspace.", inputSchema: { path: "string" } },
    { name: "edit_file", description: "Replace a UTF-8 file inside the workspace.", inputSchema: { path: "string", content: "string" } },
    { name: "search_text", description: "Search workspace files for literal text.", inputSchema: { pattern: "string", path: "string?" } },
  ];
}

function validateToolCall(call: ToolCall): string | undefined {
  if (!call.id) return "missing_call_id";
  if (!isKnownTool(call.name)) return "unknown_tool";
  if (call.name === "shell" && !stringInput(call.input.command)) return "invalid_shell_input";
  if (call.name === "read_file" && !stringInput(call.input.path)) return "invalid_read_file_input";
  if (call.name === "edit_file" && (!stringInput(call.input.path) || stringInput(call.input.content) === undefined)) {
    return "invalid_edit_file_input";
  }
  if (call.name === "search_text" && !stringInput(call.input.pattern)) return "invalid_search_text_input";
  return undefined;
}

function isKnownTool(name: string): name is ToolName {
  return name === "shell" || name === "read_file" || name === "edit_file" || name === "search_text";
}

function isInsideWorkspace(pathValue: string, cwd: string): boolean {
  try {
    resolveWorkspacePath(pathValue, cwd);
    return true;
  } catch {
    return false;
  }
}

function resolveWorkspacePath(pathValue: string, cwd: string): string {
  const workspace = resolve(cwd);
  const target = isAbsolute(pathValue) ? resolve(pathValue) : resolve(workspace, pathValue);
  const rel = relative(workspace, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return target;
  throw new Error("path_outside_workspace");
}

function normalizeRelative(cwd: string, absolutePath: string): string {
  return relative(resolve(cwd), absolutePath).replaceAll("\\", "/");
}

async function listFiles(root: string): Promise<string[]> {
  const info = await stat(root);
  if (info.isFile()) return [root];
  const found: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".events.jsonl") continue;
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await listFiles(absolute)));
    if (entry.isFile()) found.push(absolute);
  }
  return found;
}

function requireString(value: unknown, name: string): string {
  const result = stringInput(value);
  if (result === undefined) throw new Error(`missing_${name}`);
  return result;
}

function stringInput(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isAllowedShell(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  return /^(node|npm\.cmd|npm|git|dir|ls|pwd|echo|type|cat|where|whoami)(\s|$)/.test(trimmed) && !isDeniedShell(command) && trimmed !== "git status";
}

function isDeniedShell(command: string): boolean {
  const lowered = command.toLowerCase();
  return /\b(rm|del|erase|rmdir|move|mv|copy|cp|curl|wget|ssh|scp|git\s+(reset|clean|push|commit|checkout|switch|merge|rebase)|set-content|out-file|new-item|remove-item)\b/.test(
    lowered,
  );
}

async function runShell(command: string, cwd: string, timeoutMs: number, outputLimit: number) {
  await access(cwd, constants.R_OK);
  return await new Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolvePromise) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = capString(stdout + String(chunk), outputLimit);
    });
    child.stderr.on("data", (chunk) => {
      stderr = capString(stderr + String(chunk), outputLimit);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: timedOut ? -1 : code, stdout, stderr, timedOut });
    });
  });
}

function toolError(call: ToolCall, error: string, started: number): ToolResult {
  return {
    callId: call.id,
    toolName: call.name,
    ok: false,
    error,
    metadata: {},
    durationMs: elapsed(started),
  };
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value: unknown): string {
  return hashString(JSON.stringify(value));
}

function capStructuredValue(value: unknown): unknown {
  if (typeof value === "string") return capString(value);
  if (Array.isArray(value)) return value.slice(0, 50).map(capStructuredValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, capStructuredValue(entry)]));
  }
  return value;
}

function capString(value: string, limit = 8_000): string {
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated:${value.length - limit}]` : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
