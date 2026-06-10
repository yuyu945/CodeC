import readline from "node:readline";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ContextBuilder } from "./context.ts";
import { JsonlEventStore } from "./events.ts";
import { createModelAdapter, probeProviderCompatibility } from "./models.ts";
import { PermissionManager } from "./permissions.ts";
import { AgentRuntime } from "./runtime.ts";
import { FileSessionStateStore } from "./session-state.ts";
import { ToolExecutor } from "./tools.ts";
import type {
  AgentCliExecutionResult,
  AgentCliOptions,
  ModelAdapter,
  ResumeCandidate,
  SessionStateStore,
  TurnRequest,
  TurnResult,
} from "./types.ts";

type AgentRuntimeLike = Pick<AgentRuntime, "runTurn" | "resumeAfterApproval" | "getPendingApproval" | "restorePersistedPending">;

type ReplIo = {
  readLine(): Promise<string | undefined>;
  write(text: string): void;
  close?(): void;
};

type OutputChannel = "system" | "assistant" | "local" | "approval" | "status" | "diagnostics";

export function parseAgentCliArgv(argv: string[]): AgentCliOptions {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error("agent_cli_invalid_flag");
    if (token === "--allow-edits") {
      flags.add(token);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("agent_cli_missing_flag_value");
    const existing = values.get(token) ?? [];
    existing.push(value);
    values.set(token, existing);
    index += 1;
  }

  const provider = singleRequired(values, "--provider", "agent_cli_requires_provider");
  if (provider !== "openai" && provider !== "anthropic") throw new Error("agent_cli_invalid_provider");
  const model = singleRequired(values, "--model", "agent_cli_requires_model");
  return {
    provider,
    model,
    cwd: singleOptional(values, "--cwd") ?? process.cwd(),
    sessionId: singleOptional(values, "--session-id"),
    eventStorePath: singleOptional(values, "--event-store-path"),
    allowEdits: flags.has("--allow-edits"),
    baseUrl: singleOptional(values, "--base-url"),
  };
}

export async function executeAgentCli(
  argv: string[],
  deps: {
    io?: ReplIo;
    runtimeFactory?: (options: AgentCliOptions, model: ModelAdapter) => AgentRuntimeLike;
    modelAdapterFactory?: (config: { provider: "openai" | "anthropic"; model: string; baseUrl?: string }) => ModelAdapter;
    sessionStateStoreFactory?: (options: AgentCliOptions) => SessionStateStore;
    sessionIdFactory?: () => string;
  } = {},
): Promise<AgentCliExecutionResult> {
  try {
    const options = parseAgentCliArgv(argv);
    if (!deps.io) {
      const result = await runAgentRepl(options, deps);
      return { exitCode: result.exitCode, stdout: "", stderr: "" };
    }

    const stdout: string[] = [];
    const result = await runAgentRepl(options, {
      ...deps,
      io: {
        ...deps.io,
        write(text: string) {
          stdout.push(text);
          deps.io?.write(text);
        },
      },
    });
    return { exitCode: result.exitCode, stdout: stdout.join(""), stderr: "" };
  } catch (error) {
    const message = normalizeCliError(error);
    return { exitCode: 1, stdout: "", stderr: `${message}\n` };
  }
}

