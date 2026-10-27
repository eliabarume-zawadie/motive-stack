/**
 * Milestone 4.4.1.1: three narrow fixes.
 *   1. a fetched key set with no usable key is a failed fetch (the cache and its age are kept),
 *   2. the key-set size limit is enforced WHILE reading, in bytes, and an oversized stream is cancelled,
 *   3. workspace-claim attempts are rate-limited per verified person, counting only identities that may claim.
 * Local only: keys are generated in memory, "fetch" is a fake, clocks are injected, databases are in memory.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { createWorkspace } from "../src/app/workspaces.js";
import { buildAuthRuntime, loadAuthConfig } from "../src/auth/config.js";
import { RemoteJwks, StaticJwks } from "../src/auth/jwks.js";
import { OidcVerifier } from "../src/auth/oidc.js";
import { AuthError } from "../src/auth/types.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { DEFAULT_CLAIM_RATE_LIMITS, RateLimiter, loadClaimRateLimits } from "../src/server/rateLimit.js";
import { mockFetch } from "./helpers.js";
import { AUDIENCE, ISSUER, NOW_MS, claims, makeKey, signJwt , OIDC_REQUIRED } from "./support/jwt.js";

const rsa = makeKey("RS256", "rsa-1");
const JWKS_URI = "https://idp.example.test/jwks";
const BASE_ENV = { AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: JWKS_URI , ...OIDC_REQUIRED };

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AuthError) return e.reason;
    throw e;
  }
  return "ACCEPTED";
}
const clock = () => {
  let t = NOW_MS;
  return { now: () => t, advance: (ms: number) => (t += ms), at: () => t };
};
const goodSet = () => ({ body: { keys: [rsa.jwk] } });

/** A verifier that uses a RemoteJwks on a fake fetch and the SAME fake clock; tokens are signed relative to that clock, so only the key set is under test. */
function rig(fetchImpl: typeof fetch, o: { ttlMs?: number; maxStaleMs?: number; cooldownMs?: number; maxBytes?: number } = {}) {
  const c = clock();
  const keys = new RemoteJwks({ uri: JWKS_URI, fetch: fetchImpl, now: c.now, ttlMs: 1_000, maxStaleMs: 10_000, cooldownMs: 500, ...o });
  const v = new OidcVerifier({ issuer: ISSUER, audience: AUDIENCE, keys, now: c.now });
  const token = () => signJwt(rsa, claims({ iat: Math.floor(c.at() / 1000) - 10, exp: Math.floor(c.at() / 1000) + 600 }));
  return { c, v, token };
}

/* ====================================================================================================================
 * 1. an unusable key set never replaces the cache or renews its age
 * ================================================================================================================== */

