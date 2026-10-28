/**
 * Milestone 4.4b: owner-only credential write routes (PUT / revoke / DELETE) with strict input, If-Match concurrency control, an in-process
 * rate limiter, and audit. Offline: random in-memory keys, obviously fake secrets, a fake clock for the limiter. Nothing here consumes a
 * credential or contacts any provider.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { isMetaAccountAuthorized } from "../src/app/metaAccounts.js";
import { createWorkspaceForUser } from "../src/app/memberships.js";
import { upsertUser } from "../src/app/users.js";
import { createWorkspace } from "../src/app/workspaces.js";
import { userActor } from "../src/auth/authz.js";
import { buildAuthRuntime, loadAuthConfig } from "../src/auth/config.js";
import { StaticJwks } from "../src/auth/jwks.js";
import { KEY_BYTES } from "../src/credentials/crypto.js";
import { LocalKeyring, type KeyProvider } from "../src/credentials/keys.js";
import { migrate, openDb, type Db } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { DEFAULT_CREDENTIAL_RATE_LIMITS, RateLimiter, loadCredentialRateLimits, type CredentialRateLimits } from "../src/server/rateLimit.js";
import { AUDIENCE, ISSUER, NOW_MS, claims, makeKey, signJwt , OPEN_POLICY , OIDC_REQUIRED } from "./support/jwt.js";

const SECRET = "FIXTURE-SECRET-VALUE-7f3a9c1e5b2d4f60";
const SECRET2 = "FIXTURE-SECRET-SECOND-91ab34cd56ef7801";
const SECRET3 = "FIXTURE-SECRET-THIRD-5566778899aabbcc";
const ECHO = "ECHO-SENTINEL-value-123456";
const rsa = makeKey("RS256", "rsa-1");
const runtime = () => buildAuthRuntime(loadAuthConfig({ AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: "https://idp.example.test/jwks", ...OIDC_REQUIRED }), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS, policy: OPEN_POLICY });
const jwtFor = (name: string) => signJwt(rsa, claims({ sub: `idp|${name}`, name }));
const ident = (n: string) => ({ issuer: ISSUER, subject: `idp|${n}`, email: null, displayName: n });

/** Limits high enough that tests about something else never trip them. */
const ROOMY: CredentialRateLimits = { callerMax: 1000, workspaceMax: 10_000, windowSec: 60, failureMax: 1000, failureWindowSec: 300, lockoutSec: 900, deniedAuditMax: 1000 };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  vi.restoreAllMocks();
});

type Json = Record<string, any>;
interface Reply { status: number; headers: Record<string, any>; text: string; body: Json }
async function send(app: FastifyInstance, method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE", url: string, o: { token?: string; body?: unknown; raw?: string; type?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  let payload: string | undefined;
  if (o.raw !== undefined) payload = o.raw;
  else if (o.body !== undefined) payload = JSON.stringify(o.body);
  if (payload !== undefined) headers["content-type"] = o.type ?? "application/json";
  const res = await app.inject({ method, url, headers, payload });
  let body: Json = {};
  try { body = res.body ? JSON.parse(res.body) : {}; } catch { /* non-JSON error body */ }
  return { status: res.statusCode, headers: res.headers, text: res.body, body };
}

const count = (db: Db, sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
const dump = (db: Db): string => {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((t) => t.name);
  return tables.flatMap((t) => (db.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>).flatMap((r) => Object.values(r).map((v) => (Buffer.isBuffer(v) ? `${v.toString("utf8")}|${v.toString("hex")}|${v.toString("base64")}` : String(v))))).join("\n");
};

interface WorldOptions { keys?: KeyProvider | null; limits?: Partial<CredentialRateLimits>; now?: () => number; env?: Record<string, string> }
async function world(o: WorldOptions = {}) {
  const db = openDb(":memory:");
  migrate(db);
  const keys = o.keys === undefined ? new LocalKeyring({ k1: randomBytes(KEY_BYTES) }, "k1") : o.keys;
  const ctx: AppContext = buildContext({ db, env: o.env ?? {}, keyProvider: o.env ? undefined : keys });
  const app = buildServer(ctx, runtime(), { rateLimits: { ...ROOMY, ...o.limits }, now: o.now });
  cleanups.push(() => db.open && db.close());
  const u = {} as Record<"alice" | "bob" | "carol" | "dave" | "erin" | "zed", { token: string; id: string }>;
  for (const name of ["alice", "bob", "carol", "dave", "erin", "zed"] as const) {
    const token = jwtFor(name);
    u[name] = { token, id: (await send(app, "GET", "/api/me", { token })).body.user.id };
  }
  const mk = async (owner: { token: string }, name: string) => (await send(app, "POST", "/api/workspaces", { token: owner.token, body: { name } })).body.workspace.id as string;
  const A = await mk(u.alice, "Alpha Co");
  const B = await mk(u.bob, "Bravo Co");
  for (const [who, role] of [["carol", "admin"], ["dave", "operator"], ["erin", "viewer"]] as const) {
    await send(app, "POST", `/api/workspaces/${A}/members`, { token: u.alice.token, body: { userId: u[who].id, role } });
  }
  const url = (wid: string, kind?: string, suffix = "") => `/api/workspaces/${wid}/credentials${kind ? `/${kind}` : ""}${suffix}`;
  const put = (wid: string, kind: string, body: unknown, token = u.alice.token, ifMatch?: string | number) =>
    send(app, "PUT", url(wid, kind), { token, body, headers: ifMatch === undefined ? {} : { "if-match": String(ifMatch) } });
  const revoke = (wid: string, kind: string, token = u.alice.token, ifMatch?: string | number, body?: unknown) =>
    send(app, "POST", url(wid, kind, "/revoke"), { token, body, headers: ifMatch === undefined ? {} : { "if-match": String(ifMatch) } });
  const del = (wid: string, kind: string, token = u.alice.token, ifMatch?: string | number, body?: unknown) =>
    send(app, "DELETE", url(wid, kind), { token, body, headers: ifMatch === undefined ? {} : { "if-match": String(ifMatch) } });
  const list = (wid: string, token = u.alice.token) => send(app, "GET", url(wid), { token });
  const rows = (kind = "openai", wid = A) => db.prepare("SELECT version, status, label, sealed IS NULL s FROM workspace_credentials WHERE workspace_id = ? AND kind = ? ORDER BY version").all(wid, kind) as Array<{ version: number; status: string; label: string | null; s: number }>;
  const audits = (like = "credential.%") => db.prepare("SELECT type, actor, workspace_id, entity_id, detail FROM audit_events WHERE type LIKE ? ORDER BY id").all(like) as Array<{ type: string; actor: string; workspace_id: string; entity_id: string; detail: string }>;
  const used = async (wid: string, kind: "openai" | "anthropic" | "meta_graph" | "ghl") => ctx.credentials.use(wid, kind, (s) => s.toString("utf8"));
  return { db, ctx, app, u, A, B, url, put, revoke, del, list, rows, audits, used, keys };
}
type W = Awaited<ReturnType<typeof world>>;

describe("creating a credential", () => {
  it("an owner creates one: 201, masked status only, ETag with the version, and the secret stored encrypted", async () => {
    const w = await world();
    const r = await w.put(w.A, "openai", { secret: SECRET, label: "Production key" });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ outcome: "created", credential: { kind: "openai", status: "active", version: 1, label: "Production key", updatedAt: expect.any(String), updatedBy: `user:${w.u.alice.id}` } });
    expect(r.headers.etag).toBe('"1"');
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.text).not.toContain(SECRET);
    expect(await w.used(w.A, "openai")).toBe(SECRET);
    expect(dump(w.db)).not.toContain(SECRET);
    expect((await w.list(w.A)).body.credentials).toEqual([{ kind: "openai", status: "active", version: 1, label: "Production key", updatedAt: expect.any(String), updatedBy: `user:${w.u.alice.id}` }]);
  });

  it("accepts `application/json; charset=utf-8`, a label of null, and a maximum-length secret", async () => {
    const w = await world();
    const long = "A".repeat(4096);
    const r = await send(w.app, "PUT", w.url(w.A, "anthropic"), { token: w.u.alice.token, raw: JSON.stringify({ secret: long, label: null }), type: "application/json; charset=utf-8" });
    expect([r.status, r.body.credential.label]).toEqual([201, null]);
    expect(await w.used(w.A, "anthropic")).toBe(long);
  });
});

