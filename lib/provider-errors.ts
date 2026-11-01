export type ProviderAvailabilityCode = "quota_exhausted" | "rate_limited";

export class ProviderAvailabilityError extends Error {
  constructor(public readonly code: ProviderAvailabilityCode, public readonly retryAfterSeconds?: number) {
    super(code === "quota_exhausted"
      ? "Gemini quota is exhausted. Check your quota and try again later."
      : "Gemini is rate limited. Please try again later.");
    this.name = "ProviderAvailabilityError";
  }
}

export type ProviderConfigCode = "gemini_api_not_enabled" | "invalid_api_key";

export class ProviderConfigError extends Error {
  constructor(public readonly code: ProviderConfigCode) {
    super(code === "gemini_api_not_enabled"
      ? "Gemini API is not enabled for this API key's Google Cloud project. Enable it, or use a key from Google AI Studio, then scan again."
      : "This Gemini API key is invalid. Paste a valid key in Settings, then scan again.");
    this.name = "ProviderConfigError";
  }
}

export class ProviderFailureError extends Error {
  readonly code = "provider_unavailable";
  constructor() {
    super("Gemini is temporarily unavailable. Please try again later.");
    this.name = "ProviderFailureError";
  }
}

export function providerErrorResponse(error: ProviderAvailabilityError | ProviderFailureError | ProviderConfigError) {
  return {
    error: error.code,
    message: error.message,
    ...(error instanceof ProviderAvailabilityError && error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  };
}

function parseProviderDetail(error: unknown): { status: number; detail: any; message: string } {
  const obj = error && typeof error === "object" ? error as { status?: unknown; message?: unknown } : {};
  const message = typeof obj.message === "string" ? obj.message : typeof error === "string" ? error : "";
  let payload: any;
  try { payload = JSON.parse(message); } catch { payload = undefined; }
  const detail = payload?.error ?? payload;
  return { status: Number(obj.status ?? detail?.code), detail, message };
}

/** Key/project configuration faults: retrying with another model or video cannot help. */
export function classifyProviderConfigError(error: unknown): ProviderConfigCode | undefined {
  const { status, detail } = parseProviderDetail(error);
  const reasons = Array.isArray(detail?.details) ? detail.details.map((d: any) => d?.reason) : [];
  if (reasons.includes("API_KEY_INVALID")) return "invalid_api_key";
  if (status === 403 && (reasons.includes("SERVICE_DISABLED") || detail?.status === "SERVICE_DISABLED")) return "gemini_api_not_enabled";
  return undefined;
}

/** Interpret SDK ApiError status and JSON message without exposing provider data. */
export function classifyProviderError(error: unknown): { code: ProviderAvailabilityCode; retryAfterSeconds?: number } | undefined {
  const { status, detail, message } = parseProviderDetail(error);
  if (status !== 429 && detail?.status !== "RESOURCE_EXHAUSTED") return undefined;
  const content = typeof detail?.message === "string" ? detail.message : message;
  const serializedDetails = Array.isArray(detail?.details) ? JSON.stringify(detail.details) : "";
  const daily = /\b(?:per day|daily|requests per day)\b|(?:requests_per_day|per_day|requestsperday)/i.test(`${content} ${serializedDetails}`);
  const retryInfo = Array.isArray(detail?.details) ? detail.details.find((d: any) => typeof d?.retryDelay === "string")?.retryDelay : undefined;
  const retryMatch = typeof retryInfo === "string" ? retryInfo.match(/^(\d+(?:\.\d+)?)s$/) : null;
  const retryAfterSeconds = retryMatch ? Math.ceil(Number(retryMatch[1])) : undefined;
  return { code: daily ? "quota_exhausted" : "rate_limited", ...(retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) ? { retryAfterSeconds } : {}) };
}
