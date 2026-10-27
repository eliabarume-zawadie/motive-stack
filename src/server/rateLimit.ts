/**
 * A small IN-PROCESS rate limiter for the credential write routes. No dependency.
 *
 * LIMITATION: counters live in this process's memory. With more than one server instance, each instance counts separately (so the real
 * limit is multiplied by the number of instances), and counters reset on restart. A multi-instance deployment needs shared state
 * (a database table or an external store); that is a deployment decision, see docs/credential-security.md.
 */
export interface CredentialRateLimits {
  /** Write attempts one person may make against one workspace per window. */
  callerMax: number;
  /** Write attempts all people together may make against one workspace per window. */
  workspaceMax: number;
  windowSec: number;
  /** Failed attempts (client errors) one person may accumulate against one workspace within failureWindowSec before being locked out. */
  failureMax: number;
  failureWindowSec: number;
  lockoutSec: number;
  /** How many "denied" audit events one person may produce per window (further denials are still refused, just not each recorded). */
  deniedAuditMax: number;
}

export const DEFAULT_CREDENTIAL_RATE_LIMITS: CredentialRateLimits = {
  callerMax: 10,
  workspaceMax: 30,
  windowSec: 60,
  failureMax: 5,
  failureWindowSec: 300,
  lockoutSec: 900,
  deniedAuditMax: 10,
};

const SPEC: Array<[keyof CredentialRateLimits, string, number, number]> = [
  ["callerMax", "CREDENTIAL_RL_CALLER_MAX", 1, 1000],
  ["workspaceMax", "CREDENTIAL_RL_WORKSPACE_MAX", 1, 10_000],
  ["windowSec", "CREDENTIAL_RL_WINDOW_SEC", 1, 3600],
  ["failureMax", "CREDENTIAL_RL_FAILURE_MAX", 1, 1000],
  ["failureWindowSec", "CREDENTIAL_RL_FAILURE_WINDOW_SEC", 1, 86_400],
  ["lockoutSec", "CREDENTIAL_RL_LOCKOUT_SEC", 1, 86_400],
  ["deniedAuditMax", "CREDENTIAL_RL_DENIED_AUDIT_MAX", 1, 1000],
];

/** Defaults, overridden by environment variables. A set but invalid value stops startup, naming the variable only. */
export function loadCredentialRateLimits(env: Record<string, string | undefined>): CredentialRateLimits {
  const out = { ...DEFAULT_CREDENTIAL_RATE_LIMITS };
  const problems: string[] = [];
  for (const [key, name, min, max] of SPEC) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") continue;
    const n = Number(raw);
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < min || n > max) problems.push(`${name}: integer from ${min} to ${max}`);
    else out[key] = n;
  }
  if (problems.length) throw new Error(`Invalid configuration (${problems.join("; ")})`);
  return out;
}

/** Workspace-claim attempts per verified person (only identities allowed to claim are counted). */
export interface ClaimRateLimits {
  claimMax: number;
  claimWindowSec: number;
}
export const DEFAULT_CLAIM_RATE_LIMITS: ClaimRateLimits = { claimMax: 10, claimWindowSec: 3600 };

/** CLAIM_RL_MAX and CLAIM_RL_WINDOW_SEC. A set but invalid value stops startup, naming the variable only. */
export function loadClaimRateLimits(env: Record<string, string | undefined>): ClaimRateLimits {
  const out = { ...DEFAULT_CLAIM_RATE_LIMITS };
  const problems: string[] = [];
  for (const [key, name, min, max] of [["claimMax", "CLAIM_RL_MAX", 1, 1000], ["claimWindowSec", "CLAIM_RL_WINDOW_SEC", 1, 86_400]] as const) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") continue;
    const n = Number(raw);
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < min || n > max) problems.push(`${name}: integer from ${min} to ${max}`);
    else out[key] = n;
  }
  if (problems.length) throw new Error(`Invalid configuration (${problems.join("; ")})`);
  return out;
}