describe("an unusable key set is a failed fetch", () => {
  const down = () => new Error("provider down");
  const empty = () => ({ body: { keys: [] } });
  const noKids = () => ({ body: { keys: [{ kty: "RSA", n: "abc", e: "AQAB" }, { kid: 5, kty: "RSA" }, { kid: "", kty: "RSA" }, null, "text", 7] } });

  it("after a good fetch, an empty set does not discard the cached key inside the stale window", async () => {
    const f = mockFetch([goodSet(), empty()]);
    const { c, v, token } = rig(f.fetchImpl);
    await v.verify(token());
    c.advance(2_000); // stale: a refresh is tried and returns {"keys":[]}
    await expect(v.verify(token())).resolves.toBeTruthy(); // the 2 s old key still verifies
    expect(f.calls).toHaveLength(2); // the refresh really happened
  });

  it("an unusable set does not let a key authenticate once it is older than the maximum age", async () => {
    const f = mockFetch([goodSet(), empty(), empty()]);
    const { c, v, token } = rig(f.fetchImpl);
    await v.verify(token());
    c.advance(11_000); // older than the 10 s window
    expect(await reason(v.verify(token()))).toBe("keys_unavailable");
    expect(f.calls).toHaveLength(2);
  });

  it("an empty set never renews the age: repeated empty answers cannot keep an old key alive", async () => {
    const f = mockFetch([goodSet(), ...Array.from({ length: 6 }, empty)]);
    const { c, v, token } = rig(f.fetchImpl);
    await v.verify(token());
    const out: string[] = [];
    for (let i = 0; i < 4; i++) {
      c.advance(4_000); // 4, 8, 12, 16 s since the only good fetch
      out.push(await reason(v.verify(token())));
    }
    expect(out).toEqual(["ACCEPTED", "ACCEPTED", "keys_unavailable", "keys_unavailable"]);
  });

  it("a set where no entry has a usable kid behaves exactly like an empty one", async () => {
    const f = mockFetch([goodSet(), noKids(), noKids()]);
    const { c, v, token } = rig(f.fetchImpl);
    await v.verify(token());
    c.advance(2_000);
    await expect(v.verify(token())).resolves.toBeTruthy(); // cache kept
    c.advance(10_000);
    expect(await reason(v.verify(token()))).toBe("keys_unavailable"); // and still expires on schedule
  });

  it("when the very first fetch is unusable the answer is 'keys unavailable' (503), not a verdict about the token", async () => {
    for (const first of [empty(), noKids()]) {
      const { v, token } = rig(mockFetch([first]).fetchImpl);
      expect(await reason(v.verify(token()))).toBe("keys_unavailable");
    }
  });

  it("a later valid refresh recovers normally and restarts the age from that fetch", async () => {
    const f = mockFetch([goodSet(), empty(), goodSet(), down(), down()]);
    const { c, v, token } = rig(f.fetchImpl);
    await v.verify(token()); // t0 good
    c.advance(2_000);
    await expect(v.verify(token())).resolves.toBeTruthy(); // empty answer, cache kept
    c.advance(1_000); // t = 3 s: the next refresh is a good set
    await expect(v.verify(token())).resolves.toBeTruthy();
    expect(f.calls).toHaveLength(3);
    c.advance(9_000); // 9 s after the recovery: provider down, but inside the window measured from the NEW success
    await expect(v.verify(token())).resolves.toBeTruthy();
    c.advance(2_000); // 11 s after the recovery
    expect(await reason(v.verify(token()))).toBe("keys_unavailable");
  });

  it("single-flight and cooldown are unchanged: concurrent callers share one fetch, and failures are paced", async () => {
    const f = mockFetch([goodSet(), empty(), empty(), empty()]);
    const { c, v, token } = rig(f.fetchImpl, { cooldownMs: 60_000, ttlMs: 1_000, maxStaleMs: 600_000 });
    await v.verify(token());
    c.advance(2_000);
    expect(f.calls).toHaveLength(1);
    await Promise.all([v.verify(token()), v.verify(token()), v.verify(token())]);
    expect(f.calls).toHaveLength(1); // inside the cooldown from the first fetch: no new attempt at all
    c.advance(60_000);
    await Promise.all([v.verify(token()), v.verify(token()), v.verify(token())]);
    expect(f.calls).toHaveLength(2); // one shared attempt
  });
});

/* ====================================================================================================================
 * 2. the size limit is enforced while reading, in bytes
 * ================================================================================================================== */