describe("who may write", () => {
  it("only an owner who is a signed-in person; everyone else is refused on all three routes and nothing changes", async () => {
    const w = await world();
    await w.put(w.A, "openai", { secret: SECRET, label: "keep me" });
    const { workspace: legacy, token: legacyToken } = createWorkspace(w.ctx, "Old Co");
    const before = dump(w.db);
    const ghost = await send(w.app, "PUT", w.url("ws_does_not_exist", "openai"), { token: w.u.bob.token, body: { secret: SECRET2 } });
    const cases: Array<[string, string | undefined, number]> = [["viewer", w.u.erin.token, 403], ["operator", w.u.dave.token, 403], ["admin", w.u.carol.token, 403], ["non-member", w.u.bob.token, 404], ["unknown person", jwtFor("mallory"), 404], ["anonymous", undefined, 401], ["garbage token", "not.a.token", 401]];
    for (const [label, token, status] of cases) {
      const put = await send(w.app, "PUT", w.url(w.A, "openai"), { token, body: { secret: SECRET2 }, headers: { "if-match": "1" } });
      const rev = await send(w.app, "POST", w.url(w.A, "openai", "/revoke"), { token, headers: { "if-match": "1" } });
      const del = await send(w.app, "DELETE", w.url(w.A, "openai"), { token, headers: { "if-match": "1" } });
      expect([label, put.status, rev.status, del.status]).toEqual([label, status, status, status]);
      if (label === "non-member") expect(put.body).toEqual(ghost.body); // indistinguishable from a workspace that does not exist
      for (const r of [put, rev, del]) expect(r.headers["cache-control"]).toBe("no-store");
    }
    // the legacy workspace token is admin-equivalent elsewhere, but it is not a person
    const lput = await send(w.app, "PUT", w.url(legacy.id, "openai"), { token: legacyToken, body: { secret: SECRET2 } });
    expect([lput.status, lput.body.error.code]).toEqual([403, "forbidden"]);
    expect((await send(w.app, "GET", `/api/workspaces/${legacy.id}/members`, { token: legacyToken })).status).toBe(200); // the token itself is valid
    expect((await send(w.app, "PUT", w.url(w.A, "openai"), { token: legacyToken, body: { secret: SECRET2 } })).status).toBe(401); // and opens only its own workspace
    expect(dump(w.db).replace(/credential\.denied[^\n]*/g, "")).toContain("keep me");
    expect(w.rows()).toEqual([{ version: 1, status: "active", label: "keep me", s: 0 }]);
    expect(await w.used(w.A, "openai")).toBe(SECRET);
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials")).toBe(1);
    void before;
  });

  it("records refusals of identified callers without any body data, and nothing for anonymous callers or non-members", async () => {
    const w = await world();
    const { workspace: legacy, token: legacyToken } = createWorkspace(w.ctx, "Old Co");
    for (const token of [w.u.erin.token, w.u.dave.token, w.u.carol.token]) {
      await send(w.app, "PUT", w.url(w.A, "openai"), { token, body: { secret: SECRET, label: ECHO } });
      await send(w.app, "POST", w.url(w.A, "meta_graph", "/revoke"), { token });
      await send(w.app, "DELETE", w.url(w.A, "ghl"), { token });
    }
    await send(w.app, "PUT", w.url(legacy.id, "openai"), { token: legacyToken, body: { secret: SECRET } });
    await send(w.app, "PUT", w.url(w.A, "openai"), { token: w.u.bob.token, body: { secret: SECRET } }); // non-member
    await send(w.app, "PUT", w.url(w.A, "openai"), { body: { secret: SECRET } }); // anonymous
    const denied = w.audits("credential.denied");
    expect(denied).toHaveLength(10);
    const who = denied.map((d) => d.actor);
    for (const a of [`user:${w.u.erin.id}`, `user:${w.u.dave.id}`, `user:${w.u.carol.id}`]) expect(who.filter((x) => x === a)).toHaveLength(3);
    expect(who).toContain(`workspace-token:${legacy.id}`);
    expect(who).not.toContain(`user:${w.u.bob.id}`);
    const ops = denied.map((d) => JSON.parse(d.detail) as Json);
    for (const d of ops) expect(Object.keys(d).sort()).toEqual(["operation", "reason"]);
    expect(new Set(ops.map((d) => d.operation))).toEqual(new Set(["store", "revoke", "delete"]));
    expect(ops.filter((d) => d.reason === "person_only")).toHaveLength(1);
    expect(JSON.stringify(denied)).not.toMatch(new RegExp(`${SECRET}|${ECHO}`));
    expect(denied.map((d) => d.entity_id).sort()).toEqual(["ghl", "ghl", "ghl", "meta_graph", "meta_graph", "meta_graph", "openai", "openai", "openai", "openai"]);
  });

  it("the workspace is the one the caller belongs to under the URL: nothing in the body, query, headers or cookies redirects a write", async () => {
    const w = await world();
    // Bravo's owner cannot write to Alpha, and Alpha's owner cannot write to Bravo
    expect((await w.put(w.A, "openai", { secret: SECRET }, w.u.bob.token)).status).toBe(404);
    expect((await w.put(w.B, "openai", { secret: SECRET }, w.u.alice.token)).status).toBe(404);
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials")).toBe(0);
    // smuggled workspace ids
    expect((await w.put(w.A, "openai", { secret: SECRET, workspaceId: w.B })).status).toBe(400);
    expect((await send(w.app, "PUT", `${w.url(w.A, "openai")}?workspaceId=${w.B}`, { token: w.u.alice.token, body: { secret: SECRET } })).status).toBe(400);
    const sneaky = await send(w.app, "PUT", w.url(w.A, "openai"), { token: w.u.alice.token, body: { secret: SECRET }, headers: { "x-workspace-id": w.B, cookie: `workspace=${w.B}`, "x-forwarded-workspace": w.B } });
    expect(sneaky.status).toBe(201);
    expect(w.rows("openai", w.A)).toHaveLength(1);
    expect(w.rows("openai", w.B)).toHaveLength(0);
    // a person who owns both writes to the one in the URL
    await send(w.app, "POST", `/api/workspaces/${w.B}/members`, { token: w.u.bob.token, body: { userId: w.u.alice.id, role: "owner" } });
    expect((await w.put(w.B, "anthropic", { secret: SECRET2 })).status).toBe(201);
    expect([w.rows("anthropic", w.A).length, w.rows("anthropic", w.B).length]).toEqual([0, 1]);
    expect(await w.used(w.B, "anthropic")).toBe(SECRET2);
  });

  it("a lowered role or a removed member loses the ability on the next request", async () => {
    const w = await world();
    await send(w.app, "PATCH", `/api/workspaces/${w.A}/members/${w.u.carol.id}`, { token: w.u.alice.token, body: { role: "owner" } });
    expect((await w.put(w.A, "openai", { secret: SECRET }, w.u.carol.token)).status).toBe(201);
    await send(w.app, "PATCH", `/api/workspaces/${w.A}/members/${w.u.carol.id}`, { token: w.u.alice.token, body: { role: "admin" } });
    expect((await w.put(w.A, "openai", { secret: SECRET2 }, w.u.carol.token, 1)).status).toBe(403);
    await send(w.app, "DELETE", `/api/workspaces/${w.A}/members/${w.u.carol.id}`, { token: w.u.alice.token });
    expect((await w.put(w.A, "openai", { secret: SECRET2 }, w.u.carol.token, 1)).status).toBe(404);
    expect(await w.used(w.A, "openai")).toBe(SECRET);
  });
});