/**
 * General API volume per VERIFIED person (across all their workspaces). The default is generous on purpose: the bundled UI polls about
 * four endpoints every 1.5 s per visible tab (about 160 requests a minute), so 1200 a minute allows several tabs while still bounding abuse.
 */
export interface ApiRateLimits {
  apiMax: number;
  apiWindowSec: number;
}
export const DEFAULT_API_RATE_LIMITS: ApiRateLimits = { apiMax: 1200, apiWindowSec: 60 };

/** API_RL_MAX and API_RL_WINDOW_SEC. A set but invalid value stops startup, naming the variable only. */
export function loadApiRateLimits(env: Record<string, string | undefined>): ApiRateLimits {
  const out = { ...DEFAULT_API_RATE_LIMITS };
  const problems: string[] = [];
  for (const [key, name, min, max] of [["apiMax", "API_RL_MAX", 10, 100_000], ["apiWindowSec", "API_RL_WINDOW_SEC", 1, 3600]] as const) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") continue;
    const n = Number(raw);
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < min || n > max) problems.push(`${name}: integer from ${min} to ${max}`);
    else out[key] = n;
  }
  if (problems.length) throw new Error(`Invalid configuration (${problems.join("; ")})`);
  return out;
}

interface Entry {
  count: number;
  resetAt: number;
  lockedUntil: number;
}

export class RateLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  private touch(key: string, windowMs: number): Entry {
    const t = this.now();
    let e = this.entries.get(key);
    if (!e || t >= e.resetAt) {
      e = { count: 0, resetAt: t + windowMs, lockedUntil: e && e.lockedUntil > t ? e.lockedUntil : 0 };
      this.entries.delete(key); // re-insert so the oldest keys are the first to be evicted
      this.entries.set(key, e);
      this.evict(t, key);
    }
    return e;
  }

  /** Count one attempt against `key`: allowed while the count in the current window is within `max`. */
  hit(key: string, max: number, windowMs: number): { allowed: boolean; retryAfterMs: number } {
    const e = this.touch(key, windowMs);
    e.count++;
    return e.count <= max ? { allowed: true, retryAfterMs: 0 } : { allowed: false, retryAfterMs: Math.max(1, e.resetAt - this.now()) };
  }

  /** Count one failure against `key`; past `max` within the window the key is locked for `lockMs`. Returns true once locked. */
  fail(key: string, max: number, windowMs: number, lockMs: number): boolean {
    const e = this.touch(key, windowMs);
    e.count++;
    if (e.count > max) e.lockedUntil = this.now() + lockMs;
    return e.lockedUntil > this.now();
  }

  /** Milliseconds left on a lockout (0 if none). */
  lockedFor(key: string): number {
    const e = this.entries.get(key);
    const left = e ? e.lockedUntil - this.now() : 0;
    return left > 0 ? left : 0;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Keep memory bounded without letting a flood of keys erase lockouts:
   *   1. drop entries whose window has ended and that hold no lockout;
   *   2. still over the soft cap: drop the oldest entries that hold NO ACTIVE LOCKOUT, down to 90% of it;
   *   3. only if the table is still past a hard cap of twice the soft cap (that many simultaneous lockouts) drop the oldest lockouts too,
   *      so memory is bounded in every case.
   * The key being touched right now is never evicted by its own call (otherwise a new offender could never accumulate failures
   * while the table is full of lockouts).
   */
  private evict(t: number, keep: string): void {
    if (this.entries.size <= this.maxKeys) return;
    for (const [k, e] of this.entries) if (k !== keep && t >= e.resetAt && e.lockedUntil <= t) this.entries.delete(k);
    const target = Math.floor(this.maxKeys * 0.9);
    for (const [k, e] of this.entries) {
      if (this.entries.size <= target) break;
      if (k !== keep && e.lockedUntil <= t) this.entries.delete(k);
    }
    const hard = this.maxKeys * 2;
    for (const k of this.entries.keys()) {
      if (this.entries.size <= hard) break;
      if (k !== keep) this.entries.delete(k);
    }
  }
}
