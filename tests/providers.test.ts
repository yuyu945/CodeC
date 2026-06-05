import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AgentRuntime,
  createAnthropicAdapter,
  ContextBuilder,
  createModelAdapter,
  createOpenAIResponsesAdapter,
  FakeModelAdapter,
  JsonlEventStore,
  PermissionManager,
  ProviderError,
  ToolExecutor,
  type ContextBundle,
  type ModelAdapterConfig,
  type ModelAdapter,
  type ModelResponse,
} from "../src/index.ts";

async function expectFinalMessageContract(adapter: ModelAdapter, expected: string) {
  const response = await adapter.complete({
    sessionId: "contract-final",
    messages: [{ role: "user", content: "hello" }],
    toolDefinitions: [],
    budgetReport: { mustCompact: false, messageCount: 1 },
  });
  assert.equal(response.finalMessage, expected);
  assert.equal(response.toolCalls, undefined);
}

async function expectToolCallContract(
  adapter: ModelAdapter,
  expected: { id: string; name: string; input: Record<string, unknown> },
) {
  const response = await adapter.complete({
    sessionId: "contract-tool",
    messages: [{ role: "user", content: "search it" }],
    toolDefinitions: [],
    budgetReport: { mustCompact: false, messageCount: 1 },
  });
  assert.deepEqual(response.toolCalls, [expected]);
  assert.equal(response.finalMessage, undefined);
}

test("FakeModelAdapter implements the shared adapter contract", async () => {
  const adapter = new FakeModelAdapter([
    { toolCalls: [{ id: "call-1", name: "read_file", input: { path: "notes.txt" } }] },
    { finalMessage: "done" },
  ]);

  const context: ContextBundle = {
    sessionId: "s1",
    messages: [{ role: "user", content: "read it" }],
    toolDefinitions: [],
    budgetReport: { mustCompact: false, messageCount: 1 },
  };

  const first = await adapter.complete(context);
  const second = await adapter.complete(context);

  assert.equal(first.toolCalls?.[0]?.name, "read_file");
  assert.equal(second.finalMessage, "done");
});

