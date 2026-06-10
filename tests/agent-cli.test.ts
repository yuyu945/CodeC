import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  executeAgentCli,
  parseAgentCliArgv,
  runAgentRepl,
  type ModelResponse,
  type TurnResult,
} from "../src/index.ts";

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "codec-agent-cli-"));
  await writeFile(join(dir, "notes.txt"), "alpha\nbeta\n");
  return dir;
}

function createIo(lines: string[]) {
  const writes: string[] = [];
  let cursor = 0;
  return {
    io: {
      async readLine() {
        const line = lines[cursor];
        cursor += 1;
        return line;
      },
      write(text: string) {
        writes.push(text);
      },
      close() {},
    },
    output() {
      return writes.join("");
    },
  };
}

test("parseAgentCliArgv parses provider, model, cwd, and session options", () => {
  const parsed = parseAgentCliArgv([
    "--provider", "openai",
    "--model", "gpt-5-mini",
    "--cwd", "D:/workspace",
    "--session-id", "session-123",
    "--allow-edits",
    "--event-store-path", "events/custom.jsonl",
    "--base-url", "https://example.test/v1",
  ]);

  assert.equal(parsed.provider, "openai");
  assert.equal(parsed.model, "gpt-5-mini");
  assert.equal(parsed.cwd, "D:/workspace");
  assert.equal(parsed.sessionId, "session-123");
  assert.equal(parsed.allowEdits, true);
  assert.equal(parsed.eventStorePath, "events/custom.jsonl");
  assert.equal(parsed.baseUrl, "https://example.test/v1");
});

test("executeAgentCli rejects unsupported provider values deterministically", async () => {
  const result = await executeAgentCli(["--provider", "fake", "--model", "test-model"]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "agent_cli_invalid_provider\n");
});

