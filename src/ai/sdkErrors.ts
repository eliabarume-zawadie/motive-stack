import { AiError } from "./types.js";

/**
 * Turn any SDK/network error into a normalized AiError.
 * The message is built from status and error type only. Provider message text is NOT copied,
 * because it can echo prompt content (business data) or request details.
 */
export function mapSdkError(providerLabel: string, err: unknown, secrets: Array<string | undefined> = []): AiError {
  if (err instanceof AiError) return err;
  const e = err as {
    name?: string;
    status?: number;
    code?: string | null;
    type?: string | null;
    message?: string;
    headers?: Record<string, string> | Headers;
    requestID?: string | null;
    request_id?: string | null;
    error?: { type?: string; code?: string } & Record<string, unknown>;
  };
  // The SDKs' error classes do not always set `name`, so also look at the constructor name.
  const ctor = (err as { constructor?: { name?: string } } | null)?.constructor?.name ?? "";
  const name = [e?.name, ctor].find((n) => n && n !== "Error") ?? e?.name ?? "";
  const status = typeof e?.status === "number" ? e.status : undefined;
  const code = String(e?.code ?? e?.error?.code ?? "");
  const type = String(e?.type ?? e?.error?.type ?? "");
  const requestId = e?.requestID ?? e?.request_id ?? undefined;
  const raw = String(e?.message ?? "");

  const header = (n: string): string | undefined => {
    const h = e?.headers;
    if (!h) return undefined;
    return typeof (h as Headers).get === "function" ? ((h as Headers).get(n) ?? undefined) : (h as Record<string, string>)[n];
  };
  const ra = Number(header("retry-after"));
  const retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : undefined;

  const scrub = (s: string) => secrets.reduce<string>((acc, k) => (k ? acc.split(k).join("<redacted>") : acc), s);
  const tag = scrub([status ? `HTTP ${status}` : "", type, code].filter(Boolean).join(" ")) || "no details";
  const base = { requestId: requestId ?? undefined, httpStatus: status, retryAfterMs };

  if (name === "AbortError" || name === "APIUserAbortError") return new AiError("cancelled", `${providerLabel} request was cancelled`, base);
  if (name === "APIConnectionTimeoutError" || status === 408) return new AiError("timeout", `${providerLabel} request timed out`, { ...base, retryable: true });
  if (name === "APIConnectionError" || (!status && /fetch failed|ECONN|ENOTFOUND|network/i.test(raw))) {
    return new AiError("provider_unavailable", `${providerLabel} is unreachable`, { ...base, retryable: true });
  }
  if (status === 401 || status === 403) return new AiError("auth", `${providerLabel} rejected the credentials (${tag})`, base);
  if (status === 402 || /insufficient_quota|billing|credit balance/i.test(`${code} ${type} ${raw}`)) {
    return new AiError("insufficient_balance", `${providerLabel} account has insufficient balance or quota (${tag})`, base);
  }
  if (status === 429) return new AiError("rate_limit", `${providerLabel} rate limit reached (${tag})`, { ...base, retryable: true });
  if (status !== undefined && status >= 500) return new AiError("provider_unavailable", `${providerLabel} server error (${tag})`, { ...base, retryable: true });
  if (status !== undefined && status >= 400) return new AiError("invalid_request", `${providerLabel} rejected the request (${tag})`, base);
  return new AiError("provider_unavailable", `${providerLabel} request failed (${tag})`, base);
}
