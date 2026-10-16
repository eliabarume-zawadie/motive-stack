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