test("fake, OpenAI, and Anthropic adapters satisfy the canonical final-message contract", async () => {
  await expectFinalMessageContract(new FakeModelAdapter([{ finalMessage: "fake final" }]), "fake final");
  await expectFinalMessageContract(
    createOpenAIResponsesAdapter(
      { provider: "openai", model: "gpt-5-mini", apiKey: "test-key" },
      async () =>
        new Response(
          JSON.stringify({
            output: [{ type: "message", content: [{ type: "output_text", text: "openai final" }] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
    "openai final",
  );
  await expectFinalMessageContract(
    createAnthropicAdapter(
      { provider: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "test-key" },
      async () =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "anthropic final" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
    "anthropic final",
  );
});

test("fake, OpenAI, and Anthropic adapters satisfy the canonical tool-call contract", async () => {
  await expectToolCallContract(
    new FakeModelAdapter([{ toolCalls: [{ id: "fake-call", name: "search_text", input: { pattern: "mvp0" } }] }]),
    { id: "fake-call", name: "search_text", input: { pattern: "mvp0" } },
  );
  await expectToolCallContract(
    createOpenAIResponsesAdapter(
      { provider: "openai", model: "gpt-5-mini", apiKey: "test-key" },
      async () =>
        new Response(
          JSON.stringify({
            output: [{ type: "function_call", call_id: "openai-call", name: "search_text", arguments: "{\"pattern\":\"mvp0\"}" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
    { id: "openai-call", name: "search_text", input: { pattern: "mvp0" } },
  );
  await expectToolCallContract(
    createAnthropicAdapter(
      { provider: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "test-key" },
      async () =>
        new Response(
          JSON.stringify({
            content: [{ type: "tool_use", id: "anthropic-call", name: "search_text", input: { pattern: "mvp0" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
    { id: "anthropic-call", name: "search_text", input: { pattern: "mvp0" } },
  );
});

test("createModelAdapter resolves fake adapter config", () => {
  const config: ModelAdapterConfig = {
    provider: "fake",
    model: "deterministic",
    scriptedResponses: [{ finalMessage: "ok" }],
  };

  const adapter = createModelAdapter(config);
  assert.equal(adapter.constructor.name, "FakeModelAdapter");
});

test("createModelAdapter resolves Anthropic adapter config", () => {
  const config: ModelAdapterConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    apiKey: "test-key",
  };

  const adapter = createModelAdapter(config);
  assert.equal(adapter.constructor.name, "AnthropicAdapter");
});

test("OpenAI Responses adapter maps runtime context and tool definitions into Responses API payload", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;

  const adapter = createOpenAIResponsesAdapter(
    { provider: "openai", model: "gpt-5-mini", apiKey: "test-key", baseUrl: "https://example.test/v1" },
    async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return new Response(
        JSON.stringify({
          output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );

  const response = await adapter.complete({
    sessionId: "s-openai",
    messages: [
      { role: "system", content: "system rules" },
      { role: "user", content: "say hello" },
    ],
    toolDefinitions: [
      { name: "read_file", description: "read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
    ],
    budgetReport: { mustCompact: false, messageCount: 2 },
  });

  assert.equal(response.finalMessage, "hello");
  assert.equal(seenUrl, "https://example.test/v1/responses");
  assert.equal(seenInit?.method, "POST");

  const payload = JSON.parse(String(seenInit?.body));
  assert.equal(payload.model, "gpt-5-mini");
  assert.equal(payload.input[0].role, "system");
  assert.equal(payload.input[1].role, "user");
  assert.equal(payload.tools[0].name, "read_file");
});

test("Anthropic adapter maps runtime context and tool definitions into Messages API payload", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;

  const adapter = createAnthropicAdapter(
    { provider: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "test-key", baseUrl: "https://example.test/v1" },
    async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "hello from anthropic" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );

  const response = await adapter.complete({
    sessionId: "s-anthropic",
    messages: [
      { role: "system", content: "system rules" },
      { role: "user", content: "say hello" },
      { role: "tool", content: { type: "tool_result", callId: "toolu_1", toolName: "search_text", output: { ok: true } } },
    ],
    toolDefinitions: [
      { name: "read_file", description: "read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
    ],
    budgetReport: { mustCompact: false, messageCount: 3 },
  });

  assert.equal(response.finalMessage, "hello from anthropic");
  assert.equal(seenUrl, "https://example.test/v1/messages");
  assert.equal(seenInit?.method, "POST");

  const payload = JSON.parse(String(seenInit?.body));
  assert.equal(payload.model, "claude-sonnet-4-20250514");
  assert.equal(payload.system, "system rules");
  assert.equal(payload.messages[0].role, "user");
  assert.equal(payload.tools[0].name, "read_file");
});

test("OpenAI Responses adapter normalizes tool call output", async () => {
  const adapter = createOpenAIResponsesAdapter(
    { provider: "openai", model: "gpt-5-mini", apiKey: "test-key" },
    async () =>
      new Response(
        JSON.stringify({
          output: [
            {
              type: "function_call",
              call_id: "fc_1",
              name: "search_text",
              arguments: "{\"pattern\":\"mvp0\",\"path\":\".\"}",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );

  const response = await adapter.complete({
    sessionId: "s-tool",
    messages: [{ role: "user", content: "search it" }],
    toolDefinitions: [],
    budgetReport: { mustCompact: false, messageCount: 1 },
  });

  assert.deepEqual(response.toolCalls, [
    {
      id: "fc_1",
      name: "search_text",
      input: { pattern: "mvp0", path: "." },
    },
  ]);
});

test("Anthropic adapter normalizes tool call output", async () => {
  const adapter = createAnthropicAdapter(
    { provider: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "test-key" },
    async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "search_text",
              input: { pattern: "mvp0", path: "." },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );

  const response = await adapter.complete({
    sessionId: "s-anthropic-tool",
    messages: [{ role: "user", content: "search it" }],
    toolDefinitions: [],
    budgetReport: { mustCompact: false, messageCount: 1 },
  });

  assert.deepEqual(response.toolCalls, [
    {
      id: "toolu_1",
      name: "search_text",
      input: { pattern: "mvp0", path: "." },
    },
  ]);
});

test("OpenAI Responses adapter surfaces malformed provider output as ProviderError", async () => {
  const adapter = createOpenAIResponsesAdapter(
    { provider: "openai", model: "gpt-5-mini", apiKey: "test-key" },
    async () =>
      new Response(JSON.stringify({ output: [{ type: "function_call", call_id: "fc_1", name: "search_text", arguments: "{" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );

  await assert.rejects(
    adapter.complete({
      sessionId: "s-bad",
      messages: [{ role: "user", content: "search it" }],
      toolDefinitions: [],
      budgetReport: { mustCompact: false, messageCount: 1 },
    }),
    (error: unknown) => error instanceof ProviderError && error.code === "malformed_provider_response",
  );
});

test("OpenAI adapter config resolves api key from environment when not supplied inline", async () => {
  process.env.OPENAI_API_KEY = "env-test-key";
  try {
    const adapter = createModelAdapter({
      provider: "openai",
      model: "gpt-5-mini",
      baseUrl: "https://example.test/v1",
    });

    assert.equal(adapter.constructor.name, "OpenAIResponsesAdapter");
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test("Anthropic adapter config resolves api key from environment when not supplied inline", async () => {
  process.env.ANTHROPIC_API_KEY = "env-test-key";
  try {
    const adapter = createModelAdapter({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      baseUrl: "https://example.test/v1",
    });

    assert.equal(adapter.constructor.name, "AnthropicAdapter");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("Anthropic adapter maps provider errors into canonical taxonomy", async () => {
  const context = {
    sessionId: "anthropic-errors",
    messages: [{ role: "user", content: "hello" }],
    toolDefinitions: [],
    budgetReport: { mustCompact: false, messageCount: 1 },
  };

  const authAdapter = createAnthropicAdapter(
    { provider: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "test-key" },
    async () =>
      new Response(
        JSON.stringify({ error: { type: "authentication_error", message: "bad key" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
  );
  await assert.rejects(authAdapter.complete(context), (error: unknown) => error instanceof ProviderError && error.code === "provider_auth_failed");

  const rateLimitAdapter = createAnthropicAdapter(
    { provider: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "test-key" },
    async () =>
      new Response(
        JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
  );
  await assert.rejects(rateLimitAdapter.complete(context), (error: unknown) => error instanceof ProviderError && error.code === "provider_rate_limited");

  const oversizedAdapter = createAnthropicAdapter(
    { provider: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "test-key" },
    async () =>
      new Response(
        JSON.stringify({ error: { type: "invalid_request_error", message: "prompt is too long for this model" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
  );
  await assert.rejects(oversizedAdapter.complete(context), (error: unknown) => error instanceof ProviderError && error.code === "provider_context_too_large");
});

test("AgentRuntime converts provider errors into typed events and a model_error finish reason", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codec-provider-error-"));
  await writeFile(join(cwd, "notes.txt"), "alpha\n");
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));

  const runtime = new AgentRuntime({
    model: new FakeModelAdapter([], {
      error: new ProviderError("provider timeout with secret sk-test-123", "provider_request_failed"),
    }),
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });

  const result = await runtime.runTurn({
    sessionId: "provider-error",
    userMessage: "do work",
    workspace: { cwd },
  });

  assert.equal(result.finishReason, "model_error");
  assert.match(result.finalMessage, /model error/i);
  assert.doesNotMatch(result.finalMessage, /sk-test-123/);

  const events = await eventStore.forSession("provider-error");
  assert.deepEqual(
    events.map((event) => event.type),
    ["UserMessage", "ContextBuilt", "InstructionsResolved", "ModelRequestStarted", "ModelError", "AgentFinished"],
  );
});

test("AgentRuntime retries retryable provider errors and succeeds within retry budget", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codec-provider-retry-"));
  await writeFile(join(cwd, "notes.txt"), "alpha\n");
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  let attempts = 0;

  const runtime = new AgentRuntime({
    model: new FakeModelAdapter([], {
      responder: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new ProviderError("temporary failure", "provider_request_failed", true);
        }
        return { finalMessage: "recovered" };
      },
    }),
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
    limits: { maxToolIterations: 2, maxModelRetries: 2, modelRetryDelayMs: 1 },
  });

  const result = await runtime.runTurn({
    sessionId: "provider-retry",
    userMessage: "do work",
    workspace: { cwd },
  });

  assert.equal(attempts, 3);
  assert.equal(result.finalMessage, "recovered");
  assert.equal(result.finishReason, "final_message");

  const events = await eventStore.forSession("provider-retry");
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "UserMessage",
      "ContextBuilt",
      "InstructionsResolved",
      "ModelRequestStarted",
      "ModelError",
      "ModelRequestStarted",
      "ModelError",
      "ModelRequestStarted",
      "ModelResponseReceived",
      "AgentFinished",
    ],
  );
});

test("AgentRuntime stops with model_error after retry budget is exhausted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codec-provider-retry-exhausted-"));
  await writeFile(join(cwd, "notes.txt"), "alpha\n");
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  let attempts = 0;

  const runtime = new AgentRuntime({
    model: new FakeModelAdapter([], {
      responder: async () => {
        attempts += 1;
        throw new ProviderError("still failing", "provider_request_failed", true);
      },
    }),
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
    limits: { maxToolIterations: 2, maxModelRetries: 1, modelRetryDelayMs: 1 },
  });

  const result = await runtime.runTurn({
    sessionId: "provider-retry-exhausted",
    userMessage: "do work",
    workspace: { cwd },
  });

  assert.equal(attempts, 2);
  assert.equal(result.finishReason, "model_error");
});

test("AgentRuntime respects an already-aborted request signal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codec-provider-abort-"));
  await writeFile(join(cwd, "notes.txt"), "alpha\n");
  const eventStore = new JsonlEventStore(join(cwd, ".events.jsonl"));
  const controller = new AbortController();
  controller.abort(new Error("user cancelled"));

  const runtime = new AgentRuntime({
    model: new FakeModelAdapter([{ finalMessage: "should not run" }]),
    eventStore,
    contextBuilder: new ContextBuilder(),
    permissionManager: new PermissionManager(),
    toolExecutor: new ToolExecutor(),
  });

  const result = await runtime.runTurn({
    sessionId: "provider-abort",
    userMessage: "do work",
    workspace: { cwd },
    abortSignal: controller.signal,
  });

  assert.equal(result.finishReason, "aborted");
  assert.match(result.finalMessage, /aborted/i);

  const events = await eventStore.forSession("provider-abort");
  assert.deepEqual(events.map((event) => event.type), ["UserMessage", "TurnAborted", "AgentFinished"]);
});