export async function runAgentRepl(
  options: AgentCliOptions,
  deps: {
    io?: ReplIo;
    runtimeFactory?: (options: AgentCliOptions, model: ModelAdapter) => AgentRuntimeLike;
    modelAdapterFactory?: (config: { provider: "openai" | "anthropic"; model: string; baseUrl?: string }) => ModelAdapter;
    sessionStateStoreFactory?: (options: AgentCliOptions) => SessionStateStore;
    sessionIdFactory?: () => string;
  } = {},
): Promise<{ exitCode: number; sessionId: string }> {
  const io = deps.io ?? createReadlineIo();
  let currentOptions: AgentCliOptions = {
    ...options,
    sessionId: options.sessionId ?? deps.sessionIdFactory?.() ?? crypto.randomUUID(),
  };
  let runtime: AgentRuntimeLike | undefined;
  let adapter: ModelAdapter | undefined;
  let sessionStateStore: SessionStateStore | undefined;

  function currentEventStorePath(): string {
    return currentOptions.eventStorePath ?? join(currentOptions.cwd, ".events.jsonl");
  }

  function getAdapter(): ModelAdapter {
    adapter ??= (deps.modelAdapterFactory ?? ((config) => createModelAdapter(config)))({
      provider: currentOptions.provider,
      model: currentOptions.model,
      baseUrl: currentOptions.baseUrl,
    });
    return adapter;
  }

  function getSessionStateStore(): SessionStateStore {
    sessionStateStore ??= (deps.sessionStateStoreFactory ?? ((replOptions) => new FileSessionStateStore(join(replOptions.cwd, ".agent-session-state"))))(currentOptions);
    return sessionStateStore;
  }

  function getRuntime(): AgentRuntimeLike {
    runtime ??= deps.runtimeFactory
      ? deps.runtimeFactory(currentOptions, {
          provider: "fake",
          model: "runtime-factory-placeholder",
          async complete() {
            return { finalMessage: "" };
          },
        })
      : createRuntime(currentOptions, getAdapter(), getSessionStateStore());
    return runtime;
  }

  function switchActiveSession(nextOptions: AgentCliOptions): void {
    currentOptions = nextOptions;
    runtime = undefined;
    adapter = undefined;
    sessionStateStore = undefined;
  }

  writeChannel(io, "system", renderWelcome());

  while (true) {
    const line = await io.readLine();
    if (line === undefined) break;
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed === "/exit") break;
    if (trimmed === "/help") {
      writeChannel(io, "system", renderHelp());
      continue;
    }
    if (trimmed === "/status") {
      io.write(
        renderStatus({
          provider: currentOptions.provider,
          model: currentOptions.model,
          sessionId: currentOptions.sessionId ?? "unknown",
          cwd: currentOptions.cwd,
          eventStorePath: currentEventStorePath(),
          baseUrl: currentOptions.baseUrl,
          pendingApproval: runtime?.getPendingApproval(currentOptions.sessionId ?? "")?.approvalId,
        }),
      );
      continue;
    }
    if (trimmed === "/resume") {
      const candidates = await getSessionStateStore().listPending();
      io.write(renderResumeCandidates(candidates));
      continue;
    }
    if (trimmed.startsWith("/resume ")) {
      const selection = trimmed.slice("/resume ".length).trim();
      const candidates = await getSessionStateStore().listPending();
      const target = resolveResumeCandidate(candidates, selection);
      if (!target) {
        writeChannel(io, "assistant", "resume_session_not_found");
        continue;
      }
      const activeSessionId = currentOptions.sessionId ?? "";
      const activePending = runtime?.getPendingApproval(activeSessionId);
      if (activePending && target.sessionId !== activeSessionId) {
        writeChannel(io, "assistant", "cannot_switch_pending_session");
        continue;
      }
      const previousOptions = currentOptions;
      const previousRuntime = runtime;
      const previousAdapter = adapter;
      const previousStore = sessionStateStore;
      switchActiveSession({
        provider: target.metadata.provider,
        model: target.metadata.model,
        cwd: target.metadata.cwd,
        sessionId: target.sessionId,
        eventStorePath: target.metadata.eventStorePath,
        allowEdits: target.metadata.allowEdits,
        baseUrl: target.metadata.baseUrl,
      });
      try {
        const restored = await getRuntime().restorePersistedPending(target.sessionId);
        writeChannel(io, "local", `Restored pending approval for session ${target.sessionId}.`);
        io.write(renderApprovalRequired(restored.approvalId, restored.pendingCall.name, restored.pendingCall.input));
      } catch (error) {
        currentOptions = previousOptions;
        runtime = previousRuntime;
        adapter = previousAdapter;
        sessionStateStore = previousStore;
        writeChannel(io, "assistant", normalizeCliError(error));
      }
      continue;
    }
    if (trimmed === "/diagnose-provider") {
      io.write(renderProviderDiagnosis(await probeProviderCompatibility(getAdapter())));
      continue;
    }
    if (trimmed === "/allow" || trimmed === "/deny") {
      const activeRuntime = getRuntime();
      const activeSessionId = currentOptions.sessionId ?? "unknown";
      const pending = activeRuntime.getPendingApproval(activeSessionId);
      const result = await activeRuntime.resumeAfterApproval({
        sessionId: activeSessionId,
        approvalId: pending?.approvalId ?? `approval-missing-${activeSessionId}`,
        resolution: trimmed === "/allow" ? "allow" : "deny",
      });
      writeTurnResult(io, result);
      continue;
    }

    const localPackageScripts = await maybeAnswerPackageScriptsLocally(trimmed, currentOptions.cwd);
    if (localPackageScripts) {
      writeChannel(io, "local", localPackageScripts);
      continue;
    }

    const result = await getRuntime().runTurn({
      sessionId: currentOptions.sessionId ?? "unknown",
      userMessage: trimmed,
      workspace: { cwd: currentOptions.cwd },
    } satisfies TurnRequest);
    writeTurnResult(io, result);
  }

  io.close?.();
  return { exitCode: 0, sessionId: currentOptions.sessionId ?? "unknown" };
}