describe("strict request handling", () => {
  it("requires a JSON content type; other types are refused before any parsing", async () => {
    const w = await world();
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/xml", "application/jsonx"]) {
      const r = await send(w.app, "PUT", w.url(w.A, "openai"), { token: w.u.alice.token, raw: `secret=${ECHO}`, type });
      expect(r.status, type).toBe(415);
      expect(r.text, type).not.toContain(ECHO);
      expect(r.headers["cache-control"]).toBe("no-store");
    }
    const none = await w.app.inject({ method: "PUT", url: w.url(w.A, "openai"), headers: { authorization: `Bearer ${w.u.alice.token}` }, payload: JSON.stringify({ secret: SECRET }) });
    expect([none.statusCode, none.body]).toEqual([415, expect.not.stringContaining(SECRET)]);
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials")).toBe(0);
  });

  it("accepts only utf-8 JSON: another charset or an extra media-type parameter is refused", async () => {
    const w = await world();
    for (const type of ["application/json; charset=utf-16", "application/json; charset=latin1", "application/json; foo=bar", "application/json; charset=utf-8; foo=bar", "application/json,text/plain"]) {
      expect((await send(w.app, "PUT", w.url(w.A, "openai"), { token: w.u.alice.token, raw: JSON.stringify({ secret: SECRET }), type })).status, type).toBe(415);
    }
    const accepted = ["application/json", "Application/JSON", "application/json; charset=utf-8", 'application/json; charset="UTF-8"'];
    const kinds = ["openai", "anthropic", "meta_graph", "ghl"];
    for (const [i, type] of accepted.entries()) {
      expect((await send(w.app, "PUT", w.url(w.A, kinds[i]!), { token: w.u.alice.token, raw: JSON.stringify({ secret: SECRET }), type })).status, type).toBe(201);
    }
  });

  it("refuses query strings on every write route, without repeating them", async () => {
    const w = await world();
    await w.put(w.A, "openai", { secret: SECRET });
    for (const [method, suffix] of [["PUT", ""], ["POST", "/revoke"], ["DELETE", ""]] as const) {
      const r = await send(w.app, method, `${w.url(w.A, "openai", suffix)}?${ECHO}=1&secret=${SECRET2}`, { token: w.u.alice.token, body: method === "PUT" ? { secret: SECRET3 } : undefined, headers: { "if-match": "1" } });
      expect([r.status, r.body.error.code]).toEqual([400, "query_not_allowed"]);
      expect(r.text).not.toMatch(new RegExp(`${ECHO}|${SECRET2}|${SECRET3}`));
    }
    expect(await w.used(w.A, "openai")).toBe(SECRET);
    expect(w.rows()).toHaveLength(1);
  });

  it("rejects missing, extra, mistyped and malformed bodies with a fixed message that repeats nothing", async () => {
    const w = await world();
    const bodies: unknown[] = [
      {}, { secret: SECRET, extra: ECHO }, { secret: SECRET, [ECHO]: 1 }, { secret: SECRET, kind: "openai" }, { secret: SECRET, workspaceId: w.B },
      { secret: 12345678901234567890 }, { secret: null }, { secret: [SECRET] }, { secret: { value: SECRET } }, { secret: SECRET, label: 7 }, { secret: SECRET, label: { x: ECHO } },
      [SECRET], null, "just a string", 42,
    ];
    for (const body of bodies) {
      const r = await send(w.app, "PUT", w.url(w.A, "openai"), { token: w.u.alice.token, raw: JSON.stringify(body) });
      expect([r.status, r.body.error?.code], JSON.stringify(body)?.slice(0, 40)).toEqual([400, "validation"]);
      expect(r.text).not.toMatch(new RegExp(`${ECHO}|${SECRET}|issues`));
    }
    const empty = await send(w.app, "PUT", w.url(w.A, "openai"), { token: w.u.alice.token, raw: "" });
    expect(empty.status).toBe(400);
    for (const raw of ["{", `{"secret": "${ECHO}`, "not json at all"]) {
      const r = await send(w.app, "PUT", w.url(w.A, "openai"), { token: w.u.alice.token, raw });
      expect(r.status, raw).toBe(400);
      expect(r.text, raw).not.toContain(ECHO);
    }
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials")).toBe(0);
  });

  it("applies the vault's own rules to the secret and the label without echoing them", async () => {
    const w = await world();
    const bad: Array<[string, Json]> = [
      ["has spaces", { secret: "FIXTURE SECRET WITH SPACES 1234" }], ["newline", { secret: `${SECRET}\nX-Injected: ${ECHO}` }], ["too short", { secret: "short" }],
      ["too long", { secret: "A".repeat(4097) }], ["non-ascii", { secret: `${SECRET}é` }], ["label contains secret", { secret: SECRET, label: `k ${SECRET}` }],
      ["label too long", { secret: SECRET, label: "x".repeat(81) }], ["label control", { secret: SECRET, label: "a\nb" }], ["label leading space", { secret: SECRET, label: " x" }],
    ];
    for (const [name, body] of bad) {
      const r = await w.put(w.A, "openai", body);
      expect([name, r.status, r.body.error.code]).toEqual([name, 400, "validation"]);
      expect(r.text, name).not.toMatch(new RegExp(`${SECRET}|${ECHO}|SPACES|x{20}`));
    }
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials")).toBe(0);
  });

  it("limits the body to a few kilobytes and says nothing about the content", async () => {
    const w = await world();
    const big = await send(w.app, "PUT", w.url(w.A, "openai"), { token: w.u.alice.token, raw: JSON.stringify({ secret: SECRET, label: "x".repeat(9000) }) });
    expect(big.status).toBe(413);
    expect(big.text).not.toContain(SECRET);
    expect(big.headers["cache-control"]).toBe("no-store");
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials")).toBe(0);
    // an unauthenticated oversized body is refused (401) before it is read
    expect((await send(w.app, "PUT", w.url(w.A, "openai"), { raw: JSON.stringify({ secret: "x".repeat(300_000) }) })).status).toBe(401);
  });

  it("only the four known kinds exist, in exactly that spelling", async () => {
    const w = await world();
    for (const kind of ["OpenAI", "stripe", "openai ", "openai%20", "..", "meta-graph", ECHO]) {
      const r = await send(w.app, "PUT", `/api/workspaces/${w.A}/credentials/${encodeURIComponent(kind)}`, { token: w.u.alice.token, body: { secret: SECRET } });
      expect([kind, r.status]).toEqual([kind, 404]);
      expect(r.text).not.toMatch(new RegExp(`${ECHO}|stripe`));
    }
    for (const kind of ["openai", "anthropic", "meta_graph", "ghl"]) expect((await w.put(w.A, kind, { secret: `${SECRET}-${kind}` })).status).toBe(201);
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials")).toBe(4);
  });
});