test("runAgentRepl routes only plain input into runTurn while slash commands stay local", async () => {
  const cwd = await workspace();
  const { io, output } = createIo(["/help", "/status", "hello runtime", "/exit"]);
  const runTurnCalls: string[] = [];

  const result = await runAgentRepl(
    {
      provider: "openai",
      model: "gpt-5-mini",
      cwd,
      sessionId: "session-repl-local",
      eventStorePath: join(cwd, ".events.jsonl"),
      allowEdits: false,
    },
    {
      io,
      runtimeFactory() {
        return {
          async runTurn(request: { userMessage: string }): Promise<TurnResult> {
            runTurnCalls.push(request.userMessage);
            return { finalMessage: "reply from runtime", finishReason: "final_message", events: [], memorySuggestions: [] };
          },
          async resumeAfterApproval(): Promise<TurnResult> {
            return { finalMessage: "unexpected", events: [], memorySuggestions: [] };
          },
          getPendingApproval() {
            return undefined;
          },
        } as never;
      },
      modelAdapterFactory() {
        throw new Error("modelAdapterFactory should not be called when runtimeFactory is stubbed");
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(runTurnCalls, ["hello runtime"]);
  assert.match(output(), /\[system\] Agent REPL ready\./);
  assert.match(output(), /\[system\] Commands:/);
  assert.match(output(), /\/status +Show current session state/);
  assert.match(output(), /\[status\]/);
  assert.match(output(), /provider: openai/);
  assert.match(output(), /session_id: session-repl-local/);
  assert.match(output(), /\[assistant\] reply from runtime/);
});

test("runAgentRepl supports fake-model approval allow flow through the application seam", async () => {
  const cwd = await workspace();
  const { io, output } = createIo(["please edit notes", "/allow", "/exit"]);
  let modelCalls = 0;

  const result = await runAgentRepl(
    {
      provider: "openai",
      model: "gpt-5-mini",
      cwd,
      eventStorePath: join(cwd, ".events.jsonl"),
      allowEdits: false,
    },
    {
      io,
      sessionIdFactory() {
        return "session-repl-allow";
      },
      modelAdapterFactory() {
        return {
          provider: "fake",
          model: "fake-repl",
          async complete(): Promise<ModelResponse> {
            modelCalls += 1;
            if (modelCalls === 1) {
              return {
                toolCalls: [{ id: "call-edit-repl", name: "edit_file", input: { path: "notes.txt", content: "changed\n" } }],
              };
            }
            return { finalMessage: "repl allow complete" };
          },
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(await readFile(join(cwd, "notes.txt"), "utf8"), "changed\n");
  assert.match(output(), /\[approval\] Pending tool execution/);
  assert.match(output(), /tool: edit_file/);
  assert.match(output(), /target: notes\.txt/);
  assert.match(output(), /next: use \/allow to run it, or \/deny to reject it\./);
  assert.match(output(), /\[assistant\] repl allow complete/);
});

test("runAgentRepl reports deterministic messages for slash approval commands without pending state", async () => {
  const cwd = await workspace();
  const { io, output } = createIo(["/allow", "/deny", "/exit"]);

  const result = await runAgentRepl(
    {
      provider: "anthropic",
      model: "claude-sonnet-test",
      cwd,
      sessionId: "session-no-pending",
      eventStorePath: join(cwd, ".events.jsonl"),
      allowEdits: false,
    },
    {
      io,
      runtimeFactory() {
        return {
          async runTurn(): Promise<TurnResult> {
            return { finalMessage: "unused", events: [], memorySuggestions: [] };
          },
          async resumeAfterApproval(): Promise<TurnResult> {
            return { finalMessage: "Cannot resume: no pending approval for session session-no-pending.", events: [], memorySuggestions: [] };
          },
          getPendingApproval() {
            return undefined;
          },
        } as never;
      },
      modelAdapterFactory() {
        throw new Error("modelAdapterFactory should not be called when runtimeFactory is stubbed");
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(output(), /\[assistant\] Cannot resume: no pending approval for session session-no-pending\./);
});

test("runAgentRepl prints short runtime error summaries without exposing provider response bodies", async () => {
  const cwd = await workspace();
  const { io, output } = createIo(["hello", "/exit"]);

  const result = await runAgentRepl(
    {
      provider: "openai",
      model: "gpt-5-mini",
      cwd,
      sessionId: "session-short-error",
      eventStorePath: join(cwd, ".events.jsonl"),
      allowEdits: false,
    },
    {
      io,
      runtimeFactory() {
        return {
          async runTurn(): Promise<TurnResult> {
            return {
              finalMessage: "Stopped: model error (provider_balance_failed). Provider account balance is insufficient.",
              finishReason: "model_error",
              events: [],
              memorySuggestions: [],
            };
          },
          async resumeAfterApproval(): Promise<TurnResult> {
            return { finalMessage: "unused", events: [], memorySuggestions: [] };
          },
          getPendingApproval() {
            return undefined;
          },
        } as never;
      },
      modelAdapterFactory() {
        throw new Error("modelAdapterFactory should not be called when runtimeFactory is stubbed");
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(output(), /\[assistant\] Stopped: model error \(provider_balance_failed\)\. Provider account balance is insufficient\./);
  assert.doesNotMatch(output(), /Insufficient account balance.*bad_response_status_code/);
});

test("runAgentRepl exposes /diagnose-provider and does not route it into runTurn", async () => {
  const cwd = await workspace();
  const { io, output } = createIo(["/help", "/diagnose-provider", "/exit"]);
  let runTurnCalls = 0;
  let providerCalls = 0;

  const result = await runAgentRepl(
    {
      provider: "openai",
      model: "gpt-5-mini",
      cwd,
      sessionId: "session-diagnose",
      eventStorePath: join(cwd, ".events.jsonl"),
      allowEdits: false,
    },
    {
      io,
      runtimeFactory() {
        return {
          async runTurn(): Promise<TurnResult> {
            runTurnCalls += 1;
            return { finalMessage: "unexpected", events: [], memorySuggestions: [] };
          },
          async resumeAfterApproval(): Promise<TurnResult> {
            return { finalMessage: "unexpected", events: [], memorySuggestions: [] };
          },
          getPendingApproval() {
            return undefined;
          },
        } as never;
      },
      modelAdapterFactory() {
        return {
          provider: "fake",
          model: "fake-diagnose",
          async complete(request): Promise<ModelResponse> {
            providerCalls += 1;
            if (request.toolDefinitions.length === 0) return { finalMessage: "hello" };
            throw new Error("tool path blocked");
          },
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(runTurnCalls, 0);
  assert.equal(providerCalls, 2);
  assert.match(output(), /\[system\] Commands:/);
  assert.match(output(), /\[diagnostics\] Provider diagnosis/);
  assert.match(output(), /summary: Basic chat works, but tool-capable provider requests are failing on this route\./);
});

test("runAgentRepl retries transient provider request failures and can still answer the package.json scripts request", async () => {
  const cwd = await workspace();
  const { io, output } = createIo(["读取 package.json 并告诉我有哪些 npm scripts", "/exit"]);
  let calls = 0;

  const result = await runAgentRepl(
    {
      provider: "openai",
      model: "gpt-5-mini",
      cwd,
      sessionId: "session-retry-package-json",
      eventStorePath: join(cwd, ".events.jsonl"),
      allowEdits: false,
    },
    {
      io,
      modelAdapterFactory() {
        return {
          provider: "fake",
          model: "fake-retry",
          async complete(context): Promise<ModelResponse> {
            calls += 1;
            if (calls === 1) {
              throw new Error("unexpected proxy failure shape");
            }
            assert.deepEqual(context.toolDefinitions.map((tool) => tool.name), ["read_file"]);
            const toolMessages = context.messages.filter((message) => message.role === "tool");
            if (toolMessages.length === 0) {
              return { toolCalls: [{ id: "read-package-json", name: "read_file", input: { path: "package.json" } }] };
            }
            return { finalMessage: "npm scripts: test, agent, memory, memory:tui" };
          },
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(calls, 3);
  assert.match(output(), /\[assistant\] npm scripts: test, agent, memory, memory:tui/);
});

test("runAgentRepl answers the package.json scripts request locally without invoking runtime", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test", agent: "node agent-cli.ts", memory: "node memory-cli.ts", "memory:tui": "node memory-tui.ts" } }, null, 2));
  const { io, output } = createIo(["读取 package.json 并告诉我有哪些 npm scripts", "/exit"]);
  let runTurnCalls = 0;

  const result = await runAgentRepl(
    {
      provider: "openai",
      model: "gpt-5-mini",
      cwd,
      sessionId: "session-local-package-json",
      eventStorePath: join(cwd, ".events.jsonl"),
      allowEdits: false,
    },
    {
      io,
      runtimeFactory() {
        return {
          async runTurn(): Promise<TurnResult> {
            runTurnCalls += 1;
            return { finalMessage: "unexpected", events: [], memorySuggestions: [] };
          },
          async resumeAfterApproval(): Promise<TurnResult> {
            return { finalMessage: "unexpected", events: [], memorySuggestions: [] };
          },
          getPendingApproval() {
            return undefined;
          },
        } as never;
      },
      modelAdapterFactory() {
        throw new Error("modelAdapterFactory should not be called when runtimeFactory is stubbed");
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(runTurnCalls, 0);
  assert.match(output(), /\[local\] npm scripts: test, agent, memory, memory:tui/);
});

test("runAgentRepl can answer the package.json scripts request locally without creating a provider adapter", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test", agent: "node agent-cli.ts", memory: "node memory-cli.ts", "memory:tui": "node memory-tui.ts" } }, null, 2));
  const { io, output } = createIo(["读取 package.json 并告诉我有哪些 npm scripts", "/exit"]);
  let adapterCalls = 0;

  const result = await runAgentRepl(
    {
      provider: "openai",
      model: "gpt-5-mini",
      cwd,
      sessionId: "session-local-no-provider",
      eventStorePath: join(cwd, ".events.jsonl"),
      allowEdits: false,
    },
    {
      io,
      modelAdapterFactory() {
        adapterCalls += 1;
        throw new Error("modelAdapterFactory should not be called for local package.json scripts answer");
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(adapterCalls, 0);
  assert.match(output(), /\[local\] npm scripts: test, agent, memory, memory:tui/);
});
