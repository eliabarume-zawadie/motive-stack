export type ErrorKind =
  | "token_expired"
  | "permission"
  | "rate_limit"
  | "validation"
  | "transient"
  | "timeout"
  | "invalid_response"
  | "approval_refused"
  | "verification_failed"
  | "unknown";

export class MetaApiError extends Error {
  readonly kind: ErrorKind;
  readonly code?: number;
  readonly subcode?: number;
  readonly fbtraceId?: string;
  readonly httpStatus?: number;
  /** True when a write may have succeeded on Meta's side (e.g. timeout). Callers must reconcile, not retry. */
  readonly outcomeUnknown: boolean;

  constructor(
    kind: ErrorKind,
    message: string,
    opts: { code?: number; subcode?: number; fbtraceId?: string; httpStatus?: number; outcomeUnknown?: boolean } = {},
  ) {
    super(message);
    this.name = "MetaApiError";
    this.kind = kind;
    this.code = opts.code;
    this.subcode = opts.subcode;
    this.fbtraceId = opts.fbtraceId;
    this.httpStatus = opts.httpStatus;
    this.outcomeUnknown = opts.outcomeUnknown ?? false;
  }
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/** Classify a Graph API error body. `token` is scrubbed from the message. */
export function classifyGraphError(httpStatus: number, body: unknown, token: string): MetaApiError {
  const err = (body as { error?: Record<string, unknown> } | null)?.error ?? {};
  const code = typeof err.code === "number" ? err.code : undefined;
  const subcode = typeof err.error_subcode === "number" ? err.error_subcode : undefined;
  const fbtraceId = typeof err.fbtrace_id === "string" ? err.fbtrace_id : undefined;
  const raw = typeof err.message === "string" ? err.message : `HTTP ${httpStatus}`;
  const message = token ? raw.split(token).join("<redacted>") : raw;

  let kind: ErrorKind = "unknown";
  // Code 190 also means "wrong token type" (e.g. a Page token is required); that is not an expiry.
  if (code === 190 && /page access token/i.test(message)) kind = "permission";
  else if (code === 190) kind = "token_expired";
  else if (code !== undefined && (RATE_LIMIT_CODES.has(code) || (code >= 80000 && code <= 80014))) kind = "rate_limit";
  else if (code !== undefined && (code === 10 || (code >= 200 && code <= 299))) kind = "permission";
  else if (code === 100) kind = "validation";
  else if (code === 1 || code === 2 || err.is_transient === true || httpStatus >= 500) kind = "transient";

  return new MetaApiError(kind, message, { code, subcode, fbtraceId, httpStatus });
}
