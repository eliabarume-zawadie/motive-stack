/**
 * Milestone 4.4a: GET /api/workspaces/:wid/credentials, the read-only MASKED status list. Nothing else about credentials is reachable
 * over HTTP. Offline: random in-memory keys, an obviously fake secret, no provider is contacted.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { createWorkspace } from "../src/app/workspaces.js";
import { PERMISSION_MIN_ROLE, ROUTE_PERMISSIONS, userActor, type AuthzContext, type Role } from "../src/auth/authz.js";
import { buildAuthRuntime, loadAuthConfig } from "../src/auth/config.js";
import { StaticJwks } from "../src/auth/jwks.js";
import { KEY_BYTES } from "../src/credentials/crypto.js";
import { LocalKeyring } from "../src/credentials/keys.js";
import { migrate, openDb, type Db } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { AUDIENCE, ISSUER, NOW_MS, claims, makeKey, signJwt , OPEN_POLICY , OIDC_REQUIRED } from "./support/jwt.js";

const SECRET = "FIXTURE-SECRET-VALUE-7f3a9c1e5b2d4f60";
const SECRET2 = "FIXTURE-SECRET-SECOND-91ab34cd56ef7801";
const SECRET3 = "FIXTURE-SECRET-THIRD-5566778899aabbcc";
const rsa = makeKey("RS256", "rsa-1");
const runtime = () => buildAuthRuntime(loadAuthConfig({ AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: "https://idp.example.test/jwks", ...OIDC_REQUIRED }), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS, policy: OPEN_POLICY });
const jwtFor = (name: string) => signJwt(rsa, claims({ sub: `idp|${name}`, name }));
const ENDPOINT = (wid: string) => `/api/workspaces/${wid}/credentials`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

type Json = Record<string, any>;
async function get(app: FastifyInstance, url: string, token?: string, method: "GET" | "HEAD" = "GET", headers: Record<string, string> = {}) {
  const res = await app.inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return { status: res.statusCode, headers: res.headers, text: res.body, body: (res.body ? JSON.parse(res.body) : {}) as Json };
}

async function world(opts: { keys?: LocalKeyring | null } = {}) {
  const db = openDb(":memory:");
  migrate(db);
  const keys = opts.keys === undefined ? new LocalKeyring({ k1: randomBytes(KEY_BYTES) }, "k1") : opts.keys;
  const ctx: AppContext = buildContext({ db, env: {}, keyProvider: keys });
  const app = buildServer(ctx, runtime());
  cleanups.push(() => db.open && db.close());
  const u = {} as Record<"alice" | "bob" | "carol" | "dave" | "erin" | "zed", { token: string; id: string }>;
  for (const name of ["alice", "bob", "carol", "dave", "erin", "zed"] as const) {
    const token = jwtFor(name);
    u[name] = { token, id: (await get(app, "/api/me", token)).body.user.id };
  }
  const mk = async (owner: { token: string }, name: string) =>
    (await app.inject({ method: "POST", url: "/api/workspaces", headers: { authorization: `Bearer ${owner.token}` }, payload: { name } })).json().workspace.id as string;
  const A = await mk(u.alice, "Alpha Co");
  const B = await mk(u.bob, "Bravo Co");
  for (const [who, role] of [["carol", "admin"], ["dave", "operator"], ["erin", "viewer"]] as const) {
    await app.inject({ method: "POST", url: `/api/workspaces/${A}/members`, headers: { authorization: `Bearer ${u.alice.token}` }, payload: { userId: u[who].id, role } });
  }
  const owner = (wid: string, who: { id: string }): AuthzContext => ({ workspaceId: wid, role: "owner", actor: userActor(who.id) });
  if (keys) {
    await ctx.credentials.store(owner(A, u.alice), { kind: "openai", secret: SECRET, label: "Production key" });
    await ctx.credentials.store(owner(A, u.alice), { kind: "meta_graph", secret: SECRET2 });
    await ctx.credentials.store(owner(B, u.bob), { kind: "anthropic", secret: SECRET3, label: "Bravo key" });
  }
  return { db, ctx, app, u, A, B, keys };
}
const tables = (db: Db) => JSON.stringify((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((t) => [t.name, db.prepare(`SELECT * FROM ${t.name}`).all()]), (_k, v) => (Buffer.isBuffer(v) ? v.toString("hex") : v));

describe("who may read masked credential status", () => {
  it("admins and owners get the masked list of their own workspace, and exactly these fields", async () => {
    const w = await world();
    for (const who of ["alice", "carol"] as const) {
      const r = await get(w.app, ENDPOINT(w.A), w.u[who].token);
      expect(r.status, who).toBe(200);
      expect(r.body, who).toEqual({
        available: true,
        credentials: [
          { kind: "meta_graph", status: "active", version: 1, label: null, updatedAt: expect.any(String), updatedBy: `user:${w.u.alice.id}` },
          { kind: "openai", status: "active", version: 1, label: "Production key", updatedAt: expect.any(String), updatedBy: `user:${w.u.alice.id}` },
        ],
      });
      expect(r.body.credentials.every((c: Json) => Object.keys(c).sort().join() === "kind,label,status,updatedAt,updatedBy,version")).toBe(true);
      // no fragment of any secret is shown: not a hint field, and not the trailing characters of either secret
      expect(r.text, who).not.toMatch(/last4|hint|suffix|mask/i);
      for (const secret of [SECRET, SECRET2, SECRET3]) for (const n of [4, 6, 8]) expect(r.text, `${who} last ${n} of a secret`).not.toContain(secret.slice(-n));
    }
  });

  it("viewers, operators, non-members, anonymous callers and the legacy workspace token are refused", async () => {
    const w = await world();
    const ghost = await get(w.app, ENDPOINT("ws_does_not_exist"), w.u.bob.token);
    const members = await get(w.app, `/api/workspaces/${w.A}/members`, w.u.erin.token); // a different route that also refuses a viewer
    const cases: Array<[string, string | undefined, number]> = [["viewer", w.u.erin.token, 403], ["operator", w.u.dave.token, 403], ["non-member", w.u.bob.token, 404], ["unknown person", jwtFor("mallory"), 404], ["anonymous", undefined, 401], ["garbage token", "not.a.token", 401]];
    for (const [label, token, status] of cases) {
      const r = await get(w.app, ENDPOINT(w.A), token);
      expect(r.status, label).toBe(status);
      expect(r.text, label).not.toMatch(/Production key|"credentials":|last4|openai|meta_graph/);
      if (label === "viewer") expect(r.body).toEqual(members.body); // the same generic refusal as any other forbidden route
      if (label === "non-member") expect(r.body).toEqual(ghost.body); // indistinguishable from a workspace that does not exist
    }
  });

  it("the legacy workspace token is refused even though it is admin-equivalent elsewhere, and the vault is never consulted", async () => {
    const w = await world();
    const { workspace, token } = createWorkspace(w.ctx, "Old Co");
    await w.ctx.credentials.store({ workspaceId: workspace.id, role: "owner", actor: userActor(w.u.alice.id) }, { kind: "ghl", secret: SECRET });
    let listed = 0;
    const real = w.ctx.credentials.list.bind(w.ctx.credentials);
    w.ctx.credentials.list = (a) => (listed++, real(a));
    const r = await get(w.app, ENDPOINT(workspace.id), token);
    expect([r.status, r.body.error.code]).toEqual([403, "forbidden"]);
    expect(listed).toBe(0);
    expect((await get(w.app, `/api/workspaces/${workspace.id}/members`, token)).status).toBe(200); // proof the token itself is valid and admin-level
    expect((await get(w.app, ENDPOINT(w.A), token)).status).toBe(401); // and it opens only its own workspace
  });
});

describe("the workspace comes from verified context", () => {
  it("one workspace's credentials are never shown for another, whatever the request says", async () => {
    const w = await world();
    const bravo = await get(w.app, ENDPOINT(w.B), w.u.bob.token);
    expect(bravo.body.credentials.map((c: Json) => [c.kind, c.label])).toEqual([["anthropic", "Bravo key"]]);
    // Alice names Bravo's workspace: not a member, so nothing
    expect((await get(w.app, ENDPOINT(w.B), w.u.alice.token)).status).toBe(404);
    // trying to smuggle a different workspace in through the query, headers or cookies changes nothing
    const sneaky = await get(w.app, `${ENDPOINT(w.A)}?workspaceId=${w.B}&wid=${w.B}`, w.u.alice.token, "GET", { "x-workspace-id": w.B, "x-forwarded-workspace": w.B, cookie: `workspace=${w.B}` });
    expect(sneaky.status).toBe(200);
    expect(sneaky.body.credentials.map((c: Json) => c.kind).sort()).toEqual(["meta_graph", "openai"]);
    expect(sneaky.text).not.toMatch(/anthropic|Bravo key/);
    // a person who belongs to both sees each workspace's own list under that workspace's URL
    await w.app.inject({ method: "POST", url: `/api/workspaces/${w.B}/members`, headers: { authorization: `Bearer ${w.u.bob.token}` }, payload: { userId: w.u.carol.id, role: "admin" } });
    expect((await get(w.app, ENDPOINT(w.B), w.u.carol.token)).body.credentials.map((c: Json) => c.kind)).toEqual(["anthropic"]);
    expect((await get(w.app, ENDPOINT(w.A), w.u.carol.token)).body.credentials.map((c: Json) => c.kind)).toEqual(["meta_graph", "openai"]);
  });

  it("revocation of a member, or a lowered role, takes effect on the next request", async () => {
    const w = await world();
    expect((await get(w.app, ENDPOINT(w.A), w.u.carol.token)).status).toBe(200);
    await w.app.inject({ method: "PATCH", url: `/api/workspaces/${w.A}/members/${w.u.carol.id}`, headers: { authorization: `Bearer ${w.u.alice.token}` }, payload: { role: "operator" } });
    expect((await get(w.app, ENDPOINT(w.A), w.u.carol.token)).status).toBe(403);
    await w.app.inject({ method: "DELETE", url: `/api/workspaces/${w.A}/members/${w.u.carol.id}`, headers: { authorization: `Bearer ${w.u.alice.token}` } });
    expect((await get(w.app, ENDPOINT(w.A), w.u.carol.token)).status).toBe(404);
  });

  it("shows the current state: a revoked credential appears as revoked, and a deleted one as a bare tombstone with no label", async () => {
    const w = await world();
    const alice = { workspaceId: w.A, role: "owner" as Role, actor: userActor(w.u.alice.id) };
    await w.ctx.credentials.revoke(alice, "openai");
    await w.ctx.credentials.delete(alice, "meta_graph");
    const r = await get(w.app, ENDPOINT(w.A), w.u.alice.token);
    expect(r.body.credentials).toEqual([
      { kind: "meta_graph", status: "deleted", version: 1, label: null, updatedAt: expect.any(String), updatedBy: `user:${w.u.alice.id}` },
      { kind: "openai", status: "revoked", version: 1, label: "Production key", updatedAt: expect.any(String), updatedBy: `user:${w.u.alice.id}` },
    ]);
  });
});

describe("when no key provider is configured", () => {
  it("the answer is exactly the documented safe response, for admins and owners only, and says nothing about keys", async () => {
    const live = await world();
    const db = live.db;
    const off = buildContext({ db, env: {}, keyProvider: null });
    expect(off.credentials.available).toBe(false);
    const app = buildServer(off, runtime());
    // stored rows exist (from the first context), but nothing is listed or hinted while the vault is off
    expect((db.prepare("SELECT COUNT(*) n FROM workspace_credentials").get() as { n: number }).n).toBe(3);
    for (const who of ["alice", "carol"] as const) {
      const r = await get(app, ENDPOINT(live.A), live.u[who].token);
      expect([r.status, r.body]).toEqual([200, { available: false, credentials: [] }]);
      expect(r.text).toBe('{"available":false,"credentials":[]}');
      expect(r.text).not.toMatch(/key|provider|keyring|master|configur|openai|meta_graph|last4/i);
    }
    for (const [token, status] of [[live.u.erin.token, 403], [live.u.dave.token, 403], [live.u.bob.token, 404], [undefined, 401]] as const) {
      const r = await get(app, ENDPOINT(live.A), token);
      expect(r.status).toBe(status); // availability is not revealed to someone who may not ask
      expect(r.body.available).toBeUndefined();
    }
  });

  it("is also the answer for a brand-new workspace with the vault on but nothing stored (available, empty)", async () => {
    const w = await world();
    const none = await get(w.app, ENDPOINT(w.A), w.u.alice.token);
    expect(none.body.available).toBe(true);
    const mk = (await w.app.inject({ method: "POST", url: "/api/workspaces", headers: { authorization: `Bearer ${w.u.zed.token}` }, payload: { name: "Fresh Co" } })).json().workspace.id as string;
    expect((await get(w.app, ENDPOINT(mk), w.u.zed.token)).body).toEqual({ available: true, credentials: [] });
  });
});

describe("response headers", () => {
  it("every response about credentials, success or refusal, is marked no-store", async () => {
    const w = await world();
    const off = buildServer(buildContext({ db: w.db, env: {}, keyProvider: null }), runtime());
    const responses = [
      await get(w.app, ENDPOINT(w.A), w.u.alice.token), // 200
      await get(w.app, ENDPOINT(w.A), w.u.erin.token), // 403
      await get(w.app, ENDPOINT(w.A), w.u.bob.token), // 404
      await get(w.app, ENDPOINT(w.A)), // 401
      await get(w.app, ENDPOINT(w.A), w.u.alice.token, "HEAD"),
      await get(w.app, ENDPOINT(w.A), w.u.erin.token, "HEAD"),
      await get(off, ENDPOINT(w.A), w.u.alice.token), // vault off
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 403, 404, 401, 200, 403, 200]);
    for (const r of responses) expect(r.headers["cache-control"]).toBe("no-store");
    expect(responses[4]!.text).toBe(""); // HEAD has no body
    // and the header is not sprayed onto unrelated routes
    expect((await get(w.app, `/api/workspaces/${w.A}/members`, w.u.alice.token)).headers["cache-control"]).toBeUndefined();
  });
});

describe("read-only, and no secret anywhere", () => {
  it("the route changes nothing: no user, audit, credential or any other row is written by reading", async () => {
    const w = await world();
    const before = tables(w.db);
    for (const who of ["alice", "carol", "erin", "dave", "bob", "zed"] as const) await get(w.app, ENDPOINT(w.A), w.u[who].token);
    await get(w.app, ENDPOINT(w.A));
    expect(tables(w.db)).toBe(before);
  });

  it("nothing can reveal, export or bulk-change credentials over HTTP: every other method and sub-path does not exist", async () => {
    const w = await world();
    const before = tables(w.db);
    const attempts: Array<["GET" | "POST" | "PUT" | "PATCH" | "DELETE", string]> = [["POST", ""], ["PUT", ""], ["PATCH", ""], ["DELETE", ""], ["POST", "/openai"], ["PATCH", "/openai"], ["GET", "/openai"], ["PUT", "/openai/revoke"], ["GET", "/openai/revoke"], ["DELETE", "/openai/revoke"], ["GET", "/openai/reveal"], ["POST", "/openai/reveal"], ["GET", "/export"], ["GET", "/openai/secret"]];
    for (const [method, suffix] of attempts) {
      const r = await w.app.inject({ method, url: `${ENDPOINT(w.A)}${suffix}`, headers: { authorization: `Bearer ${w.u.alice.token}` }, payload: method === "GET" ? undefined : { secret: SECRET, kind: "openai" } });
      expect(r.statusCode, `${method} ${suffix}`).toBe(404);
      expect(r.body).not.toContain(SECRET);
    }
    expect(tables(w.db)).toBe(before);
    await w.app.ready();
    const credRoutes = w.app.routeTable.filter((r) => /credential/i.test(r.url));
    expect([...new Set(credRoutes.map((r) => `${r.method === "HEAD" ? "GET" : r.method} ${r.url}`))].sort()).toEqual(["DELETE /api/workspaces/:wid/credentials/:kind", "GET /api/workspaces/:wid/credentials", "POST /api/workspaces/:wid/credentials/:kind/revoke", "PUT /api/workspaces/:wid/credentials/:kind"]);
  });

  it("no secret, ciphertext, wrapped key, key id or key configuration appears in any response, header or error", async () => {
    const w = await world();
    const row = w.db.prepare("SELECT sealed, wrapped_dek FROM workspace_credentials WHERE kind = 'openai'").get() as { sealed: Buffer; wrapped_dek: Buffer };
    const seen: string[] = [];
    const tokens: Array<string | undefined> = [w.u.alice.token, w.u.carol.token, w.u.dave.token, w.u.erin.token, w.u.bob.token, w.u.zed.token, undefined, "garbage"];
    const off = buildServer(buildContext({ db: w.db, env: {}, keyProvider: null }), runtime());
    for (const app of [w.app, off]) {
      for (const token of tokens) {
        for (const method of ["GET", "HEAD"] as const) {
          const r = await get(app, ENDPOINT(w.A), token, method);
          seen.push(JSON.stringify([r.status, r.headers, r.text]));
        }
      }
    }
    // the error path for a request the server cannot parse or route
    for (const url of [`${ENDPOINT(w.A)}%00`, `${ENDPOINT(w.A)}/..%2f..`, `${ENDPOINT("x".repeat(500))}`]) seen.push((await get(w.app, url, w.u.alice.token)).text);
    const all = seen.join("\n");
    for (const needle of [SECRET, SECRET2, SECRET3, row.sealed.toString("hex"), row.sealed.toString("base64"), row.wrapped_dek.toString("hex"), row.wrapped_dek.toString("base64"), "k1", "protectedBy", "key_id", "sealed", "wrapped", "master", "keyring", "CREDENTIAL_"]) {
      expect(all, needle).not.toContain(needle);
    }
  });
});

describe("the permission inventory", () => {
  it("lists the route with the credentials.read permission, and that permission is admin-level", () => {
    expect(ROUTE_PERMISSIONS["GET /api/workspaces/:wid/credentials"]).toBe("credentials.read");
    expect(PERMISSION_MIN_ROLE["credentials.read"]).toBe("admin");
    expect(PERMISSION_MIN_ROLE["credentials.manage"]).toBe("owner");
    // the only non-GET credential routes are the three owner-only writes, each with credentials.manage
    expect(Object.entries(ROUTE_PERMISSIONS).filter(([k]) => !k.startsWith("GET ") && /credential/i.test(k)).map(([k, v]) => `${k} -> ${v}`).sort()).toEqual([
      "DELETE /api/workspaces/:wid/credentials/:kind -> credentials.manage",
      "POST /api/workspaces/:wid/credentials/:kind/revoke -> credentials.manage",
      "PUT /api/workspaces/:wid/credentials/:kind -> credentials.manage",
    ]);
  });
});
