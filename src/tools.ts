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
    { name: "shell", description: "Run an approved read-only shell command in the workspace.", inputSchema: { command: "string" } },
    { name: "read_file", description: "Read a UTF-8 file inside the workspace.", inputSchema: { path: "string" } },
    { name: "edit_file", description: "Replace a UTF-8 file inside the workspace.", inputSchema: { path: "string", content: "string" } },
    { name: "search_text", description: "Search workspace files for literal text.", inputSchema: { pattern: "string", path: "string?" } },
  ];
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
