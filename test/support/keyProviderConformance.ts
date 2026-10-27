import { randomBytes } from "node:crypto";
import { KEY_BYTES } from "../../src/credentials/crypto.js";
import { KeyUnavailableError, type KeyProvider } from "../../src/credentials/keys.js";

/**
 * What the vault relies on from a KeyProvider, as executable checks. A future managed-key adapter (not part of this work) must pass all
 * of them before it is trusted with real credentials; they also guard LocalKeyring. Everything uses random throwaway data keys: no real
 * credential, key or network is involved unless the adapter under test itself reaches one.
 *
 * Results carry a check name and a FIXED note, never data from the provider or its errors.
 */
export interface ConformanceResult {
  check: string;
  ok: boolean;
  note: string;
}

const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const CTX = Buffer.from("ms.dek.v1|ws=ws_conformance|id=crd_conformance|kind=openai");
const OTHER_CTX = Buffer.from("ms.dek.v1|ws=ws_conformance|id=crd_conformance|kind=anthropic");
const UNKNOWN_KEY = "no-such-key-zzz";

const same = (a: Buffer, b: Buffer): boolean => a.length === b.length && a.equals(b);
async function rejects(p: Promise<unknown>): Promise<{ rejected: boolean; error: unknown; value?: unknown }> {
  try {
    return { rejected: false, error: null, value: await p };
  } catch (error) {
    return { rejected: true, error };
  }
}
/** Would this thrown thing show the data key or the context to a reader of logs or responses? */
function leaks(error: unknown, secrets: Buffer[]): boolean {
  let text = "";
  try {
    const e = error as { message?: unknown; name?: unknown; stack?: unknown };
    text = [String(e?.message ?? ""), String(e?.name ?? ""), String(e?.stack ?? ""), JSON.stringify(error) ?? ""].join("\n");
  } catch {
    return false;
  }
  return secrets.some((s) => [s.toString("utf8"), s.toString("hex"), s.toString("base64"), s.toString("base64url")].some((f) => f.length >= 8 && text.includes(f)));
}

