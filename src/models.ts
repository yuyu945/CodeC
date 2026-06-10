import type {
  AnthropicModelAdapterConfig,
  ContextBudgetReport,
  ModelAdapter,
  ModelAdapterConfig,
  ModelRequest,
  ModelResponse,
  OpenAIModelAdapterConfig,
  ProviderCompatibilityReport,
  ProviderProbeResult,
} from "./types.ts";
import { capString } from "./shared.ts";

type FetchLike = typeof fetch;

export class ProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code = "provider_request_failed", retryable = false) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class FakeModelAdapter implements ModelAdapter {
  readonly provider = "fake";
  readonly model: string;
  readonly contextWindow: number;
  readonly compactThreshold: number;
  private readonly scriptedResponses: ModelResponse[];
  private readonly responder?: (request: ModelRequest, invocation: number) => Promise<ModelResponse> | ModelResponse;
  private readonly error?: Error;
  private calls = 0;

  constructor(
    scriptedResponses: ModelResponse[] = [],
    options: {
      model?: string;
      contextWindow?: number;
      compactThreshold?: number;
      responder?: (request: ModelRequest, invocation: number) => Promise<ModelResponse> | ModelResponse;
      error?: Error;
    } = {},
  ) {
    this.model = options.model ?? "deterministic";
    this.contextWindow = options.contextWindow ?? 1024;
    this.compactThreshold = options.compactThreshold ?? Math.floor(this.contextWindow * 0.8);
    this.scriptedResponses = scriptedResponses;
    this.responder = options.responder;
    this.error = options.error;
  }

  estimateBudget(request: ModelRequest): ContextBudgetReport {
    return estimateBudgetFromChars(request, this.contextWindow, this.compactThreshold);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    if (this.error) throw this.error;
    if (this.responder) return await this.responder(request, this.calls);
    return this.scriptedResponses[this.calls - 1] ?? { finalMessage: "" };
  }
}

export class OpenAIResponsesAdapter implements ModelAdapter {
  readonly provider = "openai";
  readonly model: string;
  readonly contextWindow: number;
  readonly compactThreshold: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(config: OpenAIModelAdapterConfig & { apiKey?: string }, fetchFn: FetchLike = fetch) {
    this.model = config.model;
    this.contextWindow = config.contextWindow ?? 8_000;
    this.compactThreshold = config.compactThreshold ?? Math.floor(this.contextWindow * 0.8);
    this.apiKey = resolveApiKey(config);
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.fetchFn = fetchFn;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.fetchFn(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(toOpenAIRequest(this.model, request)),
    }).catch((error) => {
      throw new ProviderError(
        redactProviderMessage(error instanceof Error ? error.message : String(error)),
        "provider_request_failed",
        true,
      );
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const classification = classifyOpenAIError(response.status, bodyText);
      throw new ProviderError(
        redactProviderMessage(`OpenAI responses request failed with ${response.status}: ${bodyText}`),
        classification.code,
        classification.retryable,
      );
    }

    const payload = await response.json();
    return fromOpenAIResponse(payload);
  }

  estimateBudget(request: ModelRequest): ContextBudgetReport {
    const payload = toOpenAIRequest(this.model, request);
    const estimatedUnits = Math.ceil(JSON.stringify(payload).length / 4);
    return {
      estimatedUnits,
      limit: this.contextWindow,
      threshold: this.compactThreshold,
      mustCompact: estimatedUnits >= this.compactThreshold,
      tier: request.budgetReport.tier ?? "none",
      overflowBy: estimatedUnits > this.contextWindow ? estimatedUnits - this.contextWindow : 0,
    };
  }
}

export class AnthropicAdapter implements ModelAdapter {
  readonly provider = "anthropic";
  readonly model: string;
  readonly contextWindow: number;
  readonly compactThreshold: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly maxTokens: number;

