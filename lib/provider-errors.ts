export type ProviderAvailabilityCode = "quota_exhausted" | "rate_limited";

export class ProviderAvailabilityError extends Error {
  constructor(public readonly code: ProviderAvailabilityCode, public readonly retryAfterSeconds?: number) {
    super(code === "quota_exhausted"
      ? "Gemini quota is exhausted. Check your quota and try again later."
      : "Gemini is rate limited. Please try again later.");
    this.name = "ProviderAvailabilityError";
  }
}

export class ProviderFailureError extends Error {
  readonly code = "provider_unavailable";
  constructor() {
    super("Gemini is temporarily unavailable. Please try again later.");
    this.name = "ProviderFailureError";
  }
}

export function providerErrorResponse(error: ProviderAvailabilityError | ProviderFailureError) {
  return {
    error: error.code,
    message: error.message,
    ...(error instanceof ProviderAvailabilityError && error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  };
}

/** Interpret SDK ApiError status and JSON message without exposing provider data. */
export function classifyProviderError(error: unknown): { code: ProviderAvailabilityCode; retryAfterSeconds?: number } | undefined {
  const obj = error && typeof error === "object" ? error as { status?: unknown; message?: unknown } : {};
  const message = typeof obj.message === "string" ? obj.message : typeof error === "string" ? error : "";
  let payload: any;
  try { payload = JSON.parse(message); } catch { payload = undefined; }
  const detail = payload?.error ?? payload;
  const status = Number(obj.status ?? detail?.code);
  if (status !== 429 && detail?.status !== "RESOURCE_EXHAUSTED") return undefined;
  const content = typeof detail?.message === "string" ? detail.message : message;
  const serializedDetails = Array.isArray(detail?.details) ? JSON.stringify(detail.details) : "";
  const daily = /\b(?:per day|daily|requests per day)\b|(?:requests_per_day|per_day|requestsperday)/i.test(`${content} ${serializedDetails}`);
  const retryInfo = Array.isArray(detail?.details) ? detail.details.find((d: any) => typeof d?.retryDelay === "string")?.retryDelay : undefined;
  const retryMatch = typeof retryInfo === "string" ? retryInfo.match(/^(\d+(?:\.\d+)?)s$/) : null;
  const retryAfterSeconds = retryMatch ? Math.ceil(Number(retryMatch[1])) : undefined;
  return { code: daily ? "quota_exhausted" : "rate_limited", ...(retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) ? { retryAfterSeconds } : {}) };
}
