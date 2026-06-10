import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";

import type { ToolCall, ToolDefinition, ToolName, ToolResult, WorkspacePolicy } from "./types.ts";
import { capString, elapsed, escapeRegExp, hashString, redactSecretsInString, redactStructuredValue, requireString, stringInput } from "./shared.ts";
import { listFiles, normalizeRelative, resolveWorkspacePath } from "./workspace.ts";

export class ToolExecutor {
  private readonly options: { timeoutMs?: number; outputLimit?: number; maxSearchMatches?: number; maxSearchFiles?: number; maxFileBytes?: number };

  constructor(options: { timeoutMs?: number; outputLimit?: number; maxSearchMatches?: number; maxSearchFiles?: number; maxFileBytes?: number } = {}) {
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
    const redacted = redactSecretsInString(capString(text, this.options.outputLimit));
    return {
      callId: call.id,
      toolName: call.name,
      ok: true,
      output: { path: pathValue, text: redacted.text },
      metadata: { bytes: Buffer.byteLength(text), hash: hashString(text), redacted: redacted.redacted },
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
    let redacted = false;
    const fileSearch = await listFiles(root, {
      maxFiles: this.options.maxSearchFiles ?? 500,
      maxFileBytes: this.options.maxFileBytes ?? 256_000,
    });

    for (const file of fileSearch.files) {
      if (matches.length >= maxMatches) break;
      const text = await readFile(file, "utf8").catch(() => "");
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < maxMatches; index++) {
        if (matcher.test(lines[index])) {
          const line = redactSecretsInString(capString(lines[index], 300));
          redacted = redacted || line.redacted;
          matches.push({
            path: normalizeRelative(context.cwd, file),
            line: index + 1,
            text: line.text,
          });
        }
      }
    }

    return {
      callId: call.id,
      toolName: call.name,
      ok: true,
      output: { pattern, matches },
      metadata: {
        matchCount: matches.length,
        capped: matches.length >= maxMatches,
        scannedFiles: fileSearch.scannedFiles,
        skippedLargeFiles: fileSearch.skippedLargeFiles,
        budgetExceeded: fileSearch.budgetExceeded,
        redacted,
      },
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
    const stdout = redactSecretsInString(result.stdout);
    const stderr = redactSecretsInString(result.stderr);
    return {
      callId: call.id,
      toolName: call.name,
      ok: result.exitCode === 0,
      output: { ...result, stdout: stdout.text, stderr: stderr.text },
      error: result.exitCode === 0 ? undefined : `exit_code_${result.exitCode}`,
      metadata: { commandHash: hashString(command), timedOut: result.timedOut, redacted: stdout.redacted || stderr.redacted },
      durationMs: elapsed(started),
    };
  }
}

export function toolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "shell",
      description: "Run an approved read-only shell command in the workspace.",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
    },
    {
      name: "read_file",
      description: "Read a UTF-8 file inside the workspace.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "edit_file",
      description: "Replace a UTF-8 file inside the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    {
      name: "search_text",
      description: "Search workspace files for literal text.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  ];
}

export function toolDefinitionsForUserMessage(userMessage: string): ToolDefinition[] {
  const normalized = userMessage.trim().toLowerCase();
  const all = toolDefinitions();

  if (isLikelyReadFileOnlyRequest(normalized)) {
    return all.filter((tool) => tool.name === "read_file");
  }
  if (isLikelyStructureReadRequest(normalized)) {
    return all.filter((tool) => tool.name === "read_file" || tool.name === "search_text");
  }

  return all;
}

export function normalizeToolCall(call: ToolCall): ToolCall {
  const baseInput =
    call.input && typeof call.input === "object" && !Array.isArray(call.input) && call.input.input && typeof call.input.input === "object"
      ? (call.input.input as Record<string, unknown>)
      : call.input;

  if (call.name === "read_file") {
    return { ...call, input: { path: firstStringLike(baseInput, ["path", "file", "filepath", "filename"]) } };
  }
  if (call.name === "search_text") {
    return {
      ...call,
      input: {
        pattern: firstStringLike(baseInput, ["pattern", "query", "text", "needle"]),
        path: firstStringLike(baseInput, ["path", "file", "filepath", "directory"]),
      },
    };
  }
  if (call.name === "shell") {
    return { ...call, input: { command: firstStringLike(baseInput, ["command", "cmd", "script"]) } };
  }
  if (call.name === "edit_file") {
    return {
      ...call,
      input: {
        path: firstStringLike(baseInput, ["path", "file", "filepath", "filename"]),
        content: firstStringLike(baseInput, ["content", "text", "contents", "value"]),
      },
    };
  }
  return call;
}

export function validateToolCall(call: ToolCall): string | undefined {
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

export function isKnownTool(name: string): name is ToolName {
  return name === "shell" || name === "read_file" || name === "edit_file" || name === "search_text";
}

export function isAllowedShell(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  return /^(node|npm\.cmd|npm|git|dir|ls|pwd|echo|type|cat|where|whoami)(\s|$)/.test(trimmed) && !isDeniedShell(command) && trimmed !== "git status";
}

export function isDeniedShell(command: string): boolean {
  const lowered = command.toLowerCase();
  return /\b(rm|del|erase|rmdir|move|mv|copy|cp|curl|wget|ssh|scp|git\s+(reset|clean|push|commit|checkout|switch|merge|rebase)|set-content|out-file|new-item|remove-item)\b/.test(
    lowered,
  );
}

function isLikelyReadFileOnlyRequest(message: string): boolean {
  const asksForScripts =
    (message.includes("package.json") && message.includes("script")) ||
    (message.includes("package.json") && message.includes("npm")) ||
    (message.includes("读取") && message.includes("package.json")) ||
    (message.includes("read") && message.includes("package.json"));
  const asksForSearch = message.includes("search") || message.includes("grep") || message.includes("查找") || message.includes("搜索");
  const asksForEdit =
    message.includes("edit") ||
    message.includes("write") ||
    message.includes("replace") ||
    message.includes("修改") ||
    message.includes("写入") ||
    message.includes("更新");
  const asksForShell =
    message.includes("shell") ||
    message.includes("command") ||
    message.includes("运行") ||
    message.includes("执行") ||
    message.includes("npm run") ||
    message.includes("node ");

  return asksForScripts && !asksForSearch && !asksForEdit && !asksForShell;
}

function isLikelyStructureReadRequest(message: string): boolean {
  const asksForStructure =
    message.includes("项目结构") ||
    message.includes("目录树") ||
    message.includes("仓库结构") ||
    message.includes("有哪些文件") ||
    message.includes("入口文件") ||
    message.includes("project structure") ||
    message.includes("directory tree") ||
    message.includes("repo structure") ||
    message.includes("repository structure");
  const asksForEdit =
    message.includes("edit") ||
    message.includes("write") ||
    message.includes("replace") ||
    message.includes("淇敼") ||
    message.includes("鍐欏叆");
  const asksForShell =
    message.includes("shell") ||
    message.includes("command") ||
    message.includes("杩愯") ||
    message.includes("鎵ц");
  return asksForStructure && !asksForEdit && !asksForShell;
}

function firstStringLike(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
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
  const redacted = redactSecretsInString(error);
  return {
    callId: call.id,
    toolName: call.name,
    ok: false,
    error: redacted.text,
    metadata: { redacted: redacted.redacted },
    durationMs: elapsed(started),
  };
}