  constructor(config: AnthropicModelAdapterConfig & { apiKey?: string }, fetchFn: FetchLike = fetch) {
    this.model = config.model;
    this.contextWindow = config.contextWindow ?? 8_000;
    this.compactThreshold = config.compactThreshold ?? Math.floor(this.contextWindow * 0.8);
    this.apiKey = resolveAnthropicApiKey(config);
    this.baseUrl = (config.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
    this.fetchFn = fetchFn;
    this.maxTokens = config.maxTokens ?? 1024;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.fetchFn(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(toAnthropicRequest(this.model, this.maxTokens, request)),
    }).catch((error) => {
      throw new ProviderError(
        redactProviderMessage(error instanceof Error ? error.message : String(error)),
        "provider_request_failed",
        true,
      );
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const classification = classifyAnthropicError(response.status, bodyText);
      throw new ProviderError(
        redactProviderMessage(`Anthropic messages request failed with ${response.status}: ${bodyText}`),
        classification.code,
        classification.retryable,
      );
    }

    const payload = await response.json();
    return fromAnthropicResponse(payload);
  }

  estimateBudget(request: ModelRequest): ContextBudgetReport {
    const payload = toAnthropicRequest(this.model, this.maxTokens, request);
    const estimatedUnits = Math.ceil(JSON.stringify(payload).length / 4);
    return {
      estimatedUnits,
      limit: this.contextWindow,
      threshold: this.compactThreshold,
      mustCompact: estimatedUnits >= this.compactThreshold,
      tier: request.budgetReport.tier ?? "none",
      overflowBy: estimatedUnits > this.contextWindow ? estimatedUnits - this.contextWindow : 0,
    };
  }
}

export function createOpenAIResponsesAdapter(
  config: OpenAIModelAdapterConfig & { apiKey?: string },
  fetchFn: FetchLike = fetch,
): OpenAIResponsesAdapter {
  return new OpenAIResponsesAdapter(config, fetchFn);
}

export function createAnthropicAdapter(
  config: AnthropicModelAdapterConfig & { apiKey?: string },
  fetchFn: FetchLike = fetch,
): AnthropicAdapter {
  return new AnthropicAdapter(config, fetchFn);
}

export function createModelAdapter(config: ModelAdapterConfig): ModelAdapter {
  if (config.provider === "fake") {
    return new FakeModelAdapter(config.scriptedResponses ?? [], {
      model: config.model,
      contextWindow: config.contextWindow,
      compactThreshold: config.compactThreshold,
    });
  }
  if (config.provider === "openai") {
    return createOpenAIResponsesAdapter(config);
  }
  return createAnthropicAdapter(config);
}

export async function probeProviderCompatibility(adapter: ModelAdapter): Promise<ProviderCompatibilityReport> {
  const textProbe = await runProbe(adapter, []);
  const toolProbe = await runProbe(adapter, [
    {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    },
  ]);

  return {
    textProbe,
    toolProbe,
    summary: summarizeProbeReport(textProbe, toolProbe),
    details: buildProbeDetails(textProbe, toolProbe),
  };
}

function resolveApiKey(config: OpenAIModelAdapterConfig & { apiKey?: string }): string {
  if (config.apiKey) return config.apiKey;
  const envName = config.apiKeyEnvVar ?? "OPENAI_API_KEY";
  const envValue = process.env[envName];
  if (!envValue) {
    throw new ProviderError(`Missing API key in environment variable ${envName}`, "missing_api_key");
  }
  return envValue;
}

function resolveAnthropicApiKey(config: AnthropicModelAdapterConfig & { apiKey?: string }): string {
  if (config.apiKey) return config.apiKey;
  const envName = config.apiKeyEnvVar ?? "ANTHROPIC_API_KEY";
  const envValue = process.env[envName];
  if (!envValue) {
    throw new ProviderError(`Missing API key in environment variable ${envName}`, "missing_api_key");
  }
  return envValue;
}

function toOpenAIRequest(model: string, request: ModelRequest) {
  return {
    model,
    input: request.messages.map((message) => ({
      role: message.role,
      content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    })),
    tools: request.toolDefinitions.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: normalizeToolInputSchema(tool.inputSchema),
    })),
  };
}

function fromOpenAIResponse(payload: any): ModelResponse {
  const outputs = Array.isArray(payload?.output) ? payload.output : [];

  const toolCalls = outputs
    .filter((item) => item?.type === "function_call")
    .map((item) => ({
      id: String(item.call_id ?? item.id ?? ""),
      name: String(item.name ?? ""),
      input: parseToolArguments(item.arguments),
    }));

  if (toolCalls.length > 0) {
    return { toolCalls };
  }

  const finalText = outputs
    .flatMap((item) => {
      if (item?.type !== "message" || !Array.isArray(item.content)) return [];
      return item.content
        .filter((part: any) => part?.type === "output_text" && typeof part.text === "string")
        .map((part: any) => part.text);
    })
    .join("\n")
    .trim();

  if (finalText) {
    return { finalMessage: finalText };
  }

  throw new ProviderError("Unsupported OpenAI Responses output shape", "malformed_provider_response");
}