function createRuntime(options: AgentCliOptions, model: ModelAdapter, sessionStateStore: SessionStateStore): AgentRuntime {
  const eventStorePath = options.eventStorePath ?? join(options.cwd, ".events.jsonl");
  return new AgentRuntime({
    model,
    eventStore: new JsonlEventStore(eventStorePath),
    sessionStateStore,
    sessionMetadata: {
      provider: options.provider,
      model: options.model,
      cwd: options.cwd,
      eventStorePath,
      allowEdits: options.allowEdits,
      baseUrl: options.baseUrl,
    },
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager({ allowEdits: options.allowEdits }),
    toolExecutor: new ToolExecutor(),
    limits: { maxModelRetries: 2, modelRetryDelayMs: 75 },
  });
}

function writeTurnResult(io: ReplIo, result: TurnResult): void {
  if (result.nextAction?.type === "approval_required") {
    io.write(renderApprovalRequired(result.nextAction.approvalId, result.nextAction.call.name, result.nextAction.call.input));
  }
  if (result.finalMessage) {
    writeChannel(io, "assistant", result.finalMessage);
  }
}

function renderWelcome(): string {
  return ["Agent REPL ready.", "Type a normal message to run a turn.", "Type /help for commands."].join("\n");
}

function renderHelp(): string {
  return [
    "Commands:",
    "/help              Show available commands",
    "/status            Show current session state",
    "/resume [target]   List or restore a persisted pending session",
    "/diagnose-provider Probe basic text and tool-call compatibility",
    "/allow             Approve the pending tool action",
    "/deny              Reject the pending tool action",
    "/exit              Exit the REPL",
  ].join("\n");
}

function renderStatus(state: {
  provider: string;
  model: string;
  sessionId: string;
  cwd: string;
  eventStorePath: string;
  baseUrl?: string;
  pendingApproval?: string;
}): string {
  return [
    "[status]",
    `provider: ${state.provider}`,
    `model: ${state.model}`,
    `session_id: ${state.sessionId}`,
    `cwd: ${state.cwd}`,
    `event_store_path: ${state.eventStorePath}`,
    `base_url: ${state.baseUrl ?? "default"}`,
    `pending_approval: ${state.pendingApproval ?? "none"}`,
  ].join("\n") + "\n";
}

function renderProviderDiagnosis(report: { summary: string; details: string[] }): string {
  return [
    "[diagnostics] Provider diagnosis",
    `summary: ${report.summary}`,
    ...report.details,
  ].join("\n") + "\n";
}

