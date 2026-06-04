import { createHash } from "node:crypto";

export function requireString(value: unknown, name: string): string {
  const result = stringInput(value);
  if (result === undefined) throw new Error(`missing_${name}`);
  return result;
}

export function stringInput(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

export function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashJson(value: unknown): string {
  return hashString(JSON.stringify(value));
}

export function capStructuredValue(value: unknown): unknown {
  if (typeof value === "string") return capString(value);
  if (Array.isArray(value)) return value.slice(0, 50).map(capStructuredValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, capStructuredValue(entry)]));
  }
  return value;
}

export function capString(value: string, limit = 8_000): string {
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated:${value.length - limit}]` : value;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactSecretsInString(value: string): { text: string; redacted: boolean } {
  let redacted = false;
  let text = value;

  text = text.replace(/\bsk-[A-Za-z0-9_-]+\b/g, (match) => {
    redacted = true;
    return `[REDACTED_API_KEY:${match.length}]`;
  });

  text = text.replace(/((?:api[_-]?key|token|secret|password)[A-Za-z0-9_-]*\s*[:=]\s*)([^\s'"]+)/gi, (_, prefix, secret) => {
    redacted = true;
    return `${prefix}[REDACTED_SECRET:${String(secret).length}]`;
  });

  return { text, redacted };
}

export function redactStructuredValue(value: unknown): { value: unknown; redacted: boolean } {
  if (typeof value === "string") {
    const result = redactSecretsInString(value);
    return { value: result.text, redacted: result.redacted };
  }
  if (Array.isArray(value)) {
    let redacted = false;
    const next = value.slice(0, 50).map((entry) => {
      const result = redactStructuredValue(entry);
      redacted = redacted || result.redacted;
      return result.value;
    });
    return { value: next, redacted };
  }
  if (value && typeof value === "object") {
    let redacted = false;
    const next = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        const result = redactStructuredValue(entry);
        redacted = redacted || result.redacted;
        return [key, result.value];
      }),
    );
    return { value: next, redacted };
  }
  return { value, redacted: false };
}

export function summarizeValue(value: unknown): string {
  if (typeof value === "string") return capString(value.replace(/\s+/g, " ").trim(), 160);
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === "object") return `object(${Object.keys(value).join(",")})`;
  return String(value);
}
