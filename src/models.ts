import type { ContextBudgetReport, ModelAdapter, ModelAdapterConfig, ModelRequest, ModelResponse, OpenAIModelAdapterConfig } from "./types.ts";
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
      throw new ProviderError(redactProviderMessage(error instanceof Error ? error.message : String(error)));
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

export function createOpenAIResponsesAdapter(
  config: OpenAIModelAdapterConfig & { apiKey?: string },
  fetchFn: FetchLike = fetch,
): OpenAIResponsesAdapter {
  return new OpenAIResponsesAdapter(config, fetchFn);
}

export function createModelAdapter(config: ModelAdapterConfig): ModelAdapter {
  if (config.provider === "fake") {
    return new FakeModelAdapter(config.scriptedResponses ?? [], {
      model: config.model,
      contextWindow: config.contextWindow,
      compactThreshold: config.compactThreshold,
    });
  }
  return createOpenAIResponsesAdapter(config);
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
      parameters: tool.inputSchema,
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

export function redactProviderMessage(message: string): string {
  return capString(message.replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED_API_KEY]"), 500);
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
  if (status === 401 || status === 403) return { code: "provider_auth_failed", retryable: false };
  if (status === 429) return { code: "provider_rate_limited", retryable: true };
  return { code: "provider_request_failed", retryable: status >= 500 || status === 429 };
}