export async function checkKeyProvider(p: KeyProvider, opts: { rotated?: KeyProvider } = {}): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  const check = async (name: string, fn: () => Promise<string | null>) => {
    try {
      const failure = await fn();
      results.push({ check: name, ok: failure === null, note: failure ?? "ok" });
    } catch {
      results.push({ check: name, ok: false, note: "the check itself threw unexpectedly" }); // never the error's text
    }
  };

  await check("declares a name and a boolean-or-absent managed flag", async () => {
    if (typeof p.name !== "string" || !/^[a-z0-9_.-]{1,64}$/.test(p.name)) return "name must be 1 to 64 characters of a-z 0-9 _ . -";
    if (p.managed !== undefined && typeof p.managed !== "boolean") return "managed must be true, false or absent";
    return null;
  });
  await check("active key id is a valid id", async () => (KEY_ID.test(p.activeKeyId()) ? null : "key ids must match [a-z0-9][a-z0-9._-]{0,31}"));
  await check("hasKey (when provided) knows the active key and not an unknown one", async () => {
    if (!p.hasKey) return null;
    if (p.hasKey(p.activeKeyId()) !== true) return "hasKey must be true for the active key";
    if (p.hasKey(UNKNOWN_KEY) !== false) return "hasKey must be false for a key it does not hold";
    return null;
  });

  await check("a wrapped key unwraps to exactly the original, under the active key id", async () => {
    const dek = randomBytes(KEY_BYTES);
    const original = Buffer.from(dek);
    const active = p.activeKeyId();
    const w = await p.wrap(dek, CTX);
    if (w.keyId !== active) return "wrap must report the active key id";
    if (!Buffer.isBuffer(w.wrapped) || w.wrapped.length === 0) return "wrapped must be a non-empty Buffer";
    if (w.wrapped.includes(original)) return "the wrapped form contains the data key in the clear";
    const back = await p.unwrap(w.keyId, w.wrapped, CTX);
    return Buffer.isBuffer(back) && same(back, original) ? null : "unwrap did not return the original key";
  });

  await check("the caller's buffer is neither changed nor kept", async () => {
    const dek = randomBytes(KEY_BYTES);
    const original = Buffer.from(dek);
    const w = await p.wrap(dek, CTX);
    if (!same(dek, original)) return "wrap changed the caller's buffer";
    dek.fill(0); // the vault wipes its copy right after wrapping
    const back = await p.unwrap(w.keyId, w.wrapped, CTX);
    return same(back, original) ? null : "the wrapping depended on the caller's buffer staying intact";
  });

  await check("the unwrapped key is a private copy", async () => {
    const dek = randomBytes(KEY_BYTES);
    const original = Buffer.from(dek);
    const w = await p.wrap(dek, CTX);
    const first = await p.unwrap(w.keyId, w.wrapped, CTX);
    first.fill(0); // the vault wipes what it is given
    const second = await p.unwrap(w.keyId, w.wrapped, CTX);
    return same(second, original) ? null : "wiping one result affected a later unwrap";
  });

  await check("wrapping is randomized: the same key wraps differently each time", async () => {
    const dek = randomBytes(KEY_BYTES);
    const a = await p.wrap(dek, CTX);
    const b = await p.wrap(dek, CTX);
    return same(a.wrapped, b.wrapped) ? "two wraps of the same key were identical (a fixed nonce or no randomness)" : null;
  });

  await check("a different context is refused", async () => {
    const dek = randomBytes(KEY_BYTES);
    const w = await p.wrap(dek, CTX);
    const wrongKind = await rejects(p.unwrap(w.keyId, w.wrapped, OTHER_CTX));
    if (!wrongKind.rejected) return "unwrap succeeded under another context (workspace, credential or kind not bound)";
    const flipped = Buffer.from(CTX);
    flipped[flipped.length - 1]! ^= 1;
    const oneBit = await rejects(p.unwrap(w.keyId, w.wrapped, flipped));
    if (!oneBit.rejected) return "unwrap succeeded under a context that differs by one bit";
    const empty = await rejects(p.unwrap(w.keyId, w.wrapped, Buffer.alloc(0)));
    return empty.rejected ? null : "unwrap succeeded with an empty context";
  });

  await check("an unknown key id is refused with KeyUnavailableError", async () => {
    const dek = randomBytes(KEY_BYTES);
    const w = await p.wrap(dek, CTX);
    const r = await rejects(p.unwrap(UNKNOWN_KEY, w.wrapped, CTX));
    if (!r.rejected) return "unwrap succeeded for a key id the provider does not hold";
    return r.error instanceof KeyUnavailableError ? null : "the refusal must be a KeyUnavailableError so it is reported as 'key unavailable'";
  });

  await check("modified, truncated, extended or empty wrapped data is refused", async () => {
    const dek = randomBytes(KEY_BYTES);
    const w = await p.wrap(dek, CTX);
    const variants: Array<[string, Buffer]> = [
      ["first byte changed", Buffer.from(w.wrapped)],
      ["last byte changed", Buffer.from(w.wrapped)],
      ["truncated", w.wrapped.subarray(0, w.wrapped.length - 1)],
      ["extended", Buffer.concat([w.wrapped, Buffer.from([0])])],
      ["empty", Buffer.alloc(0)],
    ];
    variants[0]![1][0]! ^= 1;
    variants[1]![1][variants[1]![1].length - 1]! ^= 1;
    for (const [what, bad] of variants) {
      const r = await rejects(p.unwrap(w.keyId, bad, CTX));
      if (!r.rejected) return `unwrap accepted wrapped data that was ${what}`;
    }
    return null;
  });

  await check("failures never repeat the key, the context or the wrapped bytes", async () => {
    const dek = randomBytes(KEY_BYTES);
    const w = await p.wrap(dek, CTX);
    const secrets = [dek, CTX, OTHER_CTX, w.wrapped];
    // Started one at a time: a promise created early and awaited late would be reported as an unhandled rejection.
    const attempts = [() => p.unwrap(w.keyId, w.wrapped, OTHER_CTX), () => p.unwrap(UNKNOWN_KEY, w.wrapped, CTX), () => p.unwrap(w.keyId, w.wrapped.subarray(1), CTX)];
    for (const start of attempts) {
      const r = await rejects(start());
      if (r.rejected && leaks(r.error, secrets)) return "an error message, name, stack or JSON form contained key, context or wrapped data";
    }
    return null;
  });

  await check("concurrent wraps and unwraps are independent", async () => {
    const work = Array.from({ length: 24 }, async (_, i) => {
      const dek = randomBytes(KEY_BYTES);
      const original = Buffer.from(dek);
      const ctx = Buffer.from(`${CTX.toString()}|n=${i}`);
      const w = await p.wrap(dek, ctx);
      return same(await p.unwrap(w.keyId, w.wrapped, ctx), original);
    });
    return (await Promise.all(work)).every(Boolean) ? null : "concurrent operations returned wrong keys";
  });

  if (opts.rotated) {
    const next = opts.rotated;
    await check("after rotation: old wrappings still open, new ones use the new key id", async () => {
      const dek = randomBytes(KEY_BYTES);
      const original = Buffer.from(dek);
      const old = await p.wrap(dek, CTX);
      if (next.activeKeyId() === old.keyId) return "the rotated provider's active key id must differ from the old one";
      if (next.hasKey && next.hasKey(old.keyId) !== true) return "the rotated provider must still hold the old key until it is retired";
      if (!same(await next.unwrap(old.keyId, old.wrapped, CTX), original)) return "the rotated provider could not open a wrapping made under the old key";
      const fresh = await next.wrap(dek, CTX);
      if (fresh.keyId !== next.activeKeyId()) return "the rotated provider must wrap under its new active key";
      return same(await next.unwrap(fresh.keyId, fresh.wrapped, CTX), original) ? null : "a wrapping under the new key did not open";
    });
  }
  return results;
}

export const failedChecks = (rs: ConformanceResult[]): ConformanceResult[] => rs.filter((r) => !r.ok);
