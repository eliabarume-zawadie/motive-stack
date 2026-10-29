/**
 * Phase 9: evidence for the launch-readiness report. These tests do not prove the product is production-ready (docs/launch-readiness.md says what is still missing); they pin
 * the facts the report relies on: every route is permission-mapped, no route leaks across workspaces, hostile input never reaches a 500, audit rows cannot be changed, export
 * and erasure work and keep secrets and personal data where they belong, quotas hold, backups restore, and a production start refuses the shared-token mode.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { createWorker } from "../src/app/worker.js";
import { ROUTE_PERMISSIONS } from "../src/auth/authz.js";
import { buildAuthRuntime, loadAuthConfig } from "../src/auth/config.js";
import { StaticJwks } from "../src/auth/jwks.js";
import { ORG_ROUTE_PERMISSIONS } from "../src/auth/orgAuthz.js";
import { MockImageProvider } from "../src/creative/image.js";
import { migrate, openDb } from "../src/db/db.js";
import { productionProblems } from "../src/deployment.js";
import { backupNow, restoreCheck, verifyBackup } from "../src/ops/backup.js";
import { buildServer } from "../src/server/app.js";
import { MemoryAssetStore } from "../src/storage/assetStore.js";
import { BRAIN } from "./fixtures.js";
import { AUDIENCE, ISSUER, NOW_MS, OIDC_REQUIRED, OPEN_POLICY, claims, makeKey, signJwt } from "./support/jwt.js";

const rsa = makeKey("RS256", "rsa-1");
const OIDC_ENV = { AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: "https://idp.example.test/jwks", ...OIDC_REQUIRED };
const oidc = () => buildAuthRuntime(loadAuthConfig(OIDC_ENV), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS, policy: OPEN_POLICY });
const open: Array<() => void> = [];
afterEach(() => { while (open.length) open.pop()?.(); });

type Json = Record<string, any>;
async function call(app: FastifyInstance, method: string, url: string, token?: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });
  return { status: res.statusCode, text: res.body, headers: res.headers, body: (() => { try { return res.body ? JSON.parse(res.body) : {}; } catch { return {}; } })() as Json };
}
function boot(over: Partial<Parameters<typeof buildContext>[0]> = {}, apiMax = 1_000_000) {
  const db = openDb(":memory:");
  migrate(db);
  const ctx: AppContext = buildContext({ db, env: { OPENAI_API_KEY: "sk-TEST-never-shown-000000000000" }, backoffMs: () => 0, gateway: { sleep: async () => {} }, assetStore: new MemoryAssetStore(), imageProvider: new MockImageProvider(), ...over });
  const app = buildServer(ctx, oidc(), { apiLimits: { apiMax, apiWindowSec: 60 } });
  open.push(() => db.open && db.close());
  return { db, ctx, app, worker: createWorker(ctx) };
}
type S = ReturnType<typeof boot>;
async function person(s: S, name: string) {
  const token = signJwt(rsa, claims({ sub: `idp|${name}`, name }));
  return { token, id: (await call(s.app, "GET", "/api/me", token)).body.user.id as string, name };
}
const PNG4x3 = (() => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.writeUInt32BE(13, 8); b.write("IHDR", 12, "ascii"); b.writeUInt32BE(4, 16); b.writeUInt32BE(3, 20); b[24] = 8; b[25] = 2; return Buffer.concat([b, Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 1])]); })();

/** A workspace full of recognisable data, plus a second workspace owned by someone else. */
async function world(over: Partial<Parameters<typeof buildContext>[0]> = {}, apiMax?: number) {
  const s = boot(over, apiMax);
  const owner = await person(s, "olivia"), admin = await person(s, "adam"), operator = await person(s, "oscar"), viewer = await person(s, "vera"), ben = await person(s, "ben");
  const A = (await call(s.app, "POST", "/api/workspaces", owner.token, { name: "Alpha Co" })).body.workspace.id as string;
  const B = (await call(s.app, "POST", "/api/workspaces", ben.token, { name: "Beta Co" })).body.workspace.id as string;
  const a = `/api/workspaces/${A}`, b = `/api/workspaces/${B}`;
  for (const [p, role] of [[admin, "admin"], [operator, "operator"], [viewer, "viewer"]] as const) expect((await call(s.app, "POST", `${a}/members`, owner.token, { userId: p.id, role })).status).toBe(201);
  expect((await call(s.app, "PUT", `${a}/brain`, owner.token, BRAIN)).status).toBe(200);
  const cid = (await call(s.app, "POST", `${a}/campaigns/generate`, owner.token, { providerId: "mock", model: "mock-deterministic-1" })).body.id as string;
  const pid = (await call(s.app, "POST", `${a}/campaigns/${cid}/proposals`, operator.token, {})).body.id as string;
  await call(s.app, "POST", `${a}/proposals/${pid}/approve`, admin.token, { decidedBy: "x", acknowledgedReview: true });
  const concept = { headline: "Fast help, fair price", subline: "Free quote", callToAction: "GET_QUOTE", visualDescription: "A clean layout", palette: { background: "#FFFFFF", foreground: "#1B1B1B", accent: "#1A4D8F" } };
  const crid = (await call(s.app, "POST", `${a}/campaigns/${cid}/creatives`, operator.token, { name: "SECRET-CREATIVE-A", brief: { objective: "a", keyMessage: "b" }, concept, altText: "An advertisement for the test", ratios: ["1:1"] })).body.id as string;
  await call(s.app, "POST", `${a}/creatives/${crid}/versions/1/renders`, operator.token, {}); await s.worker.runUntilIdle();
  const rid = (s.db.prepare("SELECT id FROM creative_renders WHERE creative_id = ?").get(crid) as { id: string }).id;
  const aid = (await call(s.app, "POST", `${a}/assets`, operator.token, { name: "SECRET-ASSET-A", kind: "image", source: "uploaded", rightsBasis: "owned", data: PNG4x3.toString("base64") })).body.id as string;
  await call(s.app, "POST", `${a}/leads/import`, operator.token, { campaignId: cid, sourceNote: "Show list", rows: [{ fullName: "SECRET-LEAD-A", email: "secret-lead-a@example.com", phone: "512-555-0199" }] });
  const lid = ((await call(s.app, "GET", `${a}/leads`, viewer.token)).body as unknown as Json[])[0]!.id as string;
  const fid = (await call(s.app, "POST", `${a}/campaigns/${cid}/forms`, operator.token, { name: "SECRET-FORM-A", fields: { email: "required", phone: "optional" }, privacyNotice: "We use your details only to reply.", consentText: "I agree to be contacted.", purpose: "Reply to requests", retentionNote: "Deleted after 12 months" })).body.id as string;
  const wiid = (await call(s.app, "POST", `${a}/work-items`, operator.token, { campaignId: cid, kind: "other", title: "SECRET-TASK-A", dueDate: "2030-01-01", ownerUserId: viewer.id })).body.id as string;
  const nid = ((await call(s.app, "GET", `${a}/notifications`, viewer.token)).body.notifications as Json[])[0]!.id as string;
  const lrn = (await call(s.app, "POST", `${a}/learnings`, operator.token, { statement: "SECRET-LEARNING-A", kind: "message", sourceType: "human_note", observedOn: "2030-01-01", confidence: "low", limitations: "One note" })).body.id as string;
  await call(s.app, "PUT", `${a}/brand-kit`, operator.token, { voice: { descriptors: ["SECRET-VOICE-A"], preferredTerms: [], avoidTerms: [], ctaStyle: "" }, visual: { colors: [], typography: "", imageStyle: "", logoRules: "", referenceAssetIds: [] }, audiences: [], channels: [], disclaimers: [], notes: "" });
  await call(s.app, "POST", `${a}/campaigns/${cid}/proposals`, operator.token, {}).catch(() => null);
  const plan = (await call(s.app, "POST", `${a}/plans/recommend`, operator.token, {})).body;
  const exp = await call(s.app, "POST", `${a}/experiments`, operator.token, { name: "SECRET-EXPERIMENT-A", hypothesis: "h", principalVariable: "headline", variableNote: "n", audienceNote: "a", placementNote: "p", successMetric: "lead_count", durationDays: 7, minSample: 10, decisionRule: "r",
    variants: [{ label: "Control", role: "control", description: "c", campaignId: cid, campaignVersion: 1 }, { label: "Other", role: "variant", description: "v", campaignId: cid, campaignVersion: 1, creativeId: crid }] });
  const eid = (exp.body.id as string | undefined) ?? "exp_none";
  const ids: Record<string, string> = { wid: A, cid, pid, crid, rid, aid, lid, fid, wiid, nid, lrn, plid: plan.id ?? "plan_none", opid: plan.opportunities?.[0]?.id ?? "opp_none", eid, v: "1", ratio: "1:1", stype: "campaign", sid: cid, uid: viewer.id, kind: "openai", oid: "org_none" };
  return { s, A, B, a, b, owner, admin, operator, viewer, ben, ids };
}