describe("If-Match, creation and replacement", () => {
  it("replacing needs the current version: missing is 428, wrong is 412, right replaces and erases the old secret", async () => {
    const w = await world();
    await w.put(w.A, "openai", { secret: SECRET, label: "v1" });
    const missing = await w.put(w.A, "openai", { secret: SECRET2, label: "v2" });
    expect([missing.status, missing.body.error.code]).toEqual([428, "precondition_required"]);
    for (const wrong of [0 + 2, 99]) expect((await w.put(w.A, "openai", { secret: SECRET2 }, w.u.alice.token, wrong)).status).toBe(412);
    expect(await w.used(w.A, "openai")).toBe(SECRET);
    const ok = await w.put(w.A, "openai", { secret: SECRET2, label: "v2" }, w.u.alice.token, 1);
    expect([ok.status, ok.body.outcome, ok.body.credential.version, ok.headers.etag]).toEqual([200, "replaced", 2, '"2"']);
    expect(await w.used(w.A, "openai")).toBe(SECRET2);
    expect(w.rows()).toEqual([{ version: 1, status: "revoked", label: "v1", s: 1 }, { version: 2, status: "active", label: "v2", s: 0 }]);
    expect(dump(w.db)).not.toContain(SECRET);
  });

  it("accepts the version as 1, \"1\" or W/\"1\", and rejects every other spelling with 400", async () => {
    const w = await world();
    await w.put(w.A, "openai", { secret: SECRET });
    for (const bad of ["*", "abc", "0", "01", "1.5", "-1", "1, 2", "1234567890", " ", "\"\"", "1;2"]) {
      const r = await w.put(w.A, "openai", { secret: SECRET2 }, w.u.alice.token, bad);
      expect([bad, r.status, r.body.error?.code]).toEqual([bad, 400, "invalid_precondition"]);
    }
    expect((await w.put(w.A, "openai", { secret: SECRET2 }, w.u.alice.token, '"1"')).status).toBe(200);
    expect((await w.put(w.A, "openai", { secret: SECRET3 }, w.u.alice.token, 'W/"2"')).status).toBe(200);
    expect((await w.put(w.A, "openai", { secret: SECRET }, w.u.alice.token, "3")).status).toBe(200);
    expect(w.rows().map((r) => r.version)).toEqual([1, 2, 3, 4]);
  });

  it("creation: no If-Match when nothing is stored; an If-Match when nothing exists is stale (412); after an ended credential the next version continues", async () => {
    const w = await world();
    expect((await w.put(w.A, "openai", { secret: SECRET }, w.u.alice.token, 1)).status).toBe(412); // nothing to match
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials")).toBe(0);
    expect((await w.put(w.A, "openai", { secret: SECRET })).body.credential.version).toBe(1);
    expect((await w.revoke(w.A, "openai", w.u.alice.token, 1)).status).toBe(200);
    // after a revoke the version is required to create again (a stale retry must not bring a revoked credential back); a wrong one is 412
    expect((await w.put(w.A, "openai", { secret: SECRET2 })).status).toBe(428);
    expect((await w.put(w.A, "openai", { secret: SECRET2 }, w.u.alice.token, 7)).status).toBe(412);
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials WHERE status = 'active'")).toBe(0);
    const again = await w.put(w.A, "openai", { secret: SECRET2 }, w.u.alice.token, 1);
    expect([again.status, again.body.outcome, again.body.credential.version]).toEqual([201, "created", 2]);
    await w.del(w.A, "openai", w.u.alice.token, 2);
    expect((await w.put(w.A, "openai", { secret: SECRET3 })).status).toBe(428); // after a delete too
    const third = await w.put(w.A, "openai", { secret: SECRET3 }, w.u.alice.token, 2);
    expect([third.status, third.body.credential.version]).toEqual([201, 3]);
    expect(await w.used(w.A, "openai")).toBe(SECRET3);
  });

  it("an identical request is safe to repeat: nothing changes, nothing is returned, one 'unchanged' record is kept", async () => {
    const w = await world();
    await w.put(w.A, "openai", { secret: SECRET, label: "main" });
    const stored = w.audits().map((a) => a.type);
    const retry = await w.put(w.A, "openai", { secret: SECRET, label: "main" }); // e.g. the first response was lost: no If-Match
    expect([retry.status, retry.body.outcome, retry.body.credential.version, retry.headers.etag]).toEqual([200, "unchanged", 1, '"1"']);
    const withMatch = await w.put(w.A, "openai", { secret: SECRET, label: "main" }, w.u.alice.token, 1);
    expect([withMatch.status, withMatch.body.outcome]).toEqual([200, "unchanged"]);
    expect(w.rows()).toEqual([{ version: 1, status: "active", label: "main", s: 0 }]);
    expect(w.audits().map((a) => a.type)).toEqual([...stored, "credential.unchanged", "credential.unchanged"]);
    expect(retry.text).not.toContain(SECRET);
    // a stale precondition still wins over "it is already that value"
    await w.put(w.A, "openai", { secret: SECRET2 }, w.u.alice.token, 1);
    expect((await w.put(w.A, "openai", { secret: SECRET2 }, w.u.alice.token, 1)).status).toBe(412);
    // the same secret under a different label is a change, so it needs the version
    expect((await w.put(w.A, "openai", { secret: SECRET2, label: "renamed" })).status).toBe(428);
    expect((await w.put(w.A, "openai", { secret: SECRET2, label: "renamed" }, w.u.alice.token, 2)).body.credential.version).toBe(3);
  });

  it("a stale writer cannot overwrite newer state", async () => {
    const w = await world();
    await w.put(w.A, "openai", { secret: SECRET });
    const readByBoth = (await w.list(w.A)).body.credentials[0].version;
    expect((await w.put(w.A, "openai", { secret: SECRET2 }, w.u.alice.token, readByBoth)).status).toBe(200); // the first client wins
    const late = await w.put(w.A, "openai", { secret: SECRET3 }, w.u.alice.token, readByBoth); // the second still believes it is version 1
    expect([late.status, late.body.error.code]).toEqual([412, "precondition_failed"]);
    expect(await w.used(w.A, "openai")).toBe(SECRET2);
    expect(dump(w.db)).not.toContain(SECRET3);
  });
});

describe("concurrent writes", () => {
  it("ten simultaneous creations leave exactly one credential, and the others are told so", async () => {
    const w = await world();
    const secrets = Array.from({ length: 10 }, (_, i) => `FIXTURE-CONCURRENT-SECRET-${String(i).padStart(2, "0")}-abcdef012345`);
    const replies = await Promise.all(secrets.map((s) => w.put(w.A, "openai", { secret: s })));
    const statuses = replies.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s !== 201).every((s) => s === 428 || s === 409)).toBe(true);
    expect(w.rows()).toHaveLength(1);
    const winner = replies.findIndex((r) => r.status === 201);
    expect(await w.used(w.A, "openai")).toBe(secrets[winner]);
    for (const r of replies) expect(r.text).not.toMatch(/FIXTURE-CONCURRENT/);
  });

  it("simultaneous identical creations leave one version", async () => {
    const w = await world();
    const replies = await Promise.all([1, 2, 3, 4].map(() => w.put(w.A, "openai", { secret: SECRET, label: "same" })));
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(replies.every((r) => [201, 200, 409, 428].includes(r.status))).toBe(true);
    expect(w.rows()).toHaveLength(1);
    expect(await w.used(w.A, "openai")).toBe(SECRET);
  });

  it("simultaneous replacements with the same version: one wins, the rest are refused, and a losing secret is never stored", async () => {
    const w = await world();
    await w.put(w.A, "openai", { secret: SECRET });
    const losers = [SECRET2, SECRET3, "FIXTURE-SECRET-FOURTH-0011223344556677"];
    const replies = await Promise.all(losers.map((s) => w.put(w.A, "openai", { secret: s }, w.u.alice.token, 1)));
    expect(replies.filter((r) => r.status === 200)).toHaveLength(1);
    expect(replies.filter((r) => r.status !== 200).every((r) => r.status === 412 || r.status === 409)).toBe(true);
    expect(w.rows().map((r) => r.version)).toEqual([1, 2]);
    const winner = losers[replies.findIndex((r) => r.status === 200)];
    expect(await w.used(w.A, "openai")).toBe(winner);
    for (const s of [SECRET, ...losers.filter((s) => s !== winner)]) expect(dump(w.db)).not.toContain(s);
  });

  it("a replacement racing a revoke ends in one consistent state", async () => {
    const w = await world();
    await w.put(w.A, "openai", { secret: SECRET });
    const [p, r] = await Promise.all([w.put(w.A, "openai", { secret: SECRET2 }, w.u.alice.token, 1), w.revoke(w.A, "openai", w.u.alice.token, 1)]);
    expect([p.status, r.status].filter((s) => s === 200)).not.toHaveLength(0);
    const active = w.rows().filter((x) => x.status === "active");
    expect(active.length).toBeLessThanOrEqual(1);
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials WHERE status = 'active' AND sealed IS NULL")).toBe(0);
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials WHERE status <> 'active' AND sealed IS NOT NULL")).toBe(0);
  });
});

