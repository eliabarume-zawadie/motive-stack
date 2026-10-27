import { AuthError } from "./types.js";

/** A source of the provider's public signing keys, looked up by key id. */
export interface JwksSource {
  getKey(kid: string): Promise<JsonWebKey | undefined>;
}

/** Fixed keys (tests, or a provider whose keys are pinned in configuration). */
export class StaticJwks implements JwksSource {
  constructor(private readonly keys: Array<JsonWebKey & { kid?: string }>) {}
  async getKey(kid: string): Promise<JsonWebKey | undefined> {
    return this.keys.find((k) => k.kid === kid);
  }
}

export interface RemoteJwksOptions {
  uri: string;
  /** Injected so tests never touch the network. Defaults to the global fetch at call time. */
  fetch?: typeof fetch;
  /** How long fetched keys are used without trying to refresh them. */
  ttlMs?: number;
  /**
   * The longest a key set may be trusted since the last SUCCESSFUL fetch, even while the provider is unreachable. Past it, verification
   * fails closed (keys_unavailable) until a fetch succeeds. Default 24 h. Must be at least ttlMs.
   */
  maxStaleMs?: number;
  /** Minimum gap between fetches, so a flood of unknown key ids cannot turn this server into a request amplifier. */
  cooldownMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => number;
}

/**
 * Fetches the provider's JWKS over HTTPS, caches it, and refreshes when a key id is unknown (key rotation), at most once per cooldown.
 * It never follows redirects and never accepts a response larger than maxBytes.
 *
 * The response is read incrementally and counted in BYTES: a declared Content-Length over the limit is refused before reading, and an
 * undeclared or understated body is cancelled the moment it passes the limit, so an oversized response is never fully buffered.
 * A key set with no usable key (empty, or no entry with a string kid) is a failed fetch: it never replaces the cache or ages it forward.
 *
 * Two clocks are kept apart: the last ATTEMPT (paces refreshes, success or not) and the last SUCCESS (decides how old the keys are).
 * A failed refresh therefore never makes old keys look newer; once they are older than maxStaleMs they are not used at all.
 */
export class RemoteJwks implements JwksSource {
  private keys = new Map<string, JsonWebKey>();
  private lastAttemptAt = -Infinity;
  private lastSuccessAt = -Infinity;
  private inflight: Promise<void> | null = null;
  private readonly ttl: number;
  private readonly cooldown: number;
  private readonly maxStale: number;
  private readonly now: () => number;

  constructor(private readonly o: RemoteJwksOptions) {
    let u: URL;
    try {
      u = new URL(o.uri);
    } catch {
      throw new Error("JWKS URI is not a valid URL");
    }
    if (u.protocol !== "https:") throw new Error("JWKS URI must use https");
    if (u.username || u.password) throw new Error("JWKS URI must not contain credentials");
    this.ttl = o.ttlMs ?? 10 * 60_000;
    this.cooldown = o.cooldownMs ?? 60_000;
    this.maxStale = o.maxStaleMs ?? 24 * 3_600_000;
    if (!Number.isFinite(this.maxStale) || this.maxStale < this.ttl) throw new Error("JWKS maximum key age must be at least the cache lifetime");
    this.now = o.now ?? Date.now;
  }

  async getKey(kid: string): Promise<JsonWebKey | undefined> {
    const age = (): number => this.now() - this.lastSuccessAt; // age of the keys: since the last SUCCESSFUL fetch
    const known = this.keys.get(kid);
    if (known && age() < this.ttl) return known;
    // Refresh when stale, or when the key id is unknown, but never more often than the cooldown (counted from the last attempt).
    if (this.now() - this.lastAttemptAt >= this.cooldown) {
      try {
        await this.refresh();
      } catch (e) {
        // While the provider is unreachable the last good keys stay usable, but only up to maxStaleMs old.
        if (known && age() <= this.maxStale) return known;
        throw e instanceof AuthError ? e : new AuthError("keys_unavailable");
      }
    } else if (this.keys.size === 0 || age() > this.maxStale) {
      // Nothing usable has been fetched (or what was fetched is too old) and the last attempt was too recent to retry.
      throw new AuthError("keys_unavailable");
    }
    return this.keys.get(kid);
  }

  private refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<void> {
    this.lastAttemptAt = this.now(); // counts as an attempt, so failures are also rate-limited; it does NOT make the keys any newer
    const f = this.o.fetch ?? globalThis.fetch;
    const max = this.o.maxBytes ?? 100_000;
    let text: string;
    try {
      const res = await f(this.o.uri, { redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.o.timeoutMs ?? 5000) });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${res.status}`);
      }
      const declared = res.headers.get("content-length")?.trim() ?? "";
      if (/^\d+$/.test(declared) && Number(declared) > max) {
        await res.body?.cancel().catch(() => undefined);
        throw new AuthError("keys_unavailable", "key set too large");
      }
      if (!res.body) throw new Error("no body");
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
          await reader.cancel().catch(() => undefined); // stop the transfer; the rest is never buffered
          throw new AuthError("keys_unavailable", "key set too large");
        }
        chunks.push(value);
      }
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } catch (e) {
      throw e instanceof AuthError ? e : new AuthError("keys_unavailable"); // fixed text: nothing from the response is ever repeated
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AuthError("keys_unavailable", "key set is not JSON");
    }
    const list = (parsed as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(list)) throw new AuthError("keys_unavailable", "key set has no keys array");
    const next = new Map<string, JsonWebKey>();
    const seen = new Map<string, string>();
    const conflicted = new Set<string>();
    for (const k of list) {
      const kid = (k as { kid?: unknown } | null)?.kid;
      if (k && typeof k === "object" && typeof kid === "string" && kid) {
        // Two DIFFERENT entries under one key id are ambiguous: which one signed a token cannot be known, so that id is dropped
        // (other keys still work). An identical repeat is harmless.
        const text = JSON.stringify(k);
        const previous = seen.get(kid);
        if (previous !== undefined && previous !== text) conflicted.add(kid);
        seen.set(kid, text);
        next.set(kid, k as JsonWebKey);
      }
    }
    for (const kid of conflicted) next.delete(kid);
    // A set with nothing to verify with is not a successful fetch: keep the old keys (inside their maximum age) and do not renew their age.
    if (next.size === 0) throw new AuthError("keys_unavailable", "key set has no usable keys");
    this.keys = next;
    this.lastSuccessAt = this.now();
  }
}