function toAnthropicRequest(model: string, maxTokens: number, request: ModelRequest) {
  const systemParts = request.messages
    .filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
  const messages = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "tool") {
        const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        const toolResult = typeof message.content === "object" && message.content && "callId" in message.content ? String((message.content as { callId: unknown }).callId) : "tool_result";
        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolResult,
              content,
            },
          ],
        };
      }
      return {
        role: message.role,
        content: [
          {
            type: "text",
            text: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
          },
        ],
      };
    });

  return {
    model,
    max_tokens: maxTokens,
    system: systemParts.join("\n\n"),
    messages,
    tools: request.toolDefinitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: normalizeToolInputSchema(tool.inputSchema),
    })),
  };
}

function fromAnthropicResponse(payload: any): ModelResponse {
  const content = Array.isArray(payload?.content) ? payload.content : [];

  const toolCalls = content
    .filter((part) => part?.type === "tool_use")
    .map((part) => ({
      id: String(part.id ?? ""),
      name: String(part.name ?? ""),
      input: part.input && typeof part.input === "object" ? part.input : {},
    }));

  if (toolCalls.length > 0) {
    return { toolCalls };
  }

  const finalText = content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (finalText) {
    return { finalMessage: finalText };
  }

  throw new ProviderError("Unsupported Anthropic Messages output shape", "malformed_provider_response");
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new ProviderError("Tool arguments were not a JSON string", "malformed_provider_response");
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid");
    }
    return parsed;
  } catch {
    throw new ProviderError("Tool arguments were malformed JSON", "malformed_provider_response");
  }
}

function normalizeToolInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    return {
      ...schema,
      required:
        Array.isArray(schema.required) && schema.required.every((entry) => typeof entry === "string")
          ? schema.required
          : Object.entries(schema.properties as Record<string, unknown>)
              .filter(([, value]) => !(value && typeof value === "object" && (value as { optional?: unknown }).optional === true))
              .map(([key]) => key),
      additionalProperties: typeof schema.additionalProperties === "boolean" ? schema.additionalProperties : false,
    };
  }

  const properties = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      const rawType = typeof value === "string" ? value : "string";
      const optional = rawType.endsWith("?");
      return [key, { type: optional ? rawType.slice(0, -1) : rawType }];
    }),
  );
  const required = Object.entries(schema)
    .filter(([, value]) => typeof value === "string" && !value.endsWith("?"))
    .map(([key]) => key);

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export function redactProviderMessage(message: string): string {
  return capString(message.replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED_API_KEY]"), 500);
}

export function summarizeProviderErrorCode(code: string): string {
  if (code === "provider_auth_failed") {
    return "Provider authentication failed. Check OPENAI_API_KEY or proxy token.";
  }
  if (code === "provider_balance_failed") {
    return "Provider account balance is insufficient.";
  }
  if (code === "provider_forbidden") {
    return "Provider rejected this request for the selected model or route.";
  }
  if (code === "provider_rate_limited") {
    return "Provider rate limit reached. Retry later.";
  }
  if (code === "provider_context_too_large") {
    return "Provider rejected the request because the context is too large.";
  }
  return "Provider request failed.";
}

function estimateBudgetFromChars(request: ModelRequest, limit: number, threshold: number): ContextBudgetReport {
  const toolUnits = request.toolDefinitions.length * 4;
  const contentUnits = Math.ceil(
    request.messages.reduce((total, message) => total + JSON.stringify(message.content).length, 0) / 4,
  );
  const estimatedUnits = contentUnits + request.messages.length * 20 + toolUnits;
  return {
    estimatedUnits,
    limit,
    threshold,
    mustCompact: estimatedUnits >= threshold,
    tier: request.budgetReport.tier ?? "none",
    overflowBy: estimatedUnits > limit ? estimatedUnits - limit : 0,
  };
}

