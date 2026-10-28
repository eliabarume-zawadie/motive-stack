/**
 * Phase 1: organizations, custom permissions, separation of duties and the approve/execute split.
 * Signed-in people are test identities (in-memory keys, simulated identity provider); there is no real sign-in here.
 */
import { readFileSync, readdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { backfillTenancy, ensureWorkspaceDefaults } from "../src/app/tenancy.js";
import { createWorker } from "../src/app/worker.js";
import { createWorkspace } from "../src/app/workspaces.js";
import { buildAuthRuntime, loadAuthConfig } from "../src/auth/config.js";
import { StaticJwks } from "../src/auth/jwks.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { BRAIN } from "./fixtures.js";
import { AUDIENCE, ISSUER, NOW_MS, OIDC_REQUIRED, OPEN_POLICY, claims, makeKey, signJwt } from "./support/jwt.js";

const rsa = makeKey("RS256", "rsa-1");
const OIDC_ENV = { AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: "https://idp.example.test/jwks", ...OIDC_REQUIRED };
const runtime = () => buildAuthRuntime(loadAuthConfig(OIDC_ENV), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS, policy: OPEN_POLICY });

const open: Array<() => void> = [];
afterEach(() => { while (open.length) open.pop()?.(); });

function boot() {
  const db = openDb(":memory:");
  migrate(db);
  const ctx: AppContext = buildContext({ db, env: {}, backoffMs: () => 0, gateway: { sleep: async () => {} } });
  const app = buildServer(ctx, runtime());
  open.push(() => db.open && db.close());
  return { db, ctx, app, worker: createWorker(ctx) };
}
type S = ReturnType<typeof boot>;
type Json = Record<string, any>;
async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, opts: { token?: string; payload?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await app.inject({ method, url, headers, payload: opts.payload as never });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as Json };
}
const jwtFor = (name: string) => signJwt(rsa, claims({ sub: `idp|${name}`, name }));
async function person(s: S, name: string) {
  const token = jwtFor(name);
  const r = await call(s.app, "GET", "/api/me", { token });
  expect(r.status).toBe(200);
  return { token, id: r.body.user.id as string, name };
}
const one = <T>(db: S["db"], sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as T;

/* ------------------------------------------------------------------ migration 015 and the backfill */

describe("migration 015: organizations, policy and proposer, added to existing data", () => {
  function dbThrough014() {
    const db = openDb(":memory:");
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const f of readdirSync("src/db/migrations").filter((x) => x.endsWith(".sql") && x < "015").sort()) {
      db.exec(readFileSync(`src/db/migrations/${f}`, "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES (?, 'then')").run(f);
    }
    return db;
  }
  const seedOld = (db: S["db"]) => {
    db.prepare("INSERT INTO workspaces (id, name, token_hash, created_at) VALUES ('ws_a','Alpha Co','h1','2026-01-01T00:00:00Z'), ('ws_b','Bravo Co','h2','2026-01-02T00:00:00Z')").run();
    db.prepare("INSERT INTO campaigns (id, workspace_id, name, status, current_version, created_at) VALUES ('cmp_1','ws_a','C','draft',1,'t')").run();
    db.prepare("INSERT INTO action_proposals (id, workspace_id, campaign_id, campaign_version, type, payload, payload_hash, daily_budget_cents, integration_mode, status, created_at, updated_at) VALUES ('prp_tok','ws_a','cmp_1',1,'t','{}','x',100,'mock','executed','t','t'), ('prp_none','ws_a','cmp_1',1,'t','{}','x',100,'mock','executed','t','t')").run();
    db.prepare("INSERT INTO audit_events (workspace_id, at, actor, type, entity_type, entity_id, detail) VALUES ('ws_a','t','workspace-token:ws_a','proposal.created','proposal','prp_tok','{}')").run();
  };

  it("gives every existing workspace its own personal organization and a default policy, keeping every id and every row", () => {
    const db = dbThrough014();
    seedOld(db);
    const before = {
      ws: db.prepare("SELECT id, name, token_hash, created_at FROM workspaces ORDER BY id").all(),
      campaigns: db.prepare("SELECT id, workspace_id, name, status, current_version, created_at FROM campaigns").all(), // the original columns (later migrations only add columns)
      audit: db.prepare("SELECT COUNT(*) n FROM audit_events").get(),
    };
    expect(migrate(db)).toEqual(["015_organizations_permissions.sql", "016_brand_kit_assets.sql", "017_plans_lifecycle.sql", "018_creative_studio.sql"]);
    expect(db.prepare("SELECT id, name, token_hash, created_at FROM workspaces ORDER BY id").all()).toEqual(before.ws);
    expect(db.prepare("SELECT id, workspace_id, name, status, current_version, created_at FROM campaigns").all()).toEqual(before.campaigns);
    expect(db.prepare("SELECT COUNT(*) n FROM audit_events").get()).toEqual(before.audit);
    expect(db.prepare("SELECT id, name, kind FROM organizations ORDER BY id").all()).toEqual([{ id: "org_ws_a", name: "Alpha Co", kind: "personal" }, { id: "org_ws_b", name: "Bravo Co", kind: "personal" }]);
    expect(db.prepare("SELECT id, organization_id FROM workspaces ORDER BY id").all()).toEqual([{ id: "ws_a", organization_id: "org_ws_a" }, { id: "ws_b", organization_id: "org_ws_b" }]);
    expect(db.prepare("SELECT workspace_id, prevent_self_approval p FROM workspace_policy ORDER BY workspace_id").all()).toEqual([{ workspace_id: "ws_a", p: 1 }, { workspace_id: "ws_b", p: 1 }]);
  });

  it("backfills who proposed an action from the audit trail, and leaves it unknown where nothing was recorded", () => {
    const db = dbThrough014();
    seedOld(db);
    migrate(db);
    expect(db.prepare("SELECT id, proposed_by, proposed_by_kind FROM action_proposals ORDER BY id").all()).toEqual([
      { id: "prp_none", proposed_by: null, proposed_by_kind: null },
      { id: "prp_tok", proposed_by: "workspace-token:ws_a", proposed_by_kind: "legacy_token" },
    ]);
  });

  it("is idempotent: a second migrate, the application's own backfill and a re-run of the backfill statements change nothing", () => {
    const db = dbThrough014();
    seedOld(db);
    migrate(db);
    const snapshot = () => JSON.stringify([db.prepare("SELECT * FROM organizations ORDER BY id").all(), db.prepare("SELECT id, organization_id FROM workspaces ORDER BY id").all(), db.prepare("SELECT * FROM workspace_policy ORDER BY workspace_id").all()]);
    const first = snapshot();
    expect(migrate(db)).toEqual([]);
    const ctx = buildContext({ db, env: {} });
    expect(backfillTenancy(ctx)).toEqual({ organizationsCreated: 0, policiesCreated: 0 });
    for (const id of ["ws_a", "ws_b"]) ensureWorkspaceDefaults(ctx, id);
    // the migration's own backfill statements, run again by hand
    db.exec("INSERT OR IGNORE INTO organizations (id, name, kind, created_at, created_by) SELECT 'org_' || id, name, 'personal', created_at, NULL FROM workspaces WHERE organization_id IS NULL; UPDATE workspaces SET organization_id = 'org_' || id WHERE organization_id IS NULL;");
    expect(snapshot()).toBe(first);
  });

  it("the application backfill repairs a workspace that somehow lacks an organization or a policy, without touching the others", () => {
    const db = dbThrough014();
    seedOld(db);
    migrate(db);
    db.prepare("INSERT INTO workspaces (id, name, token_hash, created_at) VALUES ('ws_c','Late Co','h3','t')").run(); // made by "an older build" after the migration
    const ctx = buildContext({ db, env: {} });
    expect(backfillTenancy(ctx)).toEqual({ organizationsCreated: 1, policiesCreated: 1 });
    expect(db.prepare("SELECT organization_id FROM workspaces WHERE id = 'ws_c'").get()).toEqual({ organization_id: "org_ws_c" });
    expect(db.prepare("SELECT COUNT(*) n FROM organizations").get()).toEqual({ n: 3 });
  });

  it("a workspace created by the current code gets its personal organization and policy immediately", () => {
    const s = boot();
    const { workspace } = createWorkspace(s.ctx, "Fresh Co");
    expect(one(s.db, "SELECT o.kind, w.organization_id FROM workspaces w JOIN organizations o ON o.id = w.organization_id WHERE w.id = ?", workspace.id)).toEqual({ kind: "personal", organization_id: `org_${workspace.id}` });
    expect(one(s.db, "SELECT prevent_self_approval p FROM workspace_policy WHERE workspace_id = ?", workspace.id)).toEqual({ p: 1 });
  });
});

/* ------------------------------------------------------------------ direct business and agency */

describe("direct business: one workspace, no agency vocabulary", () => {
  it("a person who creates a workspace owns it and its hidden personal organization, and sees one organization of kind 'personal'", async () => {
    const s = boot();
    const pat = await person(s, "pat");
    const ws = await call(s.app, "POST", "/api/workspaces", { token: pat.token, payload: { name: "Pat's Plumbing" } });
    expect(ws.status).toBe(201);
    const orgs = (await call(s.app, "GET", "/api/me/organizations", { token: pat.token })).body.organizations as Json[];
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({ kind: "personal", role: "owner", name: "Pat's Plumbing" });
    expect(one(s.db, "SELECT organization_id o FROM workspaces WHERE id = ?", ws.body.workspace.id)).toEqual({ o: orgs[0]!.id });
  });
});

describe("agency: one organization, several client workspaces, strict separation", () => {
  async function agency() {
    const s = boot();
    const owner = await person(s, "olivia");
    const admin = await person(s, "adam");
    const staff = await person(s, "sam");
    const outsider = await person(s, "otto");
    const client = await person(s, "carla");
    const org = (await call(s.app, "POST", "/api/organizations", { token: owner.token, payload: { name: "Bright Agency" } })).body as Json;
    expect(org.kind).toBe("agency");
    const O = `/api/organizations/${org.id}`;
    expect((await call(s.app, "POST", `${O}/members`, { token: owner.token, payload: { userId: admin.id, role: "admin" } })).status).toBe(201);
    expect((await call(s.app, "POST", `${O}/members`, { token: owner.token, payload: { userId: staff.id, role: "member" } })).status).toBe(201);
    const w1 = (await call(s.app, "POST", `${O}/workspaces`, { token: owner.token, payload: { name: "Client One" } })).body as Json;
    const w2 = (await call(s.app, "POST", `${O}/workspaces`, { token: admin.token, payload: { name: "Client Two" } })).body as Json;
    return { s, owner, admin, staff, outsider, client, org, O, w1: w1.id as string, w2: w2.id as string };
  }

  it("the creator of a client workspace becomes its owner; the workspace belongs to the agency but not to the agency's other staff", async () => {
    const a = await agency();
    expect(one(a.s.db, "SELECT organization_id o FROM workspaces WHERE id = ?", a.w1)).toEqual({ o: a.org.id });
    expect((await call(a.s.app, "GET", `/api/workspaces/${a.w1}`, { token: a.owner.token })).body.role).toBe("owner");
    expect((await call(a.s.app, "GET", `/api/workspaces/${a.w2}`, { token: a.admin.token })).body.role).toBe("owner");
    // organization membership gives NO access to a workspace's data
    expect((await call(a.s.app, "GET", `/api/workspaces/${a.w1}`, { token: a.staff.token })).status).toBe(404);
    expect((await call(a.s.app, "GET", `/api/workspaces/${a.w1}`, { token: a.admin.token })).status).toBe(404);
    expect((await call(a.s.app, "GET", `/api/workspaces/${a.w2}`, { token: a.owner.token })).status).toBe(404);
    expect((await call(a.s.app, "GET", `/api/workspaces/${a.w1}/campaigns`, { token: a.outsider.token })).status).toBe(404);
  });

  it("organization routes: members see only what their organization role allows, and outsiders see nothing", async () => {
    const a = await agency();
    expect((await call(a.s.app, "GET", a.O, { token: a.staff.token })).status).toBe(200); // org.read
    expect((await call(a.s.app, "GET", `${a.O}/workspaces`, { token: a.staff.token })).status).toBe(403); // admin+
    expect((await call(a.s.app, "GET", `${a.O}/workspaces`, { token: a.admin.token })).body.workspaces).toHaveLength(2);
    expect((await call(a.s.app, "POST", `${a.O}/members`, { token: a.admin.token, payload: { userId: a.client.id, role: "member" } })).status).toBe(403); // owner only
    expect((await call(a.s.app, "POST", `${a.O}/role-templates`, { token: a.admin.token, payload: { name: "X Role", permissions: ["brain.read"] } })).status).toBe(403);
    for (const url of [a.O, `${a.O}/workspaces`, `${a.O}/members`, `${a.O}/role-templates`, `${a.O}/audit`]) expect((await call(a.s.app, "GET", url, { token: a.outsider.token })).status, url).toBe(404);
    expect((await call(a.s.app, "GET", a.O)).status).toBe(401);
    // the legacy workspace token is not a person: it reaches no organization route
    const { token } = createWorkspace(a.s.ctx, "Old Co");
    expect((await call(a.s.app, "GET", a.O, { token })).status).toBe(401);
  });

  it("the last organization owner cannot be removed or demoted, and every change lands in the organization's own audit trail", async () => {
    const a = await agency();
    expect((await call(a.s.app, "PATCH", `${a.O}/members/${a.owner.id}`, { token: a.owner.token, payload: { role: "admin" } })).body.error.code).toBe("last_owner");
    expect((await call(a.s.app, "DELETE", `${a.O}/members/${a.owner.id}`, { token: a.owner.token })).body.error.code).toBe("last_owner");
    expect((await call(a.s.app, "PATCH", `${a.O}/members/${a.staff.id}`, { token: a.owner.token, payload: { role: "admin" } })).status).toBe(200);
    const types = ((await call(a.s.app, "GET", `${a.O}/audit`, { token: a.owner.token })).body.events as Json[]).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["organization.created", "org_membership.added", "org_membership.role_changed", "workspace.created"]));
  });

  it("an access grant gives an organization member access to the agency's workspaces only, as a built-in or custom role, and never ownership", async () => {
    const a = await agency();
    const grant = (payload: unknown, token = a.owner.token) => call(a.s.app, "POST", `${a.O}/access-grants`, { token, payload });
    expect((await grant({ userId: a.staff.id, workspaceIds: [a.w1], role: "operator" })).status).toBe(201);
    expect((await call(a.s.app, "GET", `/api/workspaces/${a.w1}`, { token: a.staff.token })).body.role).toBe("operator");
    expect((await call(a.s.app, "GET", `/api/workspaces/${a.w2}`, { token: a.staff.token })).status).toBe(404); // not granted
    expect((await grant({ userId: a.staff.id, workspaceIds: "all", role: "viewer" })).status).toBe(201);
    expect((await call(a.s.app, "GET", `/api/workspaces/${a.w2}`, { token: a.staff.token })).body.role).toBe("viewer");
    expect((await grant({ userId: a.staff.id, workspaceIds: [a.w1], role: "owner" })).body.error.code).toBe("invalid_role");
    expect((await grant({ userId: a.outsider.id, workspaceIds: [a.w1], role: "viewer" })).status).toBe(404); // not an organization member
    expect((await grant({ userId: a.staff.id, workspaceIds: [a.w1], role: "viewer" }, a.admin.token)).status).toBe(403); // owner only
    // a workspace of ANOTHER organization looks like one that does not exist, and nothing is granted
    const other = await person(a.s, "olga");
    const otherOrg = (await call(a.s.app, "POST", "/api/organizations", { token: other.token, payload: { name: "Other Agency" } })).body as Json;
    const foreign = (await call(a.s.app, "POST", `/api/organizations/${otherOrg.id}/workspaces`, { token: other.token, payload: { name: "Foreign Co" } })).body as Json;
    expect((await grant({ userId: a.staff.id, workspaceIds: [foreign.id], role: "viewer" })).status).toBe(404);
    expect((await call(a.s.app, "GET", `/api/workspaces/${foreign.id}`, { token: a.staff.token })).status).toBe(404);
    // an existing owner is never downgraded by a grant
    expect((await grant({ userId: a.owner.id, workspaceIds: [a.w1], role: "viewer" })).status).toBe(201);
    expect((await call(a.s.app, "GET", `/api/workspaces/${a.w1}`, { token: a.owner.token })).body.role).toBe("owner");
  });

  it("two agencies and their clients never see each other (cross-tenant matrix)", async () => {
    const a = await agency();
    const other = await person(a.s, "olga");
    const oo = (await call(a.s.app, "POST", "/api/organizations", { token: other.token, payload: { name: "Other Agency" } })).body as Json;
    const ow = (await call(a.s.app, "POST", `/api/organizations/${oo.id}/workspaces`, { token: other.token, payload: { name: "Foreign Co" } })).body as Json;
    const mine = [`/api/workspaces/${a.w1}`, `/api/workspaces/${a.w1}/campaigns`, `/api/workspaces/${a.w1}/members`, `/api/workspaces/${a.w1}/policy`, a.O, `${a.O}/members`, `${a.O}/role-templates`, `${a.O}/audit`];
    const theirs = [`/api/workspaces/${ow.id}`, `/api/workspaces/${ow.id}/campaigns`, `/api/organizations/${oo.id}`, `/api/organizations/${oo.id}/members`];
    for (const u of mine) expect((await call(a.s.app, "GET", u, { token: other.token })).status, `other -> ${u}`).toBe(404);
    for (const u of theirs) expect((await call(a.s.app, "GET", u, { token: a.owner.token })).status, `owner -> ${u}`).toBe(404);
    expect(((await call(a.s.app, "GET", "/api/me/organizations", { token: other.token })).body.organizations as Json[]).map((o) => o.id)).toEqual([oo.id]);
  });
});