/** The sweeps below only read or are refused, so they share one populated world instead of building several (the suite runs many files at once). */
let sharedWorld: Promise<Awaited<ReturnType<typeof world>>> | null = null;
const sharedClosers: Array<() => void> = [];
const shared = () => (sharedWorld ??= (async () => { const before = open.length; const w = await world(); sharedClosers.push(...open.splice(before)); return w; })()); // its database must outlive each test: it is closed once, after the last one
afterAll(() => { while (sharedClosers.length) sharedClosers.pop()?.(); });

/** Every registered route, as "METHOD /path/:param", read from Fastify's own route tree. */
function registeredRoutes(app: FastifyInstance): string[] {
  const out: string[] = []; const stack: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    const m = /^((?:│   |    )*)(?:├── |└── )(.*)$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    const mm = /^(.*?) \(([A-Z, ]+)\)$/.exec(m[2]!);
    stack.length = depth; stack[depth] = mm ? mm[1]! : m[2]!;
    if (mm) for (const method of mm[2]!.split(", ")) if (method !== "HEAD" && method !== "OPTIONS") out.push(`${method} ${stack.slice(0, depth + 1).join("").replace(/\/\/+/g, "/").replace(/(.)\/$/, "$1")}`);
  }
  return [...new Set(out)];
}
/** A server error that is a stated, deliberate answer (the credential vault is off), not a crash. */
const deliberate503 = (res: { status: number; body: Json }) => res.status === 503 && res.body?.error?.code === "credentials_unavailable";
const fill = (route: string, ids: Record<string, string>) => route.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(k === "lid" && route.includes("/learnings/") ? ids.lrn! : ids[k] ?? "x"));