/** A key service that takes a moment, so concurrent requests really do overlap between their checks and their writes. */
function slowKeys(ms = 15): KeyProvider {
  const inner = new LocalKeyring({ k1: randomBytes(KEY_BYTES) }, "k1");
  return { name: "slow", activeKeyId: () => inner.activeKeyId(), wrap: async (d, c) => (await new Promise((r) => setTimeout(r, ms)), inner.wrap(d, c)), unwrap: (k, w, c) => inner.unwrap(k, w, c), hasKey: (k) => inner.hasKey(k) };
}

describe("writes that genuinely overlap (a slow key service keeps every request in flight at once)", () => {
  it("ten simultaneous creations: exactly one is created and the other nine are told the credential changed", async () => {
    const w = await world({ keys: slowKeys() });
    const secrets = Array.from({ length: 10 }, (_, i) => `FIXTURE-OVERLAP-SECRET-${String(i).padStart(2, "0")}-abcdef012345`);
    const replies = await Promise.all(secrets.map((s) => w.put(w.A, "openai", { secret: s })));
    expect(replies.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
    expect(replies.find((r) => r.status === 409)!.body.error.code).toBe("credential_changed");
    expect(w.rows()).toHaveLength(1);
    expect(await w.used(w.A, "openai")).toBe(secrets[replies.findIndex((r) => r.status === 201)]);
    for (const loser of secrets.filter((_, i) => i !== replies.findIndex((r) => r.status === 201))) expect(dump(w.db)).not.toContain(loser);
  });

  it("three replacements that all hold the same version: one wins, two are refused, and neither loser is stored", async () => {
    const w = await world({ keys: slowKeys() });
    await w.put(w.A, "openai", { secret: SECRET });
    const contenders = [SECRET2, SECRET3, "FIXTURE-SECRET-FOURTH-0011223344556677"];
    const replies = await Promise.all(contenders.map((s) => w.put(w.A, "openai", { secret: s }, w.u.alice.token, 1)));
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(w.rows().map((r) => r.version)).toEqual([1, 2]);
    const winner = contenders[replies.findIndex((r) => r.status === 200)]!;
    expect(await w.used(w.A, "openai")).toBe(winner);
    for (const s of [SECRET, ...contenders.filter((s) => s !== winner)]) expect(dump(w.db)).not.toContain(s);
  });

  it("identical simultaneous creations: one is created, none is duplicated", async () => {
    const w = await world({ keys: slowKeys() });
    const replies = await Promise.all([1, 2, 3, 4].map(() => w.put(w.A, "openai", { secret: SECRET, label: "same" })));
    expect(replies.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect(w.rows()).toHaveLength(1);
  });

  it("a replacement overlapping a revoke ends in a consistent state: the old secret is gone, and at most one credential is live", async () => {
    const w = await world({ keys: slowKeys() });
    await w.put(w.A, "openai", { secret: SECRET });
    const [p, r] = await Promise.all([w.put(w.A, "openai", { secret: SECRET2 }, w.u.alice.token, 1), w.revoke(w.A, "openai", w.u.alice.token, 1)]);
    expect(r.status).toBe(200);
    expect([201, 409]).toContain(p.status); // 409 if the revoke landed while the replacement was in flight, 201 if it landed first and the request then created
    expect(dump(w.db)).not.toContain(SECRET);
    const live = w.rows().filter((x) => x.status === "active");
    expect(live.length).toBe(p.status === 201 ? 1 : 0);
    if (p.status === 201) expect(await w.used(w.A, "openai")).toBe(SECRET2);
  });
});

describe("revoking and deleting", () => {
  it("revoke needs the version (428 / 412), erases the secret, shows as revoked, and a repeat is safe", async () => {
    const w = await world();
    await w.put(w.A, "openai", { secret: SECRET, label: "main" });
    expect((await w.revoke(w.A, "openai")).body.error.code).toBe("precondition_required");
    expect((await w.revoke(w.A, "openai", w.u.alice.token, 5)).body.error.code).toBe("precondition_failed");
    expect(await w.used(w.A, "openai")).toBe(SECRET);
    const r = await w.revoke(w.A, "openai", w.u.alice.token, 1);
    expect([r.status, r.body.outcome, r.body.credential.status, r.headers.etag]).toEqual([200, "revoked", "revoked", '"1"']);
    await expect(w.used(w.A, "openai")).rejects.toMatchObject({ status: 404 });
    expect(w.rows()).toEqual([{ version: 1, status: "revoked", label: "main", s: 1 }]);
    const again = await w.revoke(w.A, "openai", w.u.alice.token, 1); // the response was lost; the client retries
    expect([again.status, again.body.outcome]).toEqual([200, "unchanged"]);
    expect(w.audits("credential.revoked")).toHaveLength(1);
    expect(w.audits("credential.unchanged")).toHaveLength(1);
    expect((await w.list(w.A)).body.credentials[0]).toMatchObject({ kind: "openai", status: "revoked" });
  });

  it("revoking with a version that has since been superseded is refused, and revoking what never existed or was deleted is a 404", async () => {
    const w = await world();
    expect((await w.revoke(w.A, "openai", w.u.alice.token, 1)).status).toBe(404);
    await w.put(w.A, "openai", { secret: SECRET });
    await w.put(w.A, "openai", { secret: SECRET2 }, w.u.alice.token, 1);
    expect((await w.revoke(w.A, "openai", w.u.alice.token, 1)).status).toBe(412); // a retry of an older request must not revoke newer state
    expect(await w.used(w.A, "openai")).toBe(SECRET2);
    await w.del(w.A, "openai", w.u.alice.token, 2);
    expect((await w.revoke(w.A, "openai", w.u.alice.token, 2)).status).toBe(404);
  });

  it("delete needs the version, forgets the label of every version, and a repeat is safe; it also works on a revoked credential", async () => {
    const w = await world();
    await w.put(w.A, "openai", { secret: SECRET, label: "first" });
    await w.put(w.A, "openai", { secret: SECRET2, label: "second" }, w.u.alice.token, 1);
    expect((await w.del(w.A, "openai")).status).toBe(428);
    expect((await w.del(w.A, "openai", w.u.alice.token, 1)).status).toBe(412);
    const d = await w.del(w.A, "openai", w.u.alice.token, 2);
    expect([d.status, d.body.outcome, d.body.credential.status, d.body.credential.label]).toEqual([200, "deleted", "deleted", null]);
    expect(w.rows()).toEqual([{ version: 1, status: "deleted", label: null, s: 1 }, { version: 2, status: "deleted", label: null, s: 1 }]);
    expect(dump(w.db)).not.toMatch(/first|second|FIXTURE-SECRET/);
    expect((await w.del(w.A, "openai", w.u.alice.token, 2)).body.outcome).toBe("unchanged");
    expect(w.audits("credential.deleted")).toHaveLength(1);
    // delete after revoke
    await w.put(w.A, "ghl", { secret: SECRET3, label: "crm" });
    await w.revoke(w.A, "ghl", w.u.alice.token, 1);
    expect((await w.del(w.A, "ghl", w.u.alice.token, 1)).body.outcome).toBe("deleted");
    expect((await w.del(w.A, "anthropic", w.u.alice.token, 1)).status).toBe(404); // never stored
    expect((await w.put(w.A, "openai", { secret: SECRET }, w.u.alice.token, 2)).body.credential.version).toBe(3); // history continues
  });

  it("revoke and delete take no body: {} is fine, anything else is refused, and a body of the wrong type is refused before parsing", async () => {
    const w = await world();
    await w.put(w.A, "openai", { secret: SECRET });
    expect((await w.revoke(w.A, "openai", w.u.alice.token, 1, { extra: ECHO })).status).toBe(400);
    expect((await w.del(w.A, "openai", w.u.alice.token, 1, { secret: SECRET2 })).status).toBe(400);
    const text = await send(w.app, "DELETE", w.url(w.A, "openai"), { token: w.u.alice.token, raw: ECHO, type: "text/plain", headers: { "if-match": "1" } });
    expect([text.status, text.text.includes(ECHO)]).toEqual([415, false]);
    expect(await w.used(w.A, "openai")).toBe(SECRET);
    expect((await w.revoke(w.A, "openai", w.u.alice.token, 1, {})).status).toBe(200);
  });
});

describe("when the vault is unavailable", () => {
  it("every write fails closed with 503 and a fixed message, and stores nothing", async () => {
    const w = await world({ keys: null });
    expect(w.ctx.credentials.available).toBe(false);
    const replies = [
      await w.put(w.A, "openai", { secret: SECRET }),
      await w.revoke(w.A, "openai", w.u.alice.token, 1),
      await w.del(w.A, "openai", w.u.alice.token, 1),
    ];
    for (const r of replies) {
      expect([r.status, r.body.error.code]).toEqual([503, "credentials_unavailable"]);
      expect(r.text).not.toMatch(/key|keyring|provider|master|CREDENTIAL_/i);
      expect(r.headers["cache-control"]).toBe("no-store");
    }
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials")).toBe(0);
    expect(dump(w.db)).not.toContain(SECRET);
    // callers who may not write are refused as usual, so the state of the vault is not disclosed to them
    expect((await w.put(w.A, "openai", { secret: SECRET }, w.u.erin.token)).status).toBe(403);
    expect((await w.list(w.A)).body).toEqual({ available: false, credentials: [] });
  });

  it("a master key in the environment is ignored unless explicitly allowed, and then the routes are closed; with the explicit opt-in they work", async () => {
    const keyring = { CREDENTIAL_KEYRING: `k1:${randomBytes(32).toString("base64")}`, CREDENTIAL_ACTIVE_KEY: "k1" };
    const closed = await world({ env: keyring });
    expect(closed.ctx.credentials.available).toBe(false);
    expect((await closed.put(closed.A, "openai", { secret: SECRET })).status).toBe(503);
    const open = await world({ env: { ...keyring, DEPLOYMENT_ENV: "development", CREDENTIAL_ALLOW_LOCAL_KEYRING: "true" } });
    expect(open.ctx.credentials.available).toBe(true);
    expect((await open.put(open.A, "openai", { secret: SECRET })).status).toBe(201);
  });
});

describe("rate limiting", () => {
  const clock = () => {
    let t = 10_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it("limits each caller per workspace, tells them when to retry, and starts again after the window", async () => {
    const c = clock();
    const w = await world({ limits: { callerMax: 3, windowSec: 60 }, now: c.now });
    for (let i = 0; i < 3; i++) expect([201, 200]).toContain((await w.put(w.A, "openai", { secret: SECRET }, w.u.alice.token)).status === 201 ? 201 : 200);
    const limited = await w.put(w.A, "openai", { secret: SECRET });
    expect([limited.status, limited.body.error.code, limited.body.error.message]).toEqual([429, "rate_limited", "Too many requests; try again later"]);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(limited.headers["cache-control"]).toBe("no-store");
    expect(limited.text).not.toMatch(/caller|workspace|failure|\d+ requests/i); // says nothing about which limit
    await w.put(w.A, "openai", { secret: SECRET }); // still limited: one audit record per window, not per request
    expect(w.audits("credential.rate_limited")).toHaveLength(1);
    expect(JSON.parse(w.audits("credential.rate_limited")[0]!.detail)).toEqual({ operation: "store", scope: "caller" });
    expect((await w.list(w.A)).status).toBe(200); // reading is not limited
    c.advance(61_000);
    expect((await w.put(w.A, "openai", { secret: SECRET })).status).toBe(200);
  });

  it("limits each workspace across all of its owners", async () => {
    const c = clock();
    const w = await world({ limits: { callerMax: 100, workspaceMax: 4 }, now: c.now });
    await send(w.app, "PATCH", `/api/workspaces/${w.A}/members/${w.u.carol.id}`, { token: w.u.alice.token, body: { role: "owner" } });
    const statuses: number[] = [];
    for (const token of [w.u.alice.token, w.u.carol.token, w.u.alice.token, w.u.carol.token, w.u.alice.token]) statuses.push((await w.put(w.A, "openai", { secret: SECRET }, token)).status);
    expect(statuses.slice(0, 4).every((s) => s === 201 || s === 200)).toBe(true);
    expect(statuses[4]).toBe(429);
    expect(JSON.parse(w.audits("credential.rate_limited")[0]!.detail).scope).toBe("workspace");
    expect((await w.put(w.B, "openai", { secret: SECRET2 }, w.u.bob.token)).status).toBe(201); // another workspace is unaffected
  });

  it("repeated client errors lock the caller out for a while; successes do not erase them; the lockout ends", async () => {
    const c = clock();
    const w = await world({ limits: { failureMax: 3, failureWindowSec: 300, lockoutSec: 900 }, now: c.now });
    await w.put(w.A, "openai", { secret: SECRET });
    // four failures: a missing precondition, a stale one, a bad body, an unknown kind
    expect((await w.put(w.A, "openai", { secret: SECRET2 })).status).toBe(428);
    expect((await w.put(w.A, "openai", { secret: SECRET2 }, w.u.alice.token, 9)).status).toBe(412);
    expect((await w.put(w.A, "openai", { nope: 1 })).status).toBe(400);
    expect((await w.put(w.A, "stripe", { secret: SECRET2 })).status).toBe(404);
    const locked = await w.put(w.A, "openai", { secret: SECRET2 }, w.u.alice.token, 1); // would have succeeded
    expect([locked.status, locked.body.error.code]).toEqual([429, "rate_limited"]);
    expect(await w.used(w.A, "openai")).toBe(SECRET);
    expect(JSON.parse(w.audits("credential.rate_limited")[0]!.detail).scope).toBe("failures");
    // the lockout is per caller and workspace
    expect((await w.put(w.B, "openai", { secret: SECRET3 }, w.u.bob.token)).status).toBe(201);
    c.advance(899_000);
    expect((await w.put(w.A, "openai", { secret: SECRET2 }, w.u.alice.token, 1)).status).toBe(429);
    c.advance(2_000);
    expect((await w.put(w.A, "openai", { secret: SECRET2 }, w.u.alice.token, 1)).status).toBe(200);
  });

  it("one person's lockout in one workspace does not follow them to another workspace they own", async () => {
    const c = clock();
    const w = await world({ limits: { failureMax: 2, lockoutSec: 600 }, now: c.now });
    await send(w.app, "POST", `/api/workspaces/${w.B}/members`, { token: w.u.bob.token, body: { userId: w.u.alice.id, role: "owner" } });
    for (let i = 0; i < 3; i++) await w.put(w.A, "stripe", { secret: SECRET }); // alice locks herself out of Alpha
    expect((await w.put(w.A, "openai", { secret: SECRET })).status).toBe(429);
    expect((await w.put(w.B, "openai", { secret: SECRET })).status).toBe(201); // the same person in Bravo is unaffected
    expect((await w.put(w.A, "openai", { secret: SECRET }, w.u.alice.token)).status).toBe(429);
  });

  it("refusals the parser makes (wrong type, oversized) count as failures too, and a limited caller is turned away before the body is read", async () => {
    const c = clock();
    const w = await world({ limits: { failureMax: 2, lockoutSec: 600 }, now: c.now });
    for (let i = 0; i < 3; i++) await send(w.app, "PUT", w.url(w.A, "openai"), { token: w.u.alice.token, raw: "x", type: "text/plain" });
    const limited = await send(w.app, "PUT", w.url(w.A, "openai"), { token: w.u.alice.token, raw: "{ this is not json" });
    expect(limited.status).toBe(429); // not 400: the body was never parsed
    expect((await send(w.app, "PUT", w.url(w.A, "openai"), { token: w.u.alice.token, raw: JSON.stringify({ x: "y".repeat(10_000) }) })).status).toBe(429);
  });

  it("refused callers cannot use up an owner's quota, and they cannot flood the audit trail", async () => {
    const c = clock();
    const w = await world({ limits: { callerMax: 2, deniedAuditMax: 3 }, now: c.now });
    for (let i = 0; i < 20; i++) expect((await w.put(w.A, "openai", { secret: SECRET }, w.u.erin.token)).status).toBe(403);
    expect(w.audits("credential.denied")).toHaveLength(3);
    expect((await w.put(w.A, "openai", { secret: SECRET })).status).toBe(201); // the owner's budget is untouched
    expect((await w.put(w.A, "openai", { secret: SECRET })).status).toBe(200);
  });

  it("the settings are configurable, validated, and documented defaults apply when unset", () => {
    expect(loadCredentialRateLimits({})).toEqual(DEFAULT_CREDENTIAL_RATE_LIMITS);
    expect(loadCredentialRateLimits({ CREDENTIAL_RL_CALLER_MAX: "7", CREDENTIAL_RL_LOCKOUT_SEC: "30", CREDENTIAL_RL_WINDOW_SEC: " 5 " })).toMatchObject({ callerMax: 7, lockoutSec: 30, windowSec: 5, workspaceMax: DEFAULT_CREDENTIAL_RATE_LIMITS.workspaceMax });
    for (const bad of ["0", "-1", "1.5", "abc", "99999999", "1e3", "0x10"]) {
      let msg = "";
      try { loadCredentialRateLimits({ CREDENTIAL_RL_CALLER_MAX: bad }); } catch (e) { msg = (e as Error).message; }
      expect(msg, bad).toMatch(/CREDENTIAL_RL_CALLER_MAX/);
      expect(msg).not.toContain(bad === "abc" ? "abc" : "never-present");
    }
    expect(() => loadCredentialRateLimits({ CREDENTIAL_RL_WINDOW_SEC: "0", CREDENTIAL_RL_FAILURE_MAX: "x" })).toThrow(/CREDENTIAL_RL_WINDOW_SEC.*CREDENTIAL_RL_FAILURE_MAX/);
  });

  it("the limiter itself: windows reset, locks outlive windows, and memory stays bounded under a flood of keys", () => {
    let t = 0;
    const l = new RateLimiter(() => t, 100);
    expect([l.hit("a", 2, 1000).allowed, l.hit("a", 2, 1000).allowed, l.hit("a", 2, 1000).allowed]).toEqual([true, true, false]);
    expect(l.hit("a", 2, 1000).retryAfterMs).toBe(1000);
    t = 1000;
    expect(l.hit("a", 2, 1000).allowed).toBe(true);
    expect([l.fail("f", 1, 1000, 5000), l.fail("f", 1, 1000, 5000)]).toEqual([false, true]);
    t = 3000; // the failure window has passed but the lock has not
    expect(l.lockedFor("f")).toBe(3000);
    t = 6001;
    expect(l.lockedFor("f")).toBe(0);
    for (let i = 0; i < 5000; i++) l.hit(`key-${i}`, 1, 60_000);
    expect(l.size).toBeLessThanOrEqual(100);
  });
});

describe("no secret in any response, header, log, audit event or database row", () => {
  it("across every kind of request, success and failure", async () => {
    const out: string[] = [];
    const sinks = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "debug")];
    for (const sink of sinks) sink.mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const w = await world();
    expect(readFileSync("src/server/app.ts", "utf8")).toMatch(/Fastify\(\{ logger: false/); // request logging is off by construction, so bodies are never logged
    const record = (r: Reply) => out.push(JSON.stringify([r.status, r.headers, r.text]));
    record(await w.put(w.A, "openai", { secret: SECRET, label: "main" }));
    record(await w.put(w.A, "openai", { secret: SECRET, label: "main" }));
    record(await w.put(w.A, "openai", { secret: SECRET2 }));
    record(await w.put(w.A, "openai", { secret: SECRET2 }, w.u.alice.token, 9));
    record(await w.put(w.A, "openai", { secret: SECRET2 }, w.u.alice.token, 1));
    record(await w.put(w.A, "openai", { secret: SECRET, extra: SECRET3 }));
    record(await send(w.app, "PUT", w.url(w.A, "openai"), { token: w.u.alice.token, raw: `{"secret":"${SECRET}` }));
    record(await send(w.app, "PUT", w.url(w.A, "openai"), { token: w.u.alice.token, raw: SECRET, type: "text/plain" }));
    record(await send(w.app, "PUT", `${w.url(w.A, "openai")}?s=${SECRET}`, { token: w.u.alice.token, body: { secret: SECRET3 } }));
    record(await w.put(w.A, "openai", { secret: SECRET3 }, w.u.erin.token));
    record(await w.put(w.A, "openai", { secret: SECRET3 }, w.u.bob.token));
    record(await w.put(w.A, "openai", { secret: SECRET3 }, undefined as unknown as string));
    record(await w.revoke(w.A, "openai", w.u.alice.token, 2));
    record(await w.del(w.A, "openai", w.u.alice.token, 2));
    record(await w.list(w.A));
    record(await send(w.app, "GET", `/api/workspaces/${w.A}/activity`, { token: w.u.alice.token }));
    const everything = [out.join("\n"), dump(w.db), ...sinks.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c))), ...[stdout, stderr].flatMap((s) => s.mock.calls.map((c) => String(c[0])))].join("\n");
    for (const secret of [SECRET, SECRET2, SECRET3]) for (const form of [secret, Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("hex"), encodeURIComponent(secret)]) {
      expect(everything.includes(form), `${form.slice(0, 14)}...`).toBe(false);
    }
    // audit events carry only these facts
    const allowed = new Set(["kind", "version", "previous", "versions", "operation", "scope", "reason"]);
    for (const a of w.audits()) for (const k of Object.keys(JSON.parse(a.detail))) expect(allowed.has(k), `${a.type}.${k}`).toBe(true);
    expect(w.audits().length).toBeGreaterThan(5);
  });

  it("clears the request body once the handler is done, on success and on failure", async () => {
    const db = openDb(":memory:");
    migrate(db);
    cleanups.push(() => db.open && db.close());
    const ctx = buildContext({ db, env: {}, keyProvider: new LocalKeyring({ k1: randomBytes(KEY_BYTES) }, "k1") });
    const app = buildServer(ctx, runtime(), { rateLimits: ROOMY });
    const seen: unknown[] = [];
    app.addHook("onResponse", async (req) => void seen.push(req.body));
    const owner = upsertUser(ctx, ident("alice"));
    const ws = createWorkspaceForUser(ctx, userActor(owner.id) as never, "Alpha Co");
    const token = jwtFor("alice");
    const ok = await send(app, "PUT", `/api/workspaces/${ws.id}/credentials/openai`, { token, body: { secret: SECRET } });
    const bad = await send(app, "PUT", `/api/workspaces/${ws.id}/credentials/stripe`, { token, body: { secret: SECRET } });
    expect([ok.status, bad.status]).toEqual([201, 404]);
    expect(seen).toEqual([undefined, undefined]);
  });
});

