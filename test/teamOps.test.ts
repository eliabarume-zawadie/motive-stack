/**
 * Phase 5: team operations. Owners and reviewers (coordination, never authorization), dated tasks tied to the EXACT campaign/creative version and a stated action,
 * an inbox built from real records, a calendar that never claims a platform schedule, and in-app notifications only. Signed-in people are test identities.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { createWorker } from "../src/app/worker.js";
import { buildAuthRuntime, loadAuthConfig, workspaceTokenRuntime } from "../src/auth/config.js";
import { StaticJwks } from "../src/auth/jwks.js";
import { MockImageProvider } from "../src/creative/image.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { createWorkspace } from "../src/app/workspaces.js";
import { MemoryAssetStore } from "../src/storage/assetStore.js";
import { BRAIN } from "./fixtures.js";
import { AUDIENCE, ISSUER, NOW_MS, OIDC_REQUIRED, OPEN_POLICY, claims, makeKey, signJwt } from "./support/jwt.js";

const rsa = makeKey("RS256", "rsa-1");
const OIDC_ENV = { AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: "https://idp.example.test/jwks", ...OIDC_REQUIRED };
const oidc = () => buildAuthRuntime(loadAuthConfig(OIDC_ENV), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS, policy: OPEN_POLICY });
const open: Array<() => void> = [];
afterEach(() => { while (open.length) open.pop()?.(); });

type Json = Record<string, any>;
async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT" | "PATCH", url: string, token?: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as Json };
}
function boot(mode: "oidc" | "token" = "oidc") {
  const db = openDb(":memory:");
  migrate(db);
  const provider = new MockImageProvider();
  const ctx: AppContext = buildContext({ db, env: {}, backoffMs: () => 0, gateway: { sleep: async () => {} }, assetStore: new MemoryAssetStore(), imageProvider: provider });
  const app = buildServer(ctx, mode === "oidc" ? oidc() : workspaceTokenRuntime);
  open.push(() => db.open && db.close());
  return { db, ctx, app, provider, worker: createWorker(ctx) };
}
type S = ReturnType<typeof boot>;
async function person(s: S, name: string) {
  const token = signJwt(rsa, claims({ sub: `idp|${name}`, name }));
  return { token, id: (await call(s.app, "GET", "/api/me", token)).body.user.id as string, name };
}

async function world() {
  const s = boot();
  const owner = await person(s, "olivia"), admin = await person(s, "adam"), admin2 = await person(s, "amy"), operator = await person(s, "oscar"), viewer = await person(s, "vera"), outsider = await person(s, "otto");
  const W = (await call(s.app, "POST", "/api/workspaces", owner.token, { name: "Team Co" })).body.workspace.id as string;
  const base = `/api/workspaces/${W}`;
  for (const [p, role] of [[admin, "admin"], [admin2, "admin"], [operator, "operator"], [viewer, "viewer"]] as const) expect((await call(s.app, "POST", `${base}/members`, owner.token, { userId: p.id, role })).status).toBe(201);
  expect((await call(s.app, "PUT", `${base}/brain`, owner.token, BRAIN)).status).toBe(200);
  const cid = (await call(s.app, "POST", `${base}/campaigns/generate`, owner.token, { providerId: "mock", model: "mock-deterministic-1" })).body.id as string;
  const concept = { headline: "Fast help, fair price", subline: "Free on-site quote", callToAction: "GET_QUOTE", visualDescription: "A clean, bright layout", palette: { background: "#FFFFFF", foreground: "#1B1B1B", accent: "#1A4D8F" } };
  const creative = async () => {
    const r = await call(s.app, "POST", `${base}/campaigns/${cid}/creatives`, operator.token, { name: "Spring ad", brief: { objective: "Get quotes", keyMessage: "Fast help" }, concept, altText: "A bright advertisement with a headline", ratios: ["1:1"] });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const readyCreative = async () => { const id = await creative(); await call(s.app, "POST", `${base}/creatives/${id}/versions/1/renders`, operator.token, {}); await s.worker.runUntilIdle(); return id; };
  const get = (path: string, by: { token: string }) => call(s.app, "GET", `${base}${path}`, by.token);
  const work = (by: { token: string }, body: Json) => call(s.app, "POST", `${base}/work-items`, by.token, { campaignId: cid, ...body });
  const inboxFor = async (by: { token: string }) => (await get("/inbox", by)).body;
  const notes = async (by: { token: string }) => (await get("/notifications", by)).body;
  return { s, owner, admin, admin2, operator, viewer, outsider, W, base, cid, creative, readyCreative, get, work, inboxFor, notes };
}
type Wd = Awaited<ReturnType<typeof world>>;

describe("owners and reviewers: coordination only", () => {
  it("lists only active members, by name and role, never an e-mail address", async () => {
    const w = await world();
    const r = await w.get("/assignees", w.viewer);
    expect(r.status).toBe(200);
    expect(r.body.assignees.map((a: Json) => a.name).sort()).toEqual(["adam", "amy", "olivia", "oscar", "vera"]);
    expect(JSON.stringify(r.body)).not.toMatch(/@/);
    expect(r.body.assignees.every((a: Json) => Object.keys(a).sort().join() === "name,role,userId")).toBe(true);
  });

  it("an admin sets the owner and reviewer of a campaign and a creative; they are told in the app; nobody else is", async () => {
    const w = await world();
    const crid = await w.creative();
    const put = (body: Json, by = w.admin) => call(w.s.app, "PUT", `${w.base}/ownerships`, by.token, body);
    expect((await put({ subjectType: "campaign", subjectId: w.cid, ownerUserId: w.operator.id, reviewerUserId: w.admin2.id })).body).toMatchObject({ ownerName: "oscar", reviewerName: "amy" });
    expect((await put({ subjectType: "creative", subjectId: crid, reviewerUserId: w.owner.id })).body).toMatchObject({ reviewerName: "olivia", ownerUserId: null });
    expect((await w.notes(w.operator)).notifications.map((n: Json) => n.kind)).toEqual(["assigned_owner"]);
    expect((await w.notes(w.admin2)).notifications.map((n: Json) => n.kind)).toEqual(["assigned_reviewer"]);
    expect((await w.notes(w.viewer)).notifications).toEqual([]);
    // changing nothing again does not notify twice; assigning yourself does not notify you
    await put({ subjectType: "campaign", subjectId: w.cid, ownerUserId: w.operator.id });
    expect((await w.notes(w.operator)).notifications).toHaveLength(1);
    await put({ subjectType: "campaign", subjectId: w.cid, ownerUserId: w.admin.id });
    expect((await w.notes(w.admin)).notifications).toEqual([]);
    expect((await w.get(`/ownerships/campaign/${w.cid}`, w.viewer)).body).toMatchObject({ ownerName: "adam", reviewerName: "amy" });
  });

  it("only active members can be assigned, only admins can assign, and assigning grants nothing", async () => {
    const w = await world();
    const put = (body: Json, by: { token: string }) => call(w.s.app, "PUT", `${w.base}/ownerships`, by.token, body);
    expect((await put({ subjectType: "campaign", subjectId: w.cid, ownerUserId: w.outsider.id }, w.admin)).body.error.code).toBe("not_a_member");
    expect((await put({ subjectType: "campaign", subjectId: w.cid, ownerUserId: w.viewer.id }, w.operator)).status).toBe(403);
    expect((await put({ subjectType: "campaign", subjectId: "nope", ownerUserId: w.viewer.id }, w.admin)).status).toBe(404);
    // a viewer made reviewer of a creative still cannot approve it
    const id = await w.readyCreative();
    await put({ subjectType: "creative", subjectId: id, reviewerUserId: w.viewer.id }, w.admin);
    await call(w.s.app, "POST", `${w.base}/creatives/${id}/versions/1/submit`, w.operator.token);
    expect((await call(w.s.app, "POST", `${w.base}/creatives/${id}/versions/1/approve`, w.viewer.token, {})).status).toBe(403);
  });
});

describe("tasks and dated milestones are tied to the exact version and a stated action", () => {
  it("records the campaign version, the creative version and what has to be done", async () => {
    const w = await world();
    const crid = await w.creative();
    const r = await w.work(w.operator, { kind: "review", creativeId: crid, title: "Review the spring ad", dueDate: "2030-05-01", reviewerUserId: w.admin.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ kind: "review", status: "open", dueDate: "2030-05-01", overdue: false, campaign: { id: w.cid, version: 1 }, creative: { id: crid, name: "Spring ad", version: 1 }, reviewer: { name: "adam" } });
    expect(r.body.requiredAction).toBe("Review creative “Spring ad” version 1");
    expect((await w.notes(w.admin)).notifications[0]).toMatchObject({ kind: "assigned_task" });
    const prop = await call(w.s.app, "POST", `${w.base}/campaigns/${w.cid}/proposals`, w.operator.token, {});
    const sched = await w.work(w.operator, { kind: "schedule_proposal", title: "Aim to run on the 15th", dueDate: "2030-06-15", proposalId: prop.body.id });
    expect(sched.body).toMatchObject({ proposedOnly: true });
    expect(sched.body.requiredAction).toMatch(/Proposed only: nothing is scheduled on any ad platform/);
  });

  it("refuses what cannot be exact: a review without a creative, an approval without a proposal, a bad date, a creative from elsewhere, a non-member", async () => {
    const w = await world();
    const crid = await w.creative();
    expect((await w.work(w.operator, { kind: "review", title: "x" })).body.error.code).toBe("creative_required");
    expect((await w.work(w.operator, { kind: "approval", title: "x" })).body.error.code).toBe("proposal_required");
    expect((await w.work(w.operator, { kind: "other", title: "x", dueDate: "2030-02-31" })).status).toBe(400);
    expect((await w.work(w.operator, { kind: "other", title: "x", dueDate: "tomorrow" })).status).toBe(400);
    expect((await w.work(w.operator, { kind: "review", title: "x", creativeId: crid, creativeVersion: 9 })).status).toBe(404);
    expect((await w.work(w.operator, { kind: "other", title: "x", ownerUserId: w.outsider.id })).body.error.code).toBe("not_a_member");
    expect((await w.work(w.operator, { kind: "other", title: "x", campaignId: "nope" })).status).toBe(404);
    expect((await w.work(w.viewer, { kind: "other", title: "x" })).status).toBe(403);
    // a second campaign's creative cannot hang off the first campaign
    const c2 = (await call(w.s.app, "POST", `${w.base}/campaigns/generate`, w.owner.token, { providerId: "mock", model: "mock-deterministic-1" })).body.id as string;
    expect((await w.work(w.operator, { kind: "review", title: "x", campaignId: c2, creativeId: crid })).body.error.code).toBe("creative_not_in_campaign");
  });

  it("says so when the thing it points at has moved on, and shows overdue honestly", async () => {
    const w = await world();
    const crid = await w.creative();
    const made = (await w.work(w.operator, { kind: "review", creativeId: crid, title: "Review", dueDate: "2000-01-01" })).body;
    expect(made.overdue).toBe(true);
    await call(w.s.app, "POST", `${w.base}/creatives/${crid}/versions`, w.operator.token, { brief: { objective: "a", keyMessage: "b" }, concept: { headline: "New words", subline: "", callToAction: "GET_QUOTE", visualDescription: "A clean, bright layout", palette: { background: "#FFFFFF", foreground: "#1B1B1B", accent: "#1A4D8F" } }, altText: "A bright advertisement, new words", ratios: ["1:1"] });
    const item = (await w.get("/work-items?status=open", w.viewer)).body.workItems[0];
    expect(item.notes.join(" ")).toMatch(/Creative version 1 has been replaced by version 2/);
    expect(item.creative.version).toBe(1); // it still names the version it was set up for
  });

  it("can be completed, reopened, cancelled and re-dated, and every change is audited", async () => {
    const w = await world();
    const id = (await w.work(w.operator, { kind: "other", title: "Call the printer", dueDate: "2030-01-10" })).body.id as string;
    const patch = (body: Json, by = w.operator) => call(w.s.app, "PATCH", `${w.base}/work-items/${id}`, by.token, body);
    expect((await patch({ status: "done" })).body).toMatchObject({ status: "done", closedReason: "done_by_person" });
    expect((await patch({ title: "x" })).body.error.code).toBe("work_item_closed");
    expect((await patch({ status: "open", dueDate: "2030-02-01" })).body).toMatchObject({ status: "open", dueDate: "2030-02-01", closedReason: null });
    expect((await patch({ status: "cancelled" })).body.status).toBe("cancelled");
    expect((await patch({ status: "open" }, w.viewer)).status).toBe(403);
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE type LIKE 'work_item.%'").get()).toEqual({ n: 4 }); // created, done, reopened, cancelled: the refused edits leave no trace
  });
});

describe("the inbox is built from real records and closes itself when the decision is made", () => {
  it("shows a creative waiting for review with its exact version, who is expected to review it, and whether you can act", async () => {
    const w = await world();
    const id = await w.readyCreative();
    await call(w.s.app, "PUT", `${w.base}/ownerships`, w.admin.token, { subjectType: "creative", subjectId: id, reviewerUserId: w.admin2.id });
    await call(w.s.app, "POST", `${w.base}/creatives/${id}/versions/1/submit`, w.operator.token);
    const mine = await w.inboxFor(w.admin2);
    const item = mine.waiting.find((x: Json) => x.kind === "creative_review");
    expect(item).toMatchObject({ title: "Spring ad", subject: { type: "creative", id, version: 1 }, assignedToYou: true, reviewer: "amy", canAct: true, go: "creative" });
    expect(item.action).toBe("Review creative version 1");
    expect((await w.notes(w.admin2)).notifications.map((n: Json) => n.kind)).toContain("review_requested");
    const theirs = (await w.inboxFor(w.operator)).waiting.find((x: Json) => x.kind === "creative_review");
    expect(theirs).toMatchObject({ assignedToYou: false, canAct: false, reviewer: "amy" }); // visible to the team, but an operator cannot approve
  });

  it("an approval closes the review task it was waiting for and tells the submitter; the inbox stops asking", async () => {
    const w = await world();
    const id = await w.readyCreative();
    const task = (await w.work(w.operator, { kind: "review", creativeId: id, title: "Review it", reviewerUserId: w.admin2.id })).body.id as string;
    await call(w.s.app, "POST", `${w.base}/creatives/${id}/versions/1/submit`, w.operator.token);
    expect((await w.inboxFor(w.admin2)).assignedToYou.map((x: Json) => x.id)).toEqual([task]);
    expect((await call(w.s.app, "POST", `${w.base}/creatives/${id}/versions/1/approve`, w.admin2.token, {})).status).toBe(200);
    const after = await w.inboxFor(w.admin2);
    expect(after.assignedToYou).toEqual([]);
    expect(after.waiting.filter((x: Json) => x.kind === "creative_review")).toEqual([]);
    expect((await w.get("/work-items?status=done", w.viewer)).body.workItems[0]).toMatchObject({ id: task, closedReason: "closed_by_approval" });
    expect((await w.notes(w.operator)).notifications.map((n: Json) => n.kind)).toContain("creative_approved");
  });

  it("a rejection closes it too, and a proposal's approval and run requests close their own tasks", async () => {
    const w = await world();
    const id = await w.readyCreative();
    const t1 = (await w.work(w.operator, { kind: "review", creativeId: id, title: "Review" })).body.id as string;
    await call(w.s.app, "POST", `${w.base}/creatives/${id}/versions/1/submit`, w.operator.token);
    await call(w.s.app, "POST", `${w.base}/creatives/${id}/versions/1/reject`, w.admin.token, { reason: "Not right" });
    const prop = (await call(w.s.app, "POST", `${w.base}/campaigns/${w.cid}/proposals`, w.operator.token, {})).body.id as string;
    const t2 = (await w.work(w.operator, { kind: "approval", proposalId: prop, title: "Approve" })).body.id as string;
    const t3 = (await w.work(w.operator, { kind: "run", proposalId: prop, title: "Run" })).body.id as string;
    expect((await w.inboxFor(w.admin)).waiting.some((x: Json) => x.kind === "proposal_approval" && x.subject.id === prop)).toBe(true);
    await call(w.s.app, "POST", `${w.base}/proposals/${prop}/approve`, w.admin.token, { decidedBy: "x", acknowledgedReview: true });
    expect((await w.inboxFor(w.admin)).waiting.some((x: Json) => x.kind === "approved_not_run")).toBe(true);
    await call(w.s.app, "POST", `${w.base}/proposals/${prop}/execute`, w.admin.token);
    const done = Object.fromEntries((await w.get("/work-items?status=done", w.viewer)).body.workItems.map((x: Json) => [x.id, x.closedReason]));
    expect(done).toEqual({ [t1]: "closed_by_rejection", [t2]: "closed_by_approval", [t3]: "closed_by_run_request" });
  });

  it("lists failed pictures, failed jobs, a missing Business Brain and blocking questions as problems, each with the action that exists", async () => {
    const w = await world();
    w.s.provider.faults.refuse = true;
    const id = await w.creative();
    await call(w.s.app, "POST", `${w.base}/creatives/${id}/versions/1/renders`, w.operator.token, {});
    await w.s.worker.runUntilIdle();
    w.s.db.prepare("INSERT INTO jobs (id, workspace_id, type, payload, dedupe_key, status, attempts, max_attempts, run_at, last_error, created_at, updated_at) VALUES ('job_x', ?, 'process_lead', '{}', 'k1', 'dead', 5, 5, ?, 'CRM unreachable', ?, ?)").run(w.W, "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z");
    const inbox = await w.inboxFor(w.operator);
    const kinds = inbox.problems.map((p: Json) => p.kind).sort();
    expect(kinds).toEqual(["job_failed", "render_failed"]);
    expect(inbox.problems.find((p: Json) => p.kind === "render_failed")).toMatchObject({ canAct: true, go: "creative", subject: { id, version: 1 } });
    expect(inbox.problems.find((p: Json) => p.kind === "job_failed")).toMatchObject({ canAct: false, actionPermission: "jobs.retry" }); // an operator cannot retry jobs
    expect((await w.inboxFor(w.admin)).problems.find((p: Json) => p.kind === "job_failed").canAct).toBe(true);
    // a workspace with no Business Brain
    const s2 = boot();
    const o = await person(s2, "olivia");
    const W2 = (await call(s2.app, "POST", "/api/workspaces", o.token, { name: "Empty Co" })).body.workspace.id as string;
    expect((await call(s2.app, "GET", `/api/workspaces/${W2}/inbox`, o.token)).body.problems.map((p: Json) => p.kind)).toEqual(["brain_missing"]);
  });

  it("shows dated work: overdue first, and what is due within two weeks, to everyone in the workspace", async () => {
    const w = await world();
    const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const far = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
    await w.work(w.operator, { kind: "other", title: "Late", dueDate: "2000-01-01", ownerUserId: w.operator.id });
    await w.work(w.operator, { kind: "other", title: "Soon", dueDate: soon });
    await w.work(w.operator, { kind: "other", title: "Far away", dueDate: far });
    await w.work(w.operator, { kind: "other", title: "No date" });
    const inbox = await w.inboxFor(w.viewer);
    expect(inbox.dates.map((d: Json) => [d.title, d.overdue])).toEqual([["Late", true], ["Soon", false]]);
    expect(inbox.counts).toMatchObject({ overdue: 1, dueSoon: 1 });
    expect((await w.inboxFor(w.operator)).assignedToYou.map((x: Json) => x.title)).toEqual(["Late"]);
  });

  it("the shared workspace token is not a person: no assignments, no notifications, and it says so", async () => {
    const s = boot("token");
    const { workspace, token } = createWorkspace(s.ctx, "Token Co");
    const base = `/api/workspaces/${workspace.id}`;
    const inbox = (await call(s.app, "GET", `${base}/inbox`, token)).body;
    expect(inbox.viewer.isPerson).toBe(false);
    expect(inbox.viewer.note).toMatch(/not a person/);
    expect(inbox.assignedToYou).toEqual([]);
    const n = (await call(s.app, "GET", `${base}/notifications`, token)).body;
    expect(n).toMatchObject({ available: false, notifications: [] });
    expect((await call(s.app, "POST", `${base}/notifications/read-all`, token)).status).toBe(403);
  });
});

describe("the calendar", () => {
  it("shows dated work and real record dates, never claims a platform schedule, and links to campaign, creative version, owner, reviewer and job", async () => {
    const w = await world();
    const id = await w.readyCreative();
    const prop = (await call(w.s.app, "POST", `${w.base}/campaigns/${w.cid}/proposals`, w.operator.token, {})).body.id as string;
    await w.work(w.operator, { kind: "review", creativeId: id, title: "Review", dueDate: "2030-03-05", ownerUserId: w.operator.id, reviewerUserId: w.admin.id });
    await w.work(w.operator, { kind: "schedule_proposal", title: "Aim to run", dueDate: "2030-03-10", proposalId: prop });
    await w.work(w.operator, { kind: "other", title: "Outside the range", dueDate: "2031-01-01" });
    const cal = (await w.get("/calendar?from=2030-03-01&to=2030-03-31", w.viewer)).body;
    expect(cal.platformSchedule).toBe(false);
    expect(cal.notes.join(" ")).toMatch(/Nothing is scheduled on any ad platform/);
    expect(cal.entries.map((e: Json) => [e.date, e.type])).toEqual([["2030-03-05", "review"], ["2030-03-10", "schedule_proposal"]]);
    expect(cal.entries[0]).toMatchObject({ campaign: { id: w.cid }, creative: { id, version: 1 }, owner: { name: "oscar" }, reviewer: { name: "adam" }, source: "work_item" });
    expect(cal.entries[1].label).toBe("Proposed date (not a platform schedule)");
    // the day an approval stops counting is a real date, from the approval record
    await call(w.s.app, "POST", `${w.base}/proposals/${prop}/approve`, w.admin.token, { decidedBy: "x", acknowledgedReview: true });
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const near = (await w.get(`/calendar?from=${new Date().toISOString().slice(0, 10)}&to=${tomorrow}`, w.viewer)).body.entries.find((e: Json) => e.type === "approval_expires");
    expect(near).toMatchObject({ source: "record", label: "Approval expires", proposal: { id: prop } });
    expect(near.requiredAction).toMatch(/before .* UTC, or it must be approved again/);
  });

  it("validates the range and reports a run's job state", async () => {
    const w = await world();
    expect((await w.get("/calendar?from=2030-03-10&to=2030-03-01", w.viewer)).body.error.code).toBe("bad_range");
    expect((await w.get("/calendar?from=2030-01-01&to=2030-12-31", w.viewer)).body.error.code).toBe("range_too_long");
    expect((await w.get("/calendar?from=soon", w.viewer)).status).toBe(400);
    const prop = (await call(w.s.app, "POST", `${w.base}/campaigns/${w.cid}/proposals`, w.operator.token, {})).body.id as string;
    await call(w.s.app, "POST", `${w.base}/proposals/${prop}/approve`, w.admin.token, { decidedBy: "x", acknowledgedReview: true });
    await w.work(w.operator, { kind: "run", proposalId: prop, title: "Run it", dueDate: "2030-04-01" });
    await call(w.s.app, "POST", `${w.base}/proposals/${prop}/execute`, w.admin.token);
    const e = (await w.get("/calendar?from=2030-04-01&to=2030-04-02", w.viewer)).body.entries[0];
    expect(e.job).toMatchObject({ status: "queued" });
  });
});

describe("notifications are private, in-app, and nothing is sent anywhere", () => {
  it("each person sees only their own, can mark one or all read, and cannot touch someone else's", async () => {
    const w = await world();
    await call(w.s.app, "PUT", `${w.base}/ownerships`, w.admin.token, { subjectType: "campaign", subjectId: w.cid, ownerUserId: w.operator.id, reviewerUserId: w.operator.id });
    await w.work(w.admin, { kind: "other", title: "Task", ownerUserId: w.operator.id });
    const mine = await w.notes(w.operator);
    expect(mine.unread).toBe(3);
    const first = mine.notifications[0].id as string;
    expect((await call(w.s.app, "POST", `${w.base}/notifications/${first}/read`, w.viewer.token)).status).toBe(404); // not theirs
    expect((await call(w.s.app, "POST", `${w.base}/notifications/${first}/read`, w.operator.token)).body.unread).toBe(2);
    expect((await call(w.s.app, "POST", `${w.base}/notifications/read-all`, w.operator.token)).body.unread).toBe(0);
    expect(JSON.stringify(mine)).not.toMatch(/@|mailto/);
  });

  it("has no e-mail, SMS or push path: the code that records a notification only writes to the database", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/teamOps.ts", "utf8");
    expect(src).not.toMatch(/nodemailer|smtp|twilio|sendgrid|webhook|fetch\(|https?:\/\/|web-push|sendMail/i);
  });
});

describe("isolation", () => {
  it("another workspace sees none of the tasks, owners, notifications, inbox or calendar", async () => {
    const w = await world();
    await w.work(w.operator, { kind: "other", title: "Private", dueDate: "2030-03-05", ownerUserId: w.operator.id });
    const other = await person(w.s, "ivy");
    const W2 = (await call(w.s.app, "POST", "/api/workspaces", other.token, { name: "Other Co" })).body.workspace.id as string;
    const b2 = `/api/workspaces/${W2}`;
    expect((await call(w.s.app, "GET", `${b2}/work-items`, other.token)).body.workItems).toEqual([]);
    expect((await call(w.s.app, "GET", `${b2}/calendar?from=2030-03-01&to=2030-03-31`, other.token)).body.entries).toEqual([]);
    expect((await call(w.s.app, "GET", `${b2}/inbox`, other.token)).body.assignedToYou).toEqual([]);
    expect((await call(w.s.app, "GET", `${b2}/ownerships/campaign/${w.cid}`, other.token)).status).toBe(200); // empty record for an id that is not theirs: nothing is revealed
    expect((await call(w.s.app, "GET", `${b2}/ownerships/campaign/${w.cid}`, other.token)).body).toMatchObject({ ownerUserId: null, reviewerUserId: null });
    const id = (await call(w.s.app, "GET", `${w.base}/work-items`, w.viewer.token)).body.workItems[0].id as string;
    expect((await call(w.s.app, "PATCH", `${b2}/work-items/${id}`, other.token, { status: "done" })).status).toBe(404);
    expect((await call(w.s.app, "PUT", `${b2}/ownerships`, other.token, { subjectType: "campaign", subjectId: w.cid, ownerUserId: other.id })).status).toBe(404);
  });
});