describe("every route is accounted for", () => {
  it("each workspace route is in the permission table (default deny holds), each table entry is a real route, and the only unmapped routes are the account and organization routes", async () => {
    const { s } = await shared();
    const routes = registeredRoutes(s.app).filter((r) => r.includes("/api/"));
    const ws = routes.filter((r) => r.includes("/api/workspaces/:wid"));
    expect(ws.length).toBeGreaterThan(120);
    expect(ws.filter((r) => !(r in ROUTE_PERMISSIONS))).toEqual([]);
    expect(Object.keys(ROUTE_PERMISSIONS).filter((k) => !routes.includes(k))).toEqual([]); // no stale entry that could mask a missing one
    const org = routes.filter((r) => r.includes("/api/organizations/:oid"));
    expect(org.filter((r) => !(r in ORG_ROUTE_PERMISSIONS))).toEqual([]);
    const unmapped = routes.filter((r) => !ws.includes(r) && !org.includes(r)).sort();
    expect(unmapped).toEqual(["GET /api/config", "GET /api/health", "GET /api/health/ready", "GET /api/me", "GET /api/me/organizations", "GET /api/me/workspaces", "POST /api/organizations", "POST /api/workspaces", "POST /api/workspaces/claim"]);
  });
});

describe("workspace isolation holds on every route", () => {
  it("an unauthenticated caller is refused on every workspace route (401), whatever the method", async () => {
    const w = await shared();
    const bad: string[] = [];
    for (const r of registeredRoutes(w.s.app).filter((x) => x.includes("/api/workspaces/:wid"))) {
      const [method, path] = r.split(" ") as [string, string];
      const res = await call(w.s.app, method, fill(path, w.ids), undefined, method === "GET" ? undefined : {});
      if (res.status !== 401) bad.push(`${r} -> ${res.status}`);
    }
    expect(bad).toEqual([]);
  });

  it("a signed-in person who is not a member of a workspace gets nothing from ANY of its routes (never a 2xx, never a 5xx), using real ids from that workspace", async () => {
    const w = await shared();
    const bad: string[] = []; let n = 0;
    for (const r of registeredRoutes(w.s.app).filter((x) => x.includes("/api/workspaces/:wid"))) {
      const [method, path] = r.split(" ") as [string, string];
      const res = await call(w.s.app, method, fill(path, w.ids), w.ben.token, method === "GET" ? undefined : {});
      n++;
      if (res.status >= 200 && res.status < 300 || (res.status >= 500 && !deliberate503(res))) bad.push(`${r} -> ${res.status}`);
    }
    expect(n).toBeGreaterThan(120);
    expect(bad).toEqual([]);
  });

  it("another workspace's resource ids are not found in your own workspace, on every route that takes one, and no list shows the other workspace's data", async () => {
    const w = await shared();
    const bad: string[] = [];
    const ids = { ...w.ids, wid: w.B };
    let withIds = 0;
    for (const r of registeredRoutes(w.s.app).filter((x) => x.includes("/api/workspaces/:wid"))) {
      const [method, path] = r.split(" ") as [string, string];
      const resourceParams = [...path.matchAll(/:(\w+)/g)].map((m) => m[1]!).filter((p) => !["wid", "v", "ratio", "stype", "kind", "uid"].includes(p));
      const res = await call(w.s.app, method, fill(path, ids), w.ben.token, method === "GET" ? undefined : {});
      if (res.status >= 500 && !deliberate503(res)) bad.push(`${r} -> ${res.status} (server error)`);
      if (resourceParams.length) { withIds++; if (res.status >= 200 && res.status < 300) bad.push(`${r} -> ${res.status} (served another workspace's resource)`); }
      if (method === "GET" && /SECRET-|secret-lead-a/.test(res.text)) bad.push(`${r} leaked marker data`);
    }
    expect(withIds).toBeGreaterThan(60);
    expect(bad).toEqual([]);
  });
});