describe("credential storage stays separate from Meta ad-account authorization and from any use", () => {
  it("storing, replacing and deleting a Meta credential authorizes no account, and nothing reads a stored credential", async () => {
    const w = await world();
    const useSpy = vi.spyOn(w.ctx.credentials, "use");
    await w.put(w.A, "meta_graph", { secret: SECRET });
    await w.put(w.A, "meta_graph", { secret: SECRET2 }, w.u.alice.token, 1);
    await w.revoke(w.A, "meta_graph", w.u.alice.token, 2);
    await w.del(w.A, "meta_graph", w.u.alice.token, 2);
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_meta_accounts")).toBe(0);
    expect(isMetaAccountAuthorized(w.ctx, w.A, "act_111")).toBe(false);
    expect(useSpy).not.toHaveBeenCalled();
    // and an ad-account authorization writes no credential
    const before = count(w.db, "SELECT COUNT(*) n FROM workspace_credentials");
    w.db.prepare("INSERT INTO workspace_meta_accounts (id, workspace_id, account_id, status, source, created_at, created_by, updated_at, updated_by) VALUES ('m1', ?, 'act_111', 'active', 'owner_assertion', 't','x','t','x')").run(w.A);
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials")).toBe(before);
  });
});

describe("the permission inventory and headers for every outcome", () => {
  it("lists exactly the three writes with credentials.manage, and every outcome carries no-store", async () => {
    const w = await world();
    await w.app.ready();
    const writes = [...new Set(w.app.routeTable.filter((r) => /credentials/.test(r.url) && r.method !== "GET" && r.method !== "HEAD").map((r) => `${r.method} ${r.url}`))].sort();
    expect(writes).toEqual(["DELETE /api/workspaces/:wid/credentials/:kind", "POST /api/workspaces/:wid/credentials/:kind/revoke", "PUT /api/workspaces/:wid/credentials/:kind"]);
    const replies = [
      await w.put(w.A, "openai", { secret: SECRET }), // 201
      await w.put(w.A, "openai", { secret: SECRET }), // 200 unchanged
      await w.put(w.A, "openai", { secret: SECRET2 }), // 428
      await w.put(w.A, "openai", { secret: SECRET2 }, w.u.alice.token, 9), // 412
      await w.put(w.A, "openai", { nope: 1 }), // 400
      await w.put(w.A, "stripe", { secret: SECRET }), // 404
      await w.put(w.A, "openai", { secret: SECRET }, w.u.erin.token), // 403
      await w.put(w.A, "openai", { secret: SECRET }, w.u.bob.token), // 404
      await send(w.app, "PUT", w.url(w.A, "openai"), { body: { secret: SECRET } }), // 401
      await send(w.app, "PUT", w.url(w.A, "openai"), { token: w.u.alice.token, raw: "x", type: "text/plain" }), // 415
      await send(w.app, "PUT", w.url(w.A, "openai"), { token: w.u.alice.token, raw: JSON.stringify({ secret: "x".repeat(9000) }) }), // 413
      await w.revoke(w.A, "openai", w.u.alice.token, 1), // 200
      await w.del(w.A, "openai", w.u.alice.token, 1), // 200
      await send(w.app, "GET", `${w.url(w.A, "openai")}/nope`, { token: w.u.alice.token }), // 404, unknown sub-path
    ];
    expect(replies.map((r) => r.status)).toEqual([201, 200, 428, 412, 400, 404, 403, 404, 401, 415, 413, 200, 200, 404]);
    for (const r of replies) expect(r.headers["cache-control"], String(r.status)).toBe("no-store");
  });
});