function classifyOpenAIError(status: number, bodyText: string): { code: string; retryable: boolean } {
  let parsed: any;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = undefined;
  }
  const code = parsed?.error?.code;
  const message = String(parsed?.error?.message ?? bodyText).toLowerCase();

  if (status === 400 && (code === "context_length_exceeded" || message.includes("maximum context length") || message.includes("context length"))) {
    return { code: "provider_context_too_large", retryable: true };
  }
  if (status === 401) return { code: "provider_auth_failed", retryable: false };
  if (status === 403) {
    if (parsed?.error?.type === "bad_response_status_code" || parsed?.error?.code === "bad_response_status_code") {
      return { code: "provider_request_failed", retryable: true };
    }
    const explicitBalanceCode =
      code === "insufficient_balance" ||
      code === "billing_error" ||
      code === "quota_exceeded";
    const explicitBalanceType =
      parsed?.error?.type === "billing_error" ||
      parsed?.error?.type === "insufficient_balance";
    if ((message.includes("insufficient account balance") || message.includes("余额不足") || message.includes("account balance")) && (explicitBalanceCode || explicitBalanceType)) {
      return { code: "provider_balance_failed", retryable: false };
    }
    if (
      message.includes("api key") ||
      message.includes("invalid api key") ||
      message.includes("token expired") ||
      message.includes("令牌已过期") ||
      message.includes("token has expired") ||
      code === "invalid_api_key"
    ) {
      return { code: "provider_auth_failed", retryable: false };
    }
    if (
      message.includes("forbidden") ||
      message.includes("not allowed") ||
      message.includes("permission") ||
      message.includes("model route") ||
      code === "forbidden"
    ) {
      return { code: "provider_forbidden", retryable: false };
    }
    return { code: "provider_request_failed", retryable: false };
  }
  if (status === 429) return { code: "provider_rate_limited", retryable: true };
  return { code: "provider_request_failed", retryable: status >= 500 || status === 429 };
}

function classifyAnthropicError(status: number, bodyText: string): { code: string; retryable: boolean } {
  let parsed: any;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = undefined;
  }

  const type = parsed?.error?.type;
  const message = String(parsed?.error?.message ?? bodyText).toLowerCase();
  if (status === 400 && (message.includes("prompt is too long") || message.includes("context length") || message.includes("too long"))) {
    return { code: "provider_context_too_large", retryable: true };
  }
  if (status === 401 || type === "authentication_error") {
    return { code: "provider_auth_failed", retryable: false };
  }
  if (status === 403) {
    if (message.includes("balance")) return { code: "provider_balance_failed", retryable: false };
    if (message.includes("forbidden") || message.includes("permission") || message.includes("not allowed")) {
      return { code: "provider_forbidden", retryable: false };
    }
    return { code: "provider_request_failed", retryable: false };
  }
  if (status === 429 || type === "rate_limit_error") {
    return { code: "provider_rate_limited", retryable: true };
  }
  return { code: "provider_request_failed", retryable: status >= 500 || status === 429 };
}

async function runProbe(adapter: ModelAdapter, toolDefinitions: ModelRequest["toolDefinitions"]): Promise<ProviderProbeResult> {
  try {
    await adapter.complete({
      sessionId: `probe-${toolDefinitions.length === 0 ? "text" : "tools"}`,
      messages: [{ role: "user", content: "hello" }],
      toolDefinitions,
      budgetReport: { estimatedUnits: 0, limit: 1, threshold: 1, mustCompact: false, tier: "none" },
    });
    return {
      status: "ok",
      summary: toolDefinitions.length === 0 ? "Basic text probe succeeded." : "Tool-capable probe succeeded.",
    };
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : new ProviderError(error instanceof Error ? error.message : String(error));
    return {
      status: "failed",
      code: providerError.code,
      summary: summarizeProviderErrorCode(providerError.code),
    };
  }
}

function summarizeProbeReport(textProbe: ProviderProbeResult, toolProbe: ProviderProbeResult): string {
  if (textProbe.status === "ok" && toolProbe.status === "ok") {
    return "Provider supports both basic chat and tool-capable requests.";
  }
  if (textProbe.status === "ok" && toolProbe.status === "failed") {
    return "Basic chat works, but tool-capable provider requests are failing on this route.";
  }
  if (textProbe.status === "failed" && toolProbe.status === "failed") {
    return "Provider route is failing before agent/tool execution. Check authentication, proxy route, or upstream availability.";
  }
  return "Provider behavior is inconsistent across probe types.";
}

function buildProbeDetails(textProbe: ProviderProbeResult, toolProbe: ProviderProbeResult): string[] {
  return [
    `textProbe: ${textProbe.status}${textProbe.code ? ` (${textProbe.code})` : ""} - ${textProbe.summary}`,
    `toolProbe: ${toolProbe.status}${toolProbe.code ? ` (${toolProbe.code})` : ""} - ${toolProbe.summary}`,
  ];
}