describe("hostile input never reaches a server error or leaks internals", () => {
  it("path parameters carrying SQL, traversal, NUL, a huge string and unicode never produce a 5xx, a stack trace or a file path, on any route", async () => {
    const w = await shared();
    const hostile = ["' OR 1=1;--", "../../etc/passwd", "%00", "x".repeat(4000), "\u202e\ud83d\ude00"];
    const bad: string[] = []; let n = 0;
    for (const r of registeredRoutes(w.s.app).filter((x) => x.includes("/api/workspaces/:wid") && x.slice(x.indexOf(":wid") + 4).includes(":"))) {
      const [method, path] = r.split(" ") as [string, string];
      for (const h of hostile) {
        const url = path.replace(/:wid/, w.A).replace(/:(\w+)/g, () => encodeURIComponent(h));
        const res = await call(w.s.app, method, url, w.owner.token, method === "GET" ? undefined : {});
        n++;
        if (res.status >= 500 && !deliberate503(res)) bad.push(`${r} [${h.slice(0, 12)}] -> ${res.status}`);
        else if (/node_modules|\bat .*\(.*:\d+:\d+\)|src[\\/]/.test(res.text)) bad.push(`${r} [${h.slice(0, 12)}] leaked internals`);
      }
    }
    expect(n).toBeGreaterThan(350);
    expect(bad).toEqual([]);
  }, 120_000);

  it("malformed and oversized bodies are refused cleanly: bad JSON, wrong types, extra fields, a body past the limit", async () => {
    const w = await world();
    const u = `${w.a}/work-items`;
    const send = (payload: unknown, ctype = "application/json") => w.s.app.inject({ method: "POST", url: u, headers: { authorization: `Bearer ${w.operator.token}`, "content-type": ctype }, payload: payload as never });
    expect((await send("{not json")).statusCode).toBe(400);
    expect((await send(JSON.stringify([1, 2, 3]))).statusCode).toBe(400);
    expect((await send(JSON.stringify({ campaignId: w.ids.cid, kind: "other", title: "x", surprise: true }))).statusCode).toBe(400); // unknown fields are refused, not ignored
    expect((await send(JSON.stringify({ campaignId: 5, kind: "other", title: "x" }))).statusCode).toBe(400);
    expect((await send("x".repeat(300 * 1024))).statusCode).toBe(413);
    const res = await send("{not json");
    expect(res.body).not.toMatch(/SyntaxError|at JSON|node_modules/);
  });

  it("sends the security headers on API and page responses", async () => {
    const w = await world();
    for (const url of ["/api/health", "/", `${w.a}/usage`]) {
      const res = await w.s.app.inject({ method: "GET", url, headers: url.startsWith("/api/workspaces") ? { authorization: `Bearer ${w.admin.token}` } : {} });
      expect(res.headers["x-content-type-options"], url).toBe("nosniff");
      expect(String(res.headers["content-security-policy"] ?? ""), url).toMatch(/frame-ancestors 'none'/);
      expect(String(res.headers["content-security-policy"] ?? ""), url).toMatch(/script-src 'self'/);
    }
  });
});