describe("migration 008 removes the stored hint and keeps everything else", () => {
  it("drops the column from a database that has 007 and real credentials, leaving the encrypted data intact and readable", async () => {
    const w = await world();
    await w.put(w.A, "openai", { secret: SECRET, label: "main" });
    // put the database back in its pre-008 shape, with a hint in it
    w.db.exec("ALTER TABLE workspace_credentials ADD COLUMN last4 TEXT");
    w.db.prepare("UPDATE workspace_credentials SET last4 = 'Zq9X'").run();
    w.db.prepare("DELETE FROM schema_migrations WHERE name = '008_drop_credential_hint.sql'").run();
    const sealedBefore = (w.db.prepare("SELECT sealed, wrapped_dek, key_id FROM workspace_credentials").get() as { sealed: Buffer; wrapped_dek: Buffer; key_id: string });
    expect(migrate(w.db)).toEqual(["008_drop_credential_hint.sql"]);
    const cols = (w.db.prepare("PRAGMA table_info(workspace_credentials)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain("last4");
    const after = w.db.prepare("SELECT sealed, wrapped_dek, key_id FROM workspace_credentials").get() as { sealed: Buffer; wrapped_dek: Buffer; key_id: string };
    expect(after.sealed.equals(sealedBefore.sealed) && after.wrapped_dek.equals(sealedBefore.wrapped_dek) && after.key_id === sealedBefore.key_id).toBe(true);
    expect(await w.used(w.A, "openai")).toBe(SECRET);
    expect(() => w.db.prepare("INSERT INTO workspace_credentials (id, workspace_id, kind, version, status, created_at, created_by, updated_at, updated_by) VALUES ('c','w','openai',9,'active','t','x','t','x')").run()).toThrow(/CHECK|FOREIGN/); // constraints survive
    expect(migrate(w.db)).toEqual([]);
  });

  it("leaves migration 007 exactly as it was applied (history is preserved) and erases the hint from the database file", () => {
    expect(readFileSync("src/db/migrations/007_credentials.sql", "utf8")).toContain("last4 TEXT CHECK");
    expect(readFileSync("src/db/migrations/008_drop_credential_hint.sql", "utf8")).toMatch(/DROP COLUMN last4/);
    const dir = mkdtempSync(join(tmpdir(), "ms-008-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "t.db");
    const db = openDb(file);
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const f of readdirSync("src/db/migrations").filter((n) => n.endsWith(".sql") && n < "008").sort()) {
      db.exec(readFileSync(`src/db/migrations/${f}`, "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES (?, 'then')").run(f);
    }
    db.prepare("INSERT INTO workspaces (id, name, token_hash, created_at) VALUES ('w','W','h','t')").run();
    db.prepare("INSERT INTO workspace_credentials (id, workspace_id, kind, version, status, last4, sealed, wrapped_dek, key_id, created_at, created_by, updated_at, updated_by) VALUES ('c','w','openai',1,'active','Zq9X', x'0102', x'0304', 'k1', 't','x','t','x')").run();
    expect(migrate(db)).toEqual(["008_drop_credential_hint.sql", "009_website_analysis.sql", "010_website_content_hash.sql", "011_ai_reservations.sql", "012_reservation_state_and_fill_ledger.sql", "013_campaign_plans.sql", "014_lead_status_job_retries.sql", "015_organizations_permissions.sql", "016_brand_kit_assets.sql", "017_plans_lifecycle.sql", "018_creative_studio.sql", "019_team_operations.sql"]);
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f)).includes(Buffer.from("Zq9X")), f).toBe(false);
  });
});
