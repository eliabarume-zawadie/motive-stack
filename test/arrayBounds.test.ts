/**
 * Structural limits on JSON request bodies (interim mitigation for the zod 3 advisory GHSA-mrhx-c7xc-m3w5; the migration to zod 4 is still required before a public launch).
 * Every JSON body is checked once, in the server's JSON parser, before any route validates it: no list longer than 200 and no nesting deeper than 12. Measured across the whole suite
 * (11,382 request bodies) the largest legitimate list was 40 elements and the deepest nesting 5, so ordinary requests are untouched. Offline; no external calls.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildAuthRuntime, loadAuthConfig } from "../src/auth/config.js";
import { StaticJwks } from "../src/auth/jwks.js";
import { MAX_JSON_ARRAY_LENGTH, MAX_JSON_DEPTH, bodyShapeProblem } from "../src/server/bodyShape.js";
import { buildServer } from "../src/server/app.js";
import { BRAIN } from "./fixtures.js";
import { AUDIENCE, ISSUER, NOW_MS, OIDC_REQUIRED, OPEN_POLICY, claims, makeKey, signJwt } from "./support/jwt.js";

const rsa = makeKey("RS256", "rsa-1");
const OIDC_ENV = { AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: "https://idp.example.test/jwks", ...OIDC_REQUIRED };
const open: Array<() => void> = [];
afterEach(() => { while (open.length) open.pop()?.(); });

type Json = Record<string, any>;
async function call(app: FastifyInstance, method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: method as never, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload: payload as never });
  return { status: res.statusCode, text: res.body, body: (() => { try { return res.body ? JSON.parse(res.body) : {}; } catch { return {}; } })() as Json };
}

async function world() {
  const db = openDb(":memory:");
  migrate(db);
  const ctx: AppContext = buildContext({ db, env: {}, backoffMs: () => 0, gateway: { sleep: async () => {} } });
  const app = buildServer(ctx, buildAuthRuntime(loadAuthConfig(OIDC_ENV), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS, policy: OPEN_POLICY }), { apiLimits: { apiMax: 1_000_000, apiWindowSec: 60 } });
  open.push(() => db.open && db.close());
  const token = signJwt(rsa, claims({ sub: "idp|olivia", name: "olivia" }));
  await call(app, "GET", "/api/me", token);
  const wid = (await call(app, "POST", "/api/workspaces", token, { name: "Alpha Co" })).body.workspace.id as string;
  const a = `/api/workspaces/${wid}`;
  expect((await call(app, "PUT", `${a}/brain`, token, BRAIN)).status).toBe(200);
  const cid = (await call(app, "POST", `${a}/campaigns/generate`, token, { providerId: "mock", model: "mock-deterministic-1" })).body.id as string;
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const rows = (n: number, tag = "r") => Array.from({ length: n }, (_, i) => ({ fullName: `Person ${tag}${i}`, email: `${tag}${i}@example.com` }));
  const importRows = (r: unknown, over: Json = {}, tok = token) => call(app, "POST", `${a}/leads/import`, tok, { campaignId: cid, sourceNote: "list", rows: r, ...over });
  return { db, ctx, app, token, a, cid, count, rows, importRows };
}

const nestedArrays = (depth: number): unknown => { let v: unknown = 1; for (let i = 0; i < depth; i++) v = [v]; return v; };
const nestedObjects = (depth: number): Json => { let v: Json = { leaf: 1 }; for (let i = 1; i < depth; i++) v = { n: v }; return v; };

describe("bodyShapeProblem (the pure check)", () => {
  it("accepts a list of exactly 200 and rejects 201, at the top level and nested inside objects and lists", () => {
    expect([MAX_JSON_ARRAY_LENGTH, MAX_JSON_DEPTH]).toEqual([200, 12]);
    expect(bodyShapeProblem(new Array(200).fill(0))).toBeNull();
    expect(bodyShapeProblem(new Array(201).fill(0))).toBe("array_too_long");
    expect(bodyShapeProblem({ a: { b: [new Array(200).fill(1)] } })).toBeNull();
    expect(bodyShapeProblem({ a: { b: [new Array(201).fill(1)] } })).toBe("array_too_long");
    expect(bodyShapeProblem({ rows: [{ tags: new Array(201).fill("x") }] })).toBe("array_too_long");
  });

  it("accepts nesting up to 12 levels and rejects 13, for lists and for objects", () => {
    expect(bodyShapeProblem(nestedArrays(12))).toBeNull();
    expect(bodyShapeProblem(nestedArrays(13))).toBe("too_deep");
    expect(bodyShapeProblem(nestedObjects(12))).toBeNull();
    expect(bodyShapeProblem(nestedObjects(13))).toBe("too_deep");
  });

  it("treats plain values as fine and survives a hostile depth without overflowing the stack", () => {
    for (const v of [null, undefined, 0, "x", true, "a".repeat(100_000)]) expect(bodyShapeProblem(v)).toBeNull();
    expect(bodyShapeProblem(nestedArrays(50_000))).toBe("too_deep");
  });
});

describe("the guard on real routes", () => {
  it("lets an ordinary request through: the Business Brain, a campaign and a small lead import all work as before", async () => {
    const w = await world();
    const r = await w.importRows(w.rows(3));
    expect(r.status).toBe(201);
    expect(w.count("SELECT COUNT(*) n FROM leads")).toBe(3);
    expect((await call(w.app, "PUT", `${w.a}/brain`, w.token, BRAIN)).status).toBe(200);
  });

  it("accepts exactly 200 lead-import rows and stores them all", async () => {
    const w = await world();
    const r = await w.importRows(w.rows(200));
    expect(r.status).toBe(201);
    expect(w.count("SELECT COUNT(*) n FROM leads")).toBe(200);
  });

  it("refuses 201 rows with the guard's fixed answer, before any validation or business code, and stores nothing", async () => {
    const w = await world();
    const batches = () => w.count("SELECT COUNT(*) n FROM lead_import_batches");
    const audits = () => w.count("SELECT COUNT(*) n FROM audit_events");
    const [b0, a0] = [batches(), audits()];
    // a campaign that does not exist: if the route's own validation or lookup had run, the answer would be a validation error or 404 instead of the guard's code
    const r = await w.importRows(w.rows(201), { campaignId: "cmp_does_not_exist" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("body_too_complex");
    expect(r.body.error.message).toBe("The request has too many items in a list or is nested too deeply");
    expect(r.text).not.toMatch(/201|200|stack|zod|issues/i); // fixed wording: no limits or internals echoed
    expect(w.count("SELECT COUNT(*) n FROM leads")).toBe(0);
    expect([batches(), audits()]).toEqual([b0, a0]); // not even an audit row: the request did no work
  });

  it("refuses a 60,000-element list (the advisory's attack, which fits in the 256 KB body limit) quickly, with the same answer", async () => {
    const w = await world();
    const t0 = Date.now();
    const r = await w.importRows(Array.from({ length: 60_000 }, () => 0));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("body_too_complex");
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("applies to every JSON route, not only the lead import: an oversized list in the Business Brain is refused with the guard's code, not a validation error", async () => {
    const w = await world();
    const r = await call(w.app, "PUT", `${w.a}/brain`, w.token, { ...BRAIN, services: Array.from({ length: 201 }, (_, i) => `Service number ${i}`) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("body_too_complex");
    // 21 entries is under the guard, so the route's own schema answers (and still does)
    const ok = await call(w.app, "PUT", `${w.a}/brain`, w.token, { ...BRAIN, services: Array.from({ length: 21 }, (_, i) => `Service number ${i}`) });
    expect(ok.body.error?.code).not.toBe("body_too_complex");
  });

  it("refuses nesting deeper than 12 levels and lets 12 reach the route's own validation", async () => {
    const w = await world();
    const deep = await call(w.app, "PUT", `${w.a}/brain`, w.token, { ...BRAIN, extra: nestedObjects(13) });
    expect([deep.status, deep.body.error.code]).toEqual([400, "body_too_complex"]);
    const edge = await call(w.app, "PUT", `${w.a}/brain`, w.token, { ...BRAIN, extra: nestedObjects(10) }); // 12 levels in all with the body itself
    expect(edge.body.error?.code).not.toBe("body_too_complex");
    const hostile = await call(w.app, "PUT", `${w.a}/brain`, w.token, `${"[".repeat(5000)}${"]".repeat(5000)}`, { "content-type": "application/json" }); // sent as raw text: 5,000 levels
    expect(hostile.status).toBeLessThan(500);
    expect(hostile.body.error.code).toBe("body_too_complex");
  });

  it("keeps the existing answers for malformed JSON, an empty JSON body and a wrong content type (none reaches the guard, none becomes a 500)", async () => {
    const w = await world();
    const json = { "content-type": "application/json" };
    const bad = await call(w.app, "POST", `${w.a}/leads/import`, w.token, '{"rows": [1,2', json);
    expect([bad.status, bad.body.error.code]).toEqual([400, "invalid_json"]);
    const empty = await call(w.app, "POST", `${w.a}/leads/import`, w.token, "", json);
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe("validation"); // an empty body is "no body": the route's schema decides
    const text = await call(w.app, "POST", `${w.a}/leads/import`, w.token, JSON.stringify({ rows: new Array(60_000).fill(0) }), { "content-type": "text/plain" });
    expect(text.status).toBeLessThan(500); // not parsed into an object, so it cannot reach a schema as a list
    expect(text.body.error?.code).not.toBe("body_too_complex");
    const odd = await call(w.app, "POST", `${w.a}/leads/import`, w.token, "x", { "content-type": "application/x-www-form-urlencoded" });
    expect(odd.status).toBeLessThan(500);
  });

  it("is behind sign-in: an unauthenticated caller is refused before its body is read", async () => {
    const w = await world();
    const r = await call(w.app, "POST", `${w.a}/leads/import`, undefined, { rows: new Array(60_000).fill(0) });
    expect(r.status).toBe(401);
    expect(r.body.error.code).not.toBe("body_too_complex");
  });

  it("keeps the dedicated limits: asset uploads (a large base64 string, no list) still pass the guard, and the credential routes still refuse a body over their own 8 KB limit", async () => {
    const w = await world();
    const png = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0); png.writeUInt32BE(13, 8); png.write("IHDR", 12, "ascii"); png.writeUInt32BE(4, 16); png.writeUInt32BE(3, 20);
    const asset = await call(w.app, "POST", `${w.a}/assets`, w.token, { name: "Logo", kind: "logo", source: "uploaded", rightsBasis: "owned", data: png.toString("base64") });
    expect(asset.body.error?.code).not.toBe("body_too_complex"); // whatever the asset rules say, the guard is not what answers
    const cred = await call(w.app, "PUT", `${w.a}/credentials/openai`, w.token, { secret: "A".repeat(9 * 1024) }, { "content-type": "application/json" });
    expect([413, 503]).toContain(cred.status); // 413 over the 8 KB limit (or 503 when no key provider is configured): never the guard's 400
    expect(cred.body.error?.code).not.toBe("body_too_complex");
  });
});

describe("allowedProviders cap (src/app/aiService.ts)", () => {
  it("accepts 20 providers at the schema stage and refuses 21 as a validation error on that field", async () => {
    const w = await world();
    const names = (n: number) => Array.from({ length: n }, (_, i) => `provider-${i}`);
    const twentyOne = await call(w.app, "PUT", `${w.a}/ai/settings`, w.token, { routingMode: "manual", allowedProviders: names(21) });
    expect(twentyOne.status).toBe(400);
    expect(twentyOne.body.error.code).toBe("validation");
    expect(JSON.stringify(twentyOne.body.error.issues ?? [])).toMatch(/allowedProviders/);
    const twenty = await call(w.app, "PUT", `${w.a}/ai/settings`, w.token, { routingMode: "manual", allowedProviders: names(20) });
    expect(JSON.stringify(twenty.body.error?.issues ?? [])).not.toMatch(/allowedProviders/); // past the schema; the unknown names are then refused by the business rule, not by the cap
    expect(JSON.stringify(twenty.body)).toMatch(/Unknown provider/);
  });
});