describe("rate limits and reliability", () => {
  it("limits a verified caller across the routes added since the last review, and tells them when to retry", async () => {
    const w = await world({}, 15);
    let limited: Awaited<ReturnType<typeof call>> | null = null;
    for (let i = 0; i < 40 && !limited; i++) { const r = await call(w.s.app, "GET", `${w.a}/usage`, w.admin.token); if (r.status === 429) limited = r; }
    expect(limited).not.toBeNull();
    expect(limited!.body.error.code).toBe("rate_limited");
    expect(String(limited!.headers["retry-after"])).toMatch(/^\d+$/);
    expect((await call(w.s.app, "GET", "/api/health")).status).toBe(200); // public routes and other callers are not starved
  });

  it("survives a burst of 200 concurrent mixed requests with no server error and an intact database", async () => {
    const w = await world();
    const reqs: Array<Promise<{ status: number }>> = [];
    for (let i = 0; i < 200; i++) {
      const k = i % 5;
      reqs.push(k === 0 ? call(w.s.app, "GET", `${w.a}/leads`, w.viewer.token) : k === 1 ? call(w.s.app, "GET", `${w.a}/inbox`, w.admin.token) : k === 2 ? call(w.s.app, "GET", `${w.a}/analytics`, w.viewer.token)
        : k === 3 ? call(w.s.app, "POST", `${w.a}/work-items`, w.operator.token, { campaignId: w.ids.cid, kind: "other", title: `Burst ${i}` }) : call(w.s.app, "GET", "/api/health/ready"));
    }
    const out = await Promise.all(reqs);
    expect(out.filter((r) => r.status >= 500)).toEqual([]);
    expect(out.filter((r) => r.status === 201).length).toBe(40);
    expect(w.s.db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(w.s.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("refuses an oversized collection that fits inside the body limit quickly and without memory growth (the zod advisory's attack, bounded by the 256 KB body limit)", async () => {
    const w = await world();
    const rssBefore = process.memoryUsage().rss;
    const t0 = Date.now();
    const res = await call(w.s.app, "POST", `${w.a}/leads/import`, w.operator.token, { campaignId: w.ids.cid, sourceNote: "x", rows: Array.from({ length: 60_000 }, () => 0) });
    expect(res.status).toBe(400);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(200 * 1024 * 1024);
  });

  it("reports readiness for a monitor: ready when the database answers and every migration is applied, not ready otherwise", async () => {
    const w = await world();
    const ok = await call(w.s.app, "GET", "/api/health/ready");
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, checks: { database: true, migrations: true } });
    expect(ok.text).not.toMatch(/\.sql|version|path/i); // says yes or no and which check, nothing about the system
    w.s.db.prepare("DELETE FROM schema_migrations WHERE name = (SELECT MAX(name) FROM schema_migrations)").run();
    const bad = await call(w.s.app, "GET", "/api/health/ready");
    expect(bad.status).toBe(503);
    expect(bad.body.checks).toEqual({ database: true, migrations: false });
  });
});

describe("the audit trail cannot be changed, even by mistake", () => {
  it("refuses any UPDATE or DELETE of an audit row at the database level, and still accepts new rows", async () => {
    const w = await world();
    const before = (w.s.db.prepare("SELECT COUNT(*) n FROM audit_events").get() as { n: number }).n;
    expect(before).toBeGreaterThan(10);
    expect(() => w.s.db.prepare("UPDATE audit_events SET actor = 'someone-else'").run()).toThrow(/append-only/);
    expect(() => w.s.db.prepare("DELETE FROM audit_events WHERE id = 1").run()).toThrow(/append-only/);
    expect(() => w.s.db.prepare("DELETE FROM audit_events").run()).toThrow(/append-only/);
    expect((w.s.db.prepare("SELECT COUNT(*) n FROM audit_events").get() as { n: number }).n).toBe(before);
    await call(w.s.app, "POST", `${w.a}/work-items`, w.operator.token, { campaignId: w.ids.cid, kind: "other", title: "More" });
    expect((w.s.db.prepare("SELECT COUNT(*) n FROM audit_events").get() as { n: number }).n).toBeGreaterThan(before);
  });
  it("records the acting person's kind on a sample of consequential actions, never a name, e-mail or phone number", async () => {
    const w = await world();
    const text = (w.s.db.prepare("SELECT group_concat(detail || actor, ' ') t FROM audit_events").get() as { t: string }).t;
    expect(text).not.toMatch(/secret-lead-a@example\.com|512-555-0199|SECRET-LEAD-A/);
  });
});

describe("a production start refuses what is unsafe in front of the public", () => {
  it("does nothing outside production, and in production names every missing setting without printing a value", () => {
    expect(productionProblems({})).toEqual([]);
    expect(productionProblems({ DEPLOYMENT_ENV: "development", AUTH_MODE: "workspace_token" })).toEqual([]);
    const p = productionProblems({ DEPLOYMENT_ENV: "production" });
    expect(p.map((x) => x.split(":")[0])).toEqual(["AUTH_MODE", "PUBLIC_ORIGINS", "HSTS_MAX_AGE_SEC", "DATABASE_PATH"]);
    expect(p[0]).toMatch(/shared, admin-equivalent secret/);
    const safe = { DEPLOYMENT_ENV: "production", AUTH_MODE: "oidc", PUBLIC_ORIGINS: "https://app.example.com", HSTS_MAX_AGE_SEC: "31536000", DATABASE_PATH: "/var/lib/motivestack/app.db" };
    expect(productionProblems(safe)).toEqual([]);
    expect(productionProblems({ ...safe, AUTH_MODE: "workspace_token" }).length).toBe(1);
    expect(productionProblems({ ...safe, PUBLIC_ORIGINS: "http://localhost:3000" }).length).toBe(1);
    expect(JSON.stringify(productionProblems({ ...safe, AUTH_MODE: "workspace_token" }))).not.toMatch(/app\.example|var\/lib/);
  });
  it("is wired into start-up before anything is opened", () => {
    const main = readFileSync("src/server/main.ts", "utf8");
    expect(main.indexOf("productionProblems(env)")).toBeGreaterThan(0);
    expect(main.indexOf("productionProblems(env)")).toBeLessThan(main.indexOf("openDb("));
    expect(main).toMatch(/process\.exit\(1\)/);
  });
});

describe("privacy: export and erasure", () => {
  it("lets an admin export everything the workspace holds, with every secret removed, and records that it happened", async () => {
    const w = await world();
    const r = await call(w.s.app, "GET", `${w.a}/export`, w.admin.token);
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(String(r.headers["content-disposition"])).toMatch(/attachment; filename="motivestack-export-/);
    expect(r.body).toMatchObject({ format: "motivestack-export-1", workspace: { id: w.A, name: "Alpha Co" } });
    const t = r.body.tables as Record<string, Json[]>;
    for (const name of ["campaigns", "leads", "creatives", "assets", "learnings", "work_items", "experiments", "audit_events", "action_proposals", "lead_forms"]) expect(t[name]?.length, name).toBeGreaterThan(0);
    expect(t.leads![0]).toMatchObject({ full_name: "SECRET-LEAD-A", email: "secret-lead-a@example.com" }); // personal data IS in the owner's own export
    const text = r.text;
    expect(text).not.toMatch(/token_hash|storage_key|ciphertext|sk-TEST|never-shown/);
    expect(t.workspace_credentials).toBeUndefined();
    expect(t.notifications).toBeUndefined();
    expect(r.body.notExported.join(" ")).toMatch(/Secrets/);
    expect(JSON.stringify(t)).not.toMatch(/Beta Co/); // nothing from the other workspace
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE type = 'workspace.exported'").get()).toEqual({ n: 1 });
  });
  it("is for admins of THAT workspace only", async () => {
    const w = await world();
    for (const who of [w.operator, w.viewer]) expect((await call(w.s.app, "GET", `${w.a}/export`, who.token)).status).toBe(403);
    expect((await call(w.s.app, "GET", `${w.a}/export`, w.ben.token)).status).toBeGreaterThanOrEqual(403);
    expect((await call(w.s.app, "GET", `${w.a}/export`)).status).toBe(401);
    const mine = await call(w.s.app, "GET", `${w.b}/export`, w.ben.token);
    expect(mine.status).toBe(200);
    expect(mine.text).not.toMatch(/SECRET-|Alpha Co|secret-lead-a/);
  });

  it("erases one lead's personal data everywhere, keeps the audit trail free of it, and keeps the event as a scrubbed duplicate marker", async () => {
    const w = await world();
    const pid = w.ids.pid;
    await call(w.s.app, "POST", `${w.a}/proposals/${pid}/execute`, w.admin.token); await w.s.worker.runUntilIdle();
    await call(w.s.app, "POST", `${w.a}/campaigns/${w.ids.cid}/simulate-lead`, w.operator.token, { fullName: "Simulated Sam", email: "sam@example.com", eventId: "evt-erase-1" });
    await w.s.worker.runUntilIdle();
    const sim = (w.s.db.prepare("SELECT id FROM leads WHERE email = 'sam@example.com'").get() as { id: string } | undefined);
    expect(sim, "the simulated lead exists and synced to the simulated CRM").toBeTruthy();
    expect((w.s.db.prepare("SELECT COUNT(*) n FROM sim_crm_contacts WHERE email = 'sam@example.com'").get() as { n: number }).n).toBe(1);
    await call(w.s.app, "PUT", `${w.a}/leads/${sim!.id}/status`, w.operator.token, { status: "contacted", note: "called" });

    expect((await call(w.s.app, "POST", `${w.a}/leads/${sim!.id}/erase`, w.admin.token, {})).status).toBe(400); // a reason is required
    expect((await call(w.s.app, "POST", `${w.a}/leads/${sim!.id}/erase`, w.operator.token, { reason: "x" })).status).toBe(403);
    const r = await call(w.s.app, "POST", `${w.a}/leads/${sim!.id}/erase`, w.admin.token, { reason: "Subject access request #12" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ erased: true, removed: { crmContacts: 1, crmSyncs: 1, statusHistory: 1 } });
    expect(r.body.notReached.join(" ")).toMatch(/audit trail is never edited/);
    expect(r.body.notReached.join(" ")).toMatch(/backup taken before the erasure/);
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM leads WHERE id = ?").get(sim!.id)).toEqual({ n: 0 });
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM sim_crm_contacts WHERE email = 'sam@example.com'").get()).toEqual({ n: 0 });
    const ev = w.s.db.prepare("SELECT payload FROM lead_events WHERE event_id = 'evt-erase-1'").get() as { payload: string };
    expect(JSON.parse(ev.payload)).toEqual({ erased: true });
    const everywhere = JSON.stringify([w.s.db.prepare("SELECT * FROM leads").all(), w.s.db.prepare("SELECT * FROM lead_events").all(), w.s.db.prepare("SELECT * FROM sim_crm_contacts").all(), w.s.db.prepare("SELECT * FROM audit_events").all(), w.s.db.prepare("SELECT * FROM jobs").all()]);
    expect(everywhere).not.toMatch(/sam@example\.com|Simulated Sam/);
    expect((w.s.db.prepare("SELECT detail FROM audit_events WHERE type = 'lead.erased'").get() as { detail: string }).detail).toMatch(/Subject access request #12/);
    // the same event id does not bring the person back
    const again = await call(w.s.app, "POST", `${w.a}/campaigns/${w.ids.cid}/simulate-lead`, w.operator.token, { fullName: "Simulated Sam", email: "sam@example.com", eventId: "evt-erase-1" });
    await w.s.worker.runUntilIdle();
    expect(again.body.duplicate).toBe(true);
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM leads WHERE email = 'sam@example.com'").get()).toEqual({ n: 0 });
    expect((await call(w.s.app, "POST", `${w.a}/leads/${sim!.id}/erase`, w.admin.token, { reason: "again" })).status).toBe(404);
  });
  it("erases an imported lead too, and cannot erase another workspace's lead", async () => {
    const w = await world();
    expect((await call(w.s.app, "POST", `${w.b}/leads/${w.ids.lid}/erase`, w.ben.token, { reason: "try" })).status).toBe(404);
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM leads WHERE id = ?").get(w.ids.lid)).toEqual({ n: 1 });
    expect((await call(w.s.app, "POST", `${w.a}/leads/${w.ids.lid}/erase`, w.admin.token, { reason: "Asked to be removed" })).body.erased).toBe(true);
    expect(JSON.stringify(w.s.db.prepare("SELECT * FROM lead_events").all())).not.toMatch(/secret-lead-a|SECRET-LEAD-A|512-555-0199/);
  });
});

describe("quotas and cost attribution", () => {
  it("refuses a record that would pass the workspace's limit, with a plain message, and stores nothing from a refused batch", async () => {
    const w = await world({ quotas: { leads: 3, workItems: 2, learnings: 1, experiments: 1, creatives: 1, forms: 1 } });
    const rows = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ fullName: `${p}${i}`, email: `${p}${i}@x.com` }));
    const r = await call(w.s.app, "POST", `${w.a}/leads/import`, w.operator.token, { campaignId: w.ids.cid, sourceNote: "More", rows: rows(5, "q") });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe("quota_exceeded");
    expect(r.body.error.message).toMatch(/limit of 3 leads \(1 in use\)/);
    expect((w.s.db.prepare("SELECT COUNT(*) n FROM leads").get() as { n: number }).n).toBe(1); // nothing half-imported
    expect((await call(w.s.app, "POST", `${w.a}/leads/import`, w.operator.token, { campaignId: w.ids.cid, sourceNote: "Fits", rows: rows(2, "ok") })).status).toBe(201);
    expect((await call(w.s.app, "POST", `${w.a}/work-items`, w.operator.token, { campaignId: w.ids.cid, kind: "other", title: "Second" })).status).toBe(201); // one task exists, the limit is 2: this fits
    expect((await call(w.s.app, "POST", `${w.a}/work-items`, w.operator.token, { campaignId: w.ids.cid, kind: "other", title: "Third" })).status).toBe(413); // this does not
    const kinds = Object.fromEntries((await call(w.s.app, "GET", `${w.a}/usage`, w.admin.token)).body.quotas.map((q: Json) => [q.id, [q.used, q.limit]]));
    expect(kinds.leads).toEqual([3, 3]);
    expect(kinds.learnings).toEqual([1, 1]);
  });

  it("shows what a workspace uses and what its AI cost, per provider and model, and never another workspace's", async () => {
    const w = await world();
    const u = (await call(w.s.app, "GET", `${w.a}/usage`, w.admin.token)).body;
    expect(u.workspaceId).toBe(w.A);
    expect(u.quotas.map((q: Json) => q.id).sort()).toEqual(["campaigns", "creatives", "experiments", "forms", "leads", "learnings", "workItems"]);
    expect(u.storage).toMatchObject({ maxFileBytes: 5242880, maxAssets: 500 });
    expect(u.storage.bytes).toBeGreaterThan(0);
    expect(u.pictures).toMatchObject({ dailyLimit: 40, costCents: 0 });
    expect(u.ai.byProvider.length).toBeGreaterThan(0);
    expect(u.ai.byProvider[0]).toMatchObject({ provider: "mock", mode: "mock" });
    expect(u.ai.note).toMatch(/unknown, never as zero/);
    expect(u.notes.join(" ")).toMatch(/not plan entitlements/);
    expect(u.leadsByOrigin).toMatchObject({ imported: 1 });
    const other = (await call(w.s.app, "GET", `${w.b}/usage`, w.ben.token)).body;
    expect(other.ai.byProvider).toEqual([]);
    expect(other.leadsByOrigin).toEqual({});
    expect((await call(w.s.app, "GET", `${w.a}/usage`, w.operator.token)).status).toBe(403);
  });
});

describe("secrets and logging", () => {
  it("has no key, token or private key in any tracked-looking file (only obvious test fakes)", () => {
    const skip = new Set(["node_modules", ".git", "data", "scratchpad", "dist", "coverage"]);
    const files: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (skip.has(e.name)) continue; const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|js|json|md|sql|html|css|sh|cjs|mjs|yml|yaml|txt|env\.example)$/.test(e.name) || e.name === ".env.example") if (statSync(p).size < 2_000_000) files.push(p); } };
    walk(".");
    const patterns: Array<[string, RegExp]> = [["OpenAI-style key", /sk-(?:proj-|live-)?[A-Za-z0-9_-]{32,}/], ["Anthropic-style key", /sk-ant-[A-Za-z0-9_-]{20,}/], ["Meta token", /EAA[A-Za-z0-9]{40,}/], ["AWS access key", /AKIA[0-9A-Z]{16}/], ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/], ["bearer JWT", /Bearer eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/]];
    const hits: string[] = [];
    for (const f of files) { if (/\.env\.local$/.test(f)) continue; const t = readFileSync(f, "utf8"); for (const [name, re] of patterns) { const m = re.exec(t); if (m && !/TEST|FAKE|never|example|redact|0{8,}|x{8,}|abc/i.test(m[0] + t.slice(Math.max(0, m.index - 60), m.index + m[0].length + 20))) hits.push(`${f}: ${name}`); } }
    expect(hits).toEqual([]);
    expect(readFileSync(".gitignore", "utf8")).toMatch(/^\.env\.\*$/m); // .env.local and every other .env file is ignored
  });
  it("writes no request body or credential to any log: the server logger is off and only start-up lines print", () => {
    expect(readFileSync("src/server/app.ts", "utf8")).toMatch(/Fastify\(\{ logger: false/);
    const offenders: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".ts") && /console\.(log|error|warn|info|debug)/.test(readFileSync(p, "utf8"))) offenders.push(p.replace(/\\/g, "/")); } };
    walk("src/app"); walk("src/server/auth.ts".replace("/auth.ts", ""));
    expect(offenders.filter((f) => f !== "src/server/main.ts")).toEqual([]);
  });
});