/** A body delivered in `chunk`-byte pieces that records how much of it was ever asked for and whether the reader gave up. */
function trackedStream(opts: { total?: number; chunk: number; headers?: Record<string, string>; failAfter?: number; payload?: Uint8Array; status?: number }) {
  const state = { pulled: 0, cancelled: false, bytes: 0 };
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(ctl) {
        state.pulled++;
        if (opts.failAfter !== undefined && state.pulled > opts.failAfter) return ctl.error(new Error("connection reset with SECRET-BODY-TEXT"));
        const remaining = opts.total === undefined ? Infinity : opts.total - state.bytes; // undefined total = never ends
        if (remaining <= 0) return ctl.close();
        const n = Math.min(opts.chunk, remaining);
        state.bytes += n;
        ctl.enqueue(opts.payload ? opts.payload.slice(state.bytes - n, state.bytes) : enc.encode("x".repeat(n)));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 }, // exactly one pull per read(): "pulled" is how much the reader actually asked for
  );
  const fetchImpl = (async () => new Response(stream, { status: opts.status ?? 200, headers: opts.headers })) as unknown as typeof fetch;
  return { fetchImpl, state };
}
const bytesOf = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
/** A valid key-set document of EXACTLY `size` bytes (padded with a field the parser ignores). */
function setOfSize(size: number): Uint8Array {
  const base = (pad: string) => bytesOf({ keys: [rsa.jwk], pad });
  const doc = base("x".repeat(Math.max(0, size - base("").length)));
  expect(doc.length).toBe(size);
  return doc;
}

