import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const newToken = (): string => `msw_${randomBytes(24).toString("base64url")}`;

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** JSON with sorted keys, so equal objects always hash equally. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * Error text that is safe to store and show: one line, bounded, with anything shaped like a key, token or credential header replaced. Provider and
 * network errors can echo request details, so every place that persists a failure message goes through this.
 */
export function safeError(message: unknown, max = 240): string {
  const raw = message instanceof Error ? message.message : typeof message === "string" ? message : "error";
  const line = (raw.split(/\r?\n/)[0] ?? "").trim();
  return line
    .replace(/\b(?:sk|pk|rk|msw|act|EAA)[-_][A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [redacted]")
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|secret|password|token)(["'\s:=]+)[^\s"',;]{4,}/gi, "$1$2[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, "[redacted]")
    .slice(0, max) || "error";
}