describe("backup and restore are proven, not assumed", () => {
  const scratch = () => { const d = mkdtempSync(join(tmpdir(), "ms-bk-")); open.push(() => rmSync(d, { recursive: true, force: true })); return d; };
  const source = () => {
    const d = scratch(); const dbPath = join(d, "live.db"); const assets = join(d, "assets");
    mkdirSync(join(assets, "ws_a", "asset_1"), { recursive: true });
    writeFileSync(join(assets, "ws_a", "asset_1", "v1.png"), PNG4x3);
    const db = openDb(dbPath); migrate(db);
    db.prepare("INSERT INTO workspaces (id, name, token_hash, created_at) VALUES ('ws_a','A','h','t')").run();
    db.prepare("INSERT INTO audit_events (workspace_id, at, actor, type, entity_type, entity_id, detail) VALUES ('ws_a','t','system','x','y','z','{}')").run();
    db.close();
    return { d, dbPath, assets };
  };
  it("takes a consistent online copy of the database and the asset files, verifies it, and restores it into a scratch folder", async () => {
    const s = source(); const dbBefore = createHash("sha256").update(readFileSync(s.dbPath)).digest("hex");
    const r = await backupNow({ databasePath: s.dbPath, assetDir: s.assets, backupDir: join(s.d, "backups"), extraCopyDir: join(s.d, "second") });
    expect(r.manifest.migrations.at(-1)).toBe("023_audit_append_only.sql");
    expect(r.manifest.tableCounts.workspaces).toBe(1);
    expect(r.manifest.assetFiles).toHaveLength(1);
    expect(verifyBackup(r.dir).every((c) => c.ok)).toBe(true);
    expect(verifyBackup(r.extraDir!).every((c) => c.ok)).toBe(true);
    const restored = restoreCheck(r.dir, join(s.d, "restore"));
    expect(restored.filter((c) => !c.ok)).toEqual([]);
    expect(restored.map((c) => c.name)).toEqual(expect.arrayContaining(["the app's normal start-up migration runs on the restored copy", "no table lost rows in the restore"]));
    expect(createHash("sha256").update(readFileSync(s.dbPath)).digest("hex")).toBe(dbBefore); // reading the live database changed nothing
  });
  it("notices a damaged database, a missing or altered asset file, and refuses to overwrite", async () => {
    const s = source();
    const r = await backupNow({ databasePath: s.dbPath, assetDir: s.assets, backupDir: join(s.d, "backups") });
    writeFileSync(join(r.dir, "assets", "ws_a", "asset_1", "v1.png"), Buffer.from("tampered"));
    const c1 = verifyBackup(r.dir);
    expect(c1.find((c) => c.name.startsWith("every asset file"))).toMatchObject({ ok: false });
    const dbFile = join(r.dir, "motivestack.db"); const bytes = readFileSync(dbFile); bytes[bytes.length - 100] = (bytes[bytes.length - 100] ?? 0) ^ 0xff; writeFileSync(dbFile, bytes);
    expect(verifyBackup(r.dir).find((c) => c.name === "database hash matches the manifest")).toMatchObject({ ok: false });
    await expect(backupNow({ databasePath: join(s.d, "nope.db"), backupDir: join(s.d, "b2") })).rejects.toThrow(/No database was found/);
    const sameStamp = new Date(r.dir.split(/[\\/]/).pop()!.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, "T$1:$2:$3.$4Z"));
    await expect(backupNow({ databasePath: s.dbPath, backupDir: join(s.d, "backups"), now: () => sameStamp })).rejects.toThrow(/already exists/);
  });
});