function renderResumeCandidates(candidates: ResumeCandidate[]): string {
  if (candidates.length === 0) return "[local] Resumable sessions: none\n";
  return [
    "[local] Resumable sessions:",
    ...candidates.map((candidate, index) =>
      [
        `${index + 1}. ${candidate.sessionId}`,
        `   provider: ${candidate.metadata.provider}`,
        `   model: ${candidate.metadata.model}`,
        `   cwd: ${candidate.metadata.cwd}`,
        `   base_url: ${candidate.metadata.baseUrl ?? "default"}`,
        `   tool: ${candidate.toolName}`,
        `   updated_at: ${candidate.updatedAt}`,
      ].join("\n"),
    ),
  ].join("\n") + "\n";
}

function createReadlineIo(): ReplIo {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "agent> ",
  });
  return {
    async readLine() {
      return await new Promise<string | undefined>((resolveRead) => {
        rl.prompt();
        rl.once("line", (line) => resolveRead(line));
        rl.once("close", () => resolveRead(undefined));
      });
    },
    write(text: string) {
      process.stdout.write(text);
    },
    close() {
      rl.close();
    },
  };
}

function singleRequired(values: Map<string, string[]>, key: string, errorCode: string): string {
  const value = singleOptional(values, key);
  if (!value) throw new Error(errorCode);
  return value;
}

function singleOptional(values: Map<string, string[]>, key: string): string | undefined {
  const entries = values.get(key);
  if (!entries || entries.length === 0) return undefined;
  if (entries.length > 1) throw new Error("agent_cli_duplicate_flag");
  return entries[0];
}

function normalizeCliError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "agent_cli_failed";
}

function writeChannel(io: ReplIo, channel: OutputChannel, text: string): void {
  io.write(`[${channel}] ${text}\n`);
}

function resolveResumeCandidate(candidates: ResumeCandidate[], selection: string): ResumeCandidate | undefined {
  if (/^\d+$/.test(selection)) {
    const index = Number.parseInt(selection, 10) - 1;
    return candidates[index];
  }
  return candidates.find((candidate) => candidate.sessionId === selection);
}

function renderApprovalRequired(approvalId: string, toolName: string, input: Record<string, unknown>): string {
  const target = describeApprovalTarget(input);
  const risk = summarizeApprovalRisk(toolName);
  return [
    "[approval] Pending tool execution",
    `approval_id: ${approvalId}`,
    `tool: ${toolName}`,
    `target: ${target}`,
    `risk: ${risk}`,
    "next: use /allow to run it, or /deny to reject it.",
  ].join("\n") + "\n";
}

function describeApprovalTarget(input: Record<string, unknown>): string {
  if (typeof input.path === "string") return input.path;
  if (typeof input.command === "string") return input.command;
  if (typeof input.query === "string") return input.query;
  return "n/a";
}

function summarizeApprovalRisk(toolName: string): string {
  if (toolName === "edit_file") return "writes files in the workspace";
  if (toolName === "shell") return "runs a shell command in the workspace";
  return "requires confirmation before execution";
}

async function maybeAnswerPackageScriptsLocally(userMessage: string, cwd: string): Promise<string | undefined> {
  if (!isPackageScriptsRequest(userMessage)) return undefined;
  try {
    const packageJsonPath = join(cwd, "package.json");
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, unknown> };
    const scripts = parsed.scripts && typeof parsed.scripts === "object" ? Object.keys(parsed.scripts) : [];
    if (scripts.length === 0) return "npm scripts: none";
    return `npm scripts: ${scripts.join(", ")}`;
  } catch {
    return undefined;
  }
}

function isPackageScriptsRequest(userMessage: string): boolean {
  const normalized = userMessage.trim().toLowerCase();
  return (
    (normalized.includes("package.json") && normalized.includes("script")) ||
    (normalized.includes("package.json") && normalized.includes("npm")) ||
    (normalized.includes("读取") && normalized.includes("package.json"))
  );
}