describe("the key-set size limit is enforced while reading", () => {
  const MAX = 4_000;

  it("a declared Content-Length over the limit is refused before the body is read", async () => {
    const t = trackedStream({ total: 100, chunk: 50, headers: { "content-length": String(MAX + 1) } });
    const { v, token } = rig(t.fetchImpl, { maxBytes: MAX });
    expect(await reason(v.verify(token()))).toBe("keys_unavailable");
    expect(t.state.cancelled).toBe(true);
    expect(t.state.pulled).toBeLessThanOrEqual(1);
  });

  it("a body that exceeds the limit with no Content-Length is stopped and cancelled, never fully buffered", async () => {
    const t = trackedStream({ chunk: 1_000 }); // an endless stream
    const { v, token } = rig(t.fetchImpl, { maxBytes: MAX });
    expect(await reason(v.verify(token()))).toBe("keys_unavailable"); // would hang or exhaust memory if the stream were read to its end
    expect(t.state.cancelled).toBe(true);
    expect(t.state.bytes).toBeLessThanOrEqual(MAX + 1_000); // at most the chunk that crossed the line
    expect(t.state.pulled).toBeLessThanOrEqual(6);
  });

  it("a Content-Length that understates the body does not help: the actual bytes are counted", async () => {
    const t = trackedStream({ chunk: 1_000, headers: { "content-length": "10" } });
    const { v, token } = rig(t.fetchImpl, { maxBytes: MAX });
    expect(await reason(v.verify(token()))).toBe("keys_unavailable");
    expect(t.state.cancelled).toBe(true);
    expect(t.state.bytes).toBeLessThanOrEqual(MAX + 1_000);
  });

  it("limits are in bytes: a multibyte body over the byte limit but under it in characters is refused", async () => {
    const filler = "é".repeat(2_500);
    const body = bytesOf({ keys: [rsa.jwk], pad: filler });
    const text = new TextDecoder().decode(body);
    const limit = text.length; // a character-counting check would accept it
    expect(body.length).toBeGreaterThan(limit);
    const t = trackedStream({ total: body.length, chunk: 700, payload: body });
    const { v, token } = rig(t.fetchImpl, { maxBytes: limit });
    expect(await reason(v.verify(token()))).toBe("keys_unavailable");
    expect(t.state.cancelled).toBe(true);
  });

  it("a body exactly at the limit is accepted, and one byte more is not", async () => {
    const exact = setOfSize(MAX);
    const a = rig(trackedStream({ total: exact.length, chunk: 900, payload: exact }).fetchImpl, { maxBytes: MAX });
    await expect(a.v.verify(a.token())).resolves.toBeTruthy();
    const over = setOfSize(MAX + 1);
    const b = rig(trackedStream({ total: over.length, chunk: 900, payload: over }).fetchImpl, { maxBytes: MAX });
    expect(await reason(b.v.verify(b.token()))).toBe("keys_unavailable");
  });

  it("a normal response below the limit works, with and without a Content-Length", async () => {
    const doc = bytesOf({ keys: [rsa.jwk] });
    for (const headers of [undefined, { "content-length": String(doc.length) }]) {
      const { v, token } = rig(trackedStream({ total: doc.length, chunk: 200, payload: doc, headers }).fetchImpl, { maxBytes: MAX });
      await expect(v.verify(token())).resolves.toBeTruthy();
    }
  });

  it("a stream that fails midway, or has no body, is a failed fetch: no cache change, no renewed age, no response text in the error", async () => {
    const good = bytesOf({ keys: [rsa.jwk] });
    const failing = trackedStream({ total: 10_000, chunk: 100, failAfter: 2 });
    let call = 0;
    const fetchImpl = (async (...a: unknown[]) => (call++ === 0 ? new Response(good, { status: 200 }) : call === 2 ? (failing.fetchImpl as any)(...a) : new Response(null, { status: 200 }))) as unknown as typeof fetch;
    const { c, v, token } = rig(fetchImpl, { maxBytes: MAX });
    await v.verify(token()); // good fetch at t0
    c.advance(2_000);
    await expect(v.verify(token())).resolves.toBeTruthy(); // refresh dies mid-stream: the cached key is kept
    c.advance(4_000);
    await expect(v.verify(token())).resolves.toBeTruthy(); // 6 s old; the refresh returns no body at all
    c.advance(5_000); // 11 s since the only good fetch: neither failure renewed it
    const err = await v.verify(token()).catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).reason).toBe("keys_unavailable");
    expect((err as Error).message).not.toContain("SECRET-BODY-TEXT");
    expect(call).toBeGreaterThanOrEqual(3);
  });

  it("with nothing cached, a stream failure surfaces only the fixed 'keys unavailable' error, never anything from the response or the failure", async () => {
    const { v, token } = rig(trackedStream({ total: 10_000, chunk: 100, failAfter: 1 }).fetchImpl, { maxBytes: MAX });
    const err = (await v.verify(token()).catch((e) => e)) as AuthError;
    expect(err).toBeInstanceOf(AuthError);
    expect([err.reason, err.message]).toEqual(["keys_unavailable", "keys_unavailable"]);
    expect(JSON.stringify(err)).not.toContain("SECRET-BODY-TEXT");
    expect(String(err.stack)).not.toContain("SECRET-BODY-TEXT");
  });

  it("an HTTP error response is cancelled and treated as a failed fetch", async () => {
    const t = trackedStream({ chunk: 100, status: 503 });
    const { v, token } = rig(t.fetchImpl, { maxBytes: MAX });
    expect(await reason(v.verify(token()))).toBe("keys_unavailable");
    expect(t.state.cancelled).toBe(true);
  });

  it("an invalid UTF-8 body is a failed fetch, and the existing request rules still hold", async () => {
    const bad = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    const { v, token } = rig(trackedStream({ total: bad.length, chunk: 4, payload: bad }).fetchImpl, { maxBytes: MAX });
    expect(await reason(v.verify(token()))).toBe("keys_unavailable");
    const f = mockFetch([goodSet()]);
    const r = rig(f.fetchImpl);
    await r.v.verify(r.token());
    expect(f.calls[0]!.init.redirect).toBe("error");
    expect(f.calls[0]!.url).toBe(JWKS_URI);
    expect(f.calls[0]!.init.signal).toBeTruthy(); // the timeout signal is still attached
    expect(() => new RemoteJwks({ uri: "http://idp.example.test/jwks" })).toThrow(/https/);
  });
});

/* ====================================================================================================================
 * 3. workspace claims are rate-limited per verified person
 * ================================================================================================================== */