/* ------------------------------------------------------------------ custom roles */

describe("custom roles: enforced on the server, previewed before saving, audited", () => {
  async function setup() {
    const s = boot();
    const owner = await person(s, "olivia");
    const member = await person(s, "mia");
    const org = (await call(s.app, "POST", "/api/organizations", { token: owner.token, payload: { name: "Bright Agency" } })).body as Json;
    const O = `/api/organizations/${org.id}`;
    const ws = (await call(s.app, "POST", `${O}/workspaces`, { token: owner.token, payload: { name: "Client One" } })).body as Json;
    await call(s.app, "POST", `${O}/members`, { token: owner.token, payload: { userId: member.id, role: "member" } });
    const W = `/api/workspaces/${ws.id}`;
    expect((await call(s.app, "PUT", `${W}/brain`, { token: owner.token, payload: BRAIN })).status).toBe(200);
    return { s, owner, member, org, O, W, wid: ws.id as string };
  }
  const makeRole = (x: Awaited<ReturnType<typeof setup>>, name: string, permissions: string[]) => call(x.s.app, "POST", `${x.O}/role-templates`, { token: x.owner.token, payload: { name, permissions } });

  it("a custom role replaces the built-in set: exactly what it lists is allowed and nothing else", async () => {
    const x = await setup();
    const role = (await makeRole(x, "Copywriter", ["workspace.read", "brain.read", "campaigns.read", "campaigns.generate", "campaigns.edit"])).body as Json;
    expect((await call(x.s.app, "POST", `${x.O}/access-grants`, { token: x.owner.token, payload: { userId: x.member.id, workspaceIds: [x.wid], customRoleId: role.id } })).status).toBe(201);
    const me = (await call(x.s.app, "GET", x.W, { token: x.member.token })).body;
    expect(me.customRoleId).toBe(role.id);
    expect([...me.permissions].sort()).toEqual(["brain.read", "campaigns.edit", "campaigns.generate", "campaigns.read", "workspace.read"]);
    expect((await call(x.s.app, "GET", `${x.W}/brain`, { token: x.member.token })).status).toBe(200);
    expect((await call(x.s.app, "POST", `${x.W}/campaigns/generate`, { token: x.member.token, payload: { providerId: "mock", model: "mock-deterministic-1" } })).status).toBe(201);
    // not listed -> refused, even though a built-in "viewer" could read these
    for (const [m, u] of [["GET", "/leads"], ["GET", "/activity"], ["GET", "/proposals/x"], ["GET", "/ai/usage"], ["GET", "/members"], ["PUT", "/brain"]] as const) {
      expect((await call(x.s.app, m, `${x.W}${u}`, { token: x.member.token, payload: m === "PUT" ? BRAIN : undefined })).status, `${m} ${u}`).toBe(403);
    }
    // the dashboard follows the same set: workspace.read is in the role, jobs.read is not, so no job section
    const dash = await call(x.s.app, "GET", `${x.W}/dashboard`, { token: x.member.token });
    expect(dash.status).toBe(200);
    expect(dash.body.jobs).toBeNull();
  });

  it("changing a role takes effect on the very next request and is audited with the before and after lists", async () => {
    const x = await setup();
    const role = (await makeRole(x, "Reader", ["workspace.read", "brain.read"])).body as Json;
    await call(x.s.app, "POST", `${x.O}/access-grants`, { token: x.owner.token, payload: { userId: x.member.id, workspaceIds: [x.wid], customRoleId: role.id } });
    expect((await call(x.s.app, "GET", `${x.W}/leads`, { token: x.member.token })).status).toBe(403);
    expect((await call(x.s.app, "PUT", `${x.O}/role-templates/${role.id}`, { token: x.owner.token, payload: { name: "Reader", permissions: ["workspace.read", "brain.read", "leads.read"] } })).status).toBe(200);
    expect((await call(x.s.app, "GET", `${x.W}/leads`, { token: x.member.token })).status).toBe(200);
    const orgEv = ((await call(x.s.app, "GET", `${x.O}/audit`, { token: x.owner.token })).body.events as Json[]).find((e) => e.type === "role.updated")!;
    expect(orgEv.detail.before).toEqual(["brain.read", "workspace.read"]);
    expect(orgEv.detail.after).toEqual(["workspace.read", "brain.read", "leads.read"]);
    const wsEv = ((await call(x.s.app, "GET", `${x.W}/activity`, { token: x.owner.token })).body as Json[]).find((e) => e.type === "role.permissions_changed");
    expect(wsEv).toBeTruthy();
  });

  it("owner-only permissions and unknown permissions can never be put in a custom role, and the refusal names what is wrong", async () => {
    const x = await setup();
    for (const p of ["members.manage", "roles.manage", "policy.manage", "credentials.manage", "credentials.read", "meta_accounts.manage", "legacy_token.disable"]) {
      const r = await makeRole(x, `Bad ${p}`, ["workspace.read", p]);
      expect(r.status, p).toBe(400);
      expect(r.body.error.code).toBe("owner_only_permission");
    }
    expect((await makeRole(x, "Bad unknown", ["workspace.read", "world.domination"])).body.error.code).toBe("unknown_permission");
    expect((await makeRole(x, "Empty", [])).status).toBe(400);
    expect((await makeRole(x, "Ok", ["workspace.read"])).status).toBe(201);
    expect((await makeRole(x, "Ok", ["workspace.read"])).body.error.code).toBe("role_exists");
  });

  it("a role from another organization cannot be assigned, an archived or vanished role grants nothing, and a role in use cannot be archived", async () => {
    const x = await setup();
    const other = await person(x.s, "olga");
    const oo = (await call(x.s.app, "POST", "/api/organizations", { token: other.token, payload: { name: "Other Agency" } })).body as Json;
    const foreign = (await call(x.s.app, "POST", `/api/organizations/${oo.id}/role-templates`, { token: other.token, payload: { name: "Foreign", permissions: ["workspace.read"] } })).body as Json;
    expect((await call(x.s.app, "POST", `${x.O}/access-grants`, { token: x.owner.token, payload: { userId: x.member.id, workspaceIds: [x.wid], customRoleId: foreign.id } })).status).toBe(404);
    const mine = (await makeRole(x, "Reader", ["workspace.read", "brain.read"])).body as Json;
    await call(x.s.app, "POST", `${x.O}/access-grants`, { token: x.owner.token, payload: { userId: x.member.id, workspaceIds: [x.wid], customRoleId: mine.id } });
    expect((await call(x.s.app, "DELETE", `${x.O}/role-templates/${mine.id}`, { token: x.owner.token })).body.error.code).toBe("role_in_use");
    // someone edits the database so the role is archived under a member: they get NO permissions, never more
    x.s.db.prepare("UPDATE role_templates SET archived_at = 't' WHERE id = ?").run(mine.id);
    expect((await call(x.s.app, "GET", `${x.W}/brain`, { token: x.member.token })).status).toBe(403);
    expect((await call(x.s.app, "GET", x.W, { token: x.member.token })).status).toBe(403);
    // another organization's owner cannot edit or archive this organization's role
    expect((await call(x.s.app, "PUT", `/api/organizations/${oo.id}/role-templates/${mine.id}`, { token: other.token, payload: { name: "Hijack", permissions: ["workspace.read"] } })).status).toBe(404);
  });

  it("the last workspace owner cannot be moved to a custom role, and only an owner may assign roles", async () => {
    const x = await setup();
    const role = (await makeRole(x, "Reader", ["workspace.read"])).body as Json;
    expect((await call(x.s.app, "PATCH", `${x.W}/members/${x.owner.id}`, { token: x.owner.token, payload: { customRoleId: role.id } })).body.error.code).toBe("last_owner");
    await call(x.s.app, "POST", `${x.O}/access-grants`, { token: x.owner.token, payload: { userId: x.member.id, workspaceIds: [x.wid], role: "admin" } });
    expect((await call(x.s.app, "PATCH", `${x.W}/members/${x.member.id}`, { token: x.member.token, payload: { customRoleId: role.id } })).status).toBe(403); // an admin cannot change roles
    expect((await call(x.s.app, "PATCH", `${x.W}/members/${x.member.id}`, { token: x.owner.token, payload: { role: "viewer", customRoleId: role.id } })).status).toBe(400); // one or the other
    expect((await call(x.s.app, "PATCH", `${x.W}/members/${x.member.id}`, { token: x.owner.token, payload: { customRoleId: role.id } })).status).toBe(200);
    expect((await call(x.s.app, "PATCH", `${x.W}/members/${x.member.id}`, { token: x.owner.token, payload: { role: "operator" } })).status).toBe(200); // back to a built-in role clears the custom one
    expect((await call(x.s.app, "GET", x.W, { token: x.member.token })).body.customRoleId).toBeNull();
  });

  it("the permission preview says in plain words what a role can and cannot do, and warns about odd combinations, without saving anything", async () => {
    const x = await setup();
    const before = (await call(x.s.app, "GET", `${x.O}/role-templates`, { token: x.owner.token })).body.roles.length;
    const r = await call(x.s.app, "POST", `${x.O}/role-preview`, { token: x.owner.token, payload: { permissions: ["proposals.create", "proposals.decide", "campaigns.edit"] } });
    expect(r.status).toBe(200);
    const approvals = (r.body.groups as Json[]).find((g) => g.group === "Approvals")!;
    expect(approvals.can).toEqual(expect.arrayContaining(["Submit a campaign for approval", "Approve or reject proposals"]));
    expect(approvals.cannot).toContain("Run an approved action (simulated in this release)");
    expect((r.body.warnings as string[]).join(" ")).toMatch(/submit and approve/);
    expect((r.body.warnings as string[]).join(" ")).toMatch(/Editing campaigns without being able to read/);
    expect((await call(x.s.app, "GET", `${x.O}/role-templates`, { token: x.owner.token })).body.roles).toHaveLength(before);
    expect((await call(x.s.app, "POST", `${x.O}/role-preview`, { token: x.owner.token, payload: { permissions: ["members.manage"] } })).status).toBe(400);
    const catalog = (await call(x.s.app, "GET", `${x.O}/permissions`, { token: x.owner.token })).body.permissions as Json[];
    expect(catalog.map((p) => p.permission)).not.toContain("members.manage");
  });
});