describe("workspace claim attempts are rate-limited", () => {
  const open: Array<() => void> = [];
  afterEach(() => {
    while (open.length) open.pop()?.();
  });
  const jwtFor = (name: string) => signJwt(rsa, claims({ sub: `idp|${name}`, name }));

  function boot(o: { claimMax?: number; windowSec?: number } = {}) {
    const db = openDb(":memory:");
    migrate(db);
    const ctx: AppContext = buildContext({ db, env: {} });
    const runtime = buildAuthRuntime(loadAuthConfig({ ...BASE_ENV, OIDC_ALLOWED_SUBJECTS: "idp|alice,idp|dave,idp|carol", OIDC_CLAIM_SUBJECTS: "idp|alice,idp|dave" }), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS });
    const c = clock();
    const limiter = new RateLimiter(c.now);
    const app = buildServer(ctx, runtime, { claimLimits: { claimMax: o.claimMax ?? 3, claimWindowSec: o.windowSec ?? 3600 }, now: c.now, limiter });
    open.push(() => db.open && db.close());
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const legacy = () => {
      const { workspace, token } = createWorkspace(ctx, "Legacy Co");
      return { id: workspace.id, token };
    };
    const claim = async (who: string, workspaceId: string, token: string) => {
      const res = await app.inject({ method: "POST", url: "/api/workspaces/claim", headers: { authorization: `Bearer ${jwtFor(who)}`, "content-type": "application/json" }, payload: JSON.stringify({ workspaceId, token }) });
      return { status: res.statusCode, text: res.body, headers: res.headers, body: (res.body ? JSON.parse(res.body) : {}) as Record<string, any> };
    };
    return { db, ctx, app, c, limiter, count, legacy, claim, rows: () => [count("SELECT COUNT(*) n FROM users"), count("SELECT COUNT(*) n FROM workspace_memberships"), count("SELECT COUNT(*) n FROM audit_events")] };
  }

  it("the (N+1)th attempt is refused with 429, Retry-After and the project's fixed wording, even with the right token", async () => {
    const w = boot({ claimMax: 3 });
    const ws = w.legacy();
    for (let i = 0; i < 3; i++) expect((await w.claim("alice", ws.id, "msw_wrong")).status).toBe(404); // within quota: the usual wrong-token answer
    const limited = await w.claim("alice", ws.id, ws.token); // the RIGHT token, but over quota
    expect([limited.status, limited.body.error.code, limited.body.error.message]).toEqual([429, "rate_limited", "Too many requests; try again later"]);
    expect(Number(limited.headers["retry-after"])).toBe(3600);
    expect(w.count("SELECT COUNT(*) n FROM workspace_memberships")).toBe(0); // nothing was claimed
    w.c.advance(1_800_000);
    expect(Number((await w.claim("alice", ws.id, ws.token)).headers["retry-after"])).toBe(1800); // an accurate countdown
    w.c.advance(1_801_000); // the window is over
    expect((await w.claim("alice", ws.id, ws.token)).status).toBe(200); // and the genuine claim works again
  });

  it("a limited answer does not depend on the token or the workspace", async () => {
    const w = boot({ claimMax: 1 });
    const ws = w.legacy();
    await w.claim("alice", ws.id, "msw_wrong");
    const a = await w.claim("alice", ws.id, ws.token);
    const b = await w.claim("alice", ws.id, "msw_wrong");
    const c = await w.claim("alice", "ws_unknown", "msw_other");
    for (const r of [a, b, c]) expect(r.status).toBe(429);
    expect(new Set([a.text, b.text, c.text]).size).toBe(1);
  });

  it("each person has their own quota", async () => {
    const w = boot({ claimMax: 2 });
    const ws = w.legacy();
    for (let i = 0; i < 3; i++) await w.claim("alice", ws.id, "msw_wrong");
    expect((await w.claim("alice", ws.id, "msw_wrong")).status).toBe(429);
    expect((await w.claim("dave", ws.id, "msw_wrong")).status).toBe(404); // dave is unaffected
    expect((await w.claim("dave", ws.id, "msw_wrong")).status).toBe(404);
    expect((await w.claim("dave", ws.id, "msw_wrong")).status).toBe(429);
  });

  it("identities that may not claim use no quota, cannot spend anyone else's, and leave no records", async () => {
    const w = boot({ claimMax: 2 });
    const ws = w.legacy();
    await w.claim("alice", ws.id, "msw_wrong"); // alice: 1 of 2 used; her user row exists now
    const sizeBefore = w.limiter.size;
    const rowsBefore = w.rows();
    for (const who of ["carol", "mallory", "erin"]) {
      for (let i = 0; i < 12; i++) {
        const r = await w.claim(who, ws.id, i % 2 ? ws.token : "msw_wrong");
        expect([who, r.status]).toEqual([who, 403]); // never 429: they are refused before any quota exists
        expect(r.body.error.code).toMatch(/^(claim_not_permitted|not_authorized)$/);
      }
    }
    // Exactly one new entry: carol is a registered, signed-in person, so the GENERAL api limiter counts her (api|user:...). She has no claim quota,
    // and mallory and erin (not authorized at all) were refused before any limiter and created nothing.
    expect(w.limiter.size).toBe(sizeBefore + 1);
    expect(w.rows()[1]).toBe(rowsBefore[1]); // no membership
    expect(w.rows()[2]).toBe(rowsBefore[2]); // no audit record
    expect(w.rows()[0]).toBe(rowsBefore[0]! + 1); // only carol (a listed, registered person) has a user row; mallory and erin have none
    expect((await w.claim("alice", ws.id, "msw_wrong")).status).toBe(404); // alice's second attempt: still within her quota
    expect((await w.claim("alice", ws.id, "msw_wrong")).status).toBe(429);
  });

  it("the memory the quota uses is bounded by the existing limiter", async () => {
    const db = openDb(":memory:");
    migrate(db);
    open.push(() => db.close());
    const small = new RateLimiter(() => 0, 20);
    for (let i = 0; i < 5_000; i++) small.hit(`claim|usr_${i}`, 10, 3_600_000);
    expect(small.size).toBeLessThanOrEqual(40);
  });

  it("existing claim behaviour is intact within quota: the listed person claims once, a second listed claimer is refused", async () => {
    const w = boot({ claimMax: 10 });
    const ws = w.legacy();
    const first = await w.claim("alice", ws.id, ws.token);
    expect([first.status, first.body.role]).toEqual([200, "owner"]);
    const second = await w.claim("dave", ws.id, ws.token);
    expect([second.status, second.body.error.code]).toEqual([409, "already_claimed"]);
    expect(w.count("SELECT COUNT(*) n FROM workspace_memberships")).toBe(1);
  });

  it("its settings have safe defaults and are validated at startup, naming variables only", () => {
    expect(loadClaimRateLimits({})).toEqual(DEFAULT_CLAIM_RATE_LIMITS);
    expect(DEFAULT_CLAIM_RATE_LIMITS).toEqual({ claimMax: 10, claimWindowSec: 3600 });
    expect(loadClaimRateLimits({ CLAIM_RL_MAX: "4", CLAIM_RL_WINDOW_SEC: " 60 " })).toEqual({ claimMax: 4, claimWindowSec: 60 });
    for (const bad of ["0", "-1", "1.5", "abc", "1001"]) {
      let msg = "";
      try { loadClaimRateLimits({ CLAIM_RL_MAX: bad }); } catch (e) { msg = (e as Error).message; }
      expect(msg, bad).toMatch(/CLAIM_RL_MAX/);
      expect(msg).not.toContain(bad.length > 2 ? bad : "\u0000");
    }
    expect(() => loadClaimRateLimits({ CLAIM_RL_WINDOW_SEC: "0", CLAIM_RL_MAX: "x" })).toThrow(/CLAIM_RL_MAX.*CLAIM_RL_WINDOW_SEC/);
  });
});
