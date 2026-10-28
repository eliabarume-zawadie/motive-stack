/**
 * Phase 2: where each part of the saved Business Brain came from. Only what the server recorded counts as website-derived; the ledger is reconciled with
 * the saved Brain on every save; the no-website questionnaire's values are the owner's by construction. Local fixture website, no network.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext } from "../src/app/context.js";
import { brainProvenance, reconcileLedger } from "../src/app/provenance.js";
import { approveSafeInsights, brainPatchFor, latestWebsiteAnalysis, recordFillApplied, startWebsiteAnalysis } from "../src/app/websiteAnalysis.js";
import { createWorkspace, getBrain, putBrain } from "../src/app/workspaces.js";
import { buildServer } from "../src/server/app.js";
import type { FetchDeps } from "../src/web/safeFetch.js";
import { BRAIN, makeCore } from "./fixtures.js";

const servers: http.Server[] = [];
afterEach(() => { while (servers.length) servers.pop()?.close(); });

const PAGES: Record<string, string> = {
  "/": `<html><head><title>Roof Pros | Roofing</title></head><body><h1>Roof Pros</h1><a href="/services">Services</a><p>Free roof inspection today.</p><p>Serving Salt Lake County, UT.</p></body></html>`,
  "/services": `<html><head><title>Services</title></head><body><h2>Our services</h2><ul><li>Roof Repair</li><li>Roof Replacement</li></ul></body></html>`,
};
async function setup() {
  const srv = http.createServer((req, res) => { const body = PAGES[req.url ?? ""]; res.writeHead(body ? 200 : 404, { "content-type": req.url === "/robots.txt" ? "text/plain" : "text/html" }); res.end(body ?? "none"); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  const deps: FetchDeps = { resolve: async () => [{ address: "93.184.216.34", family: 4 }], testConnectOverride: { address: "127.0.0.1", port: (srv.address() as AddressInfo).port } };
  const core = makeCore();
  const ctx = buildContext({ db: core.db, now: core.now, env: {}, webFetchDeps: deps, webCrawl: { limits: { timeoutMs: 2000 } } });
  const made = createWorkspace(ctx, "Prov Co");
  return { ctx, ws: made.workspace, token: made.token };
}
async function analyzeAndFill(ctx: ReturnType<typeof buildContext>, wsId: string) {
  const r = startWebsiteAnalysis(ctx, wsId, "http://roofs.example.com", "owner");
  await r.done;
  const a = latestWebsiteAnalysis(ctx, wsId)!;
  approveSafeInsights(ctx, wsId, a.id, "owner");
  const patch = brainPatchFor(ctx, wsId, a.id);
  recordFillApplied(ctx, wsId, a.id, { added: [{ field: "businessName", value: patch.fields.businessName! }, ...patch.services.map((v) => ({ field: "services", value: v }))], removed: [] }, "owner");
  return { a, patch };
}

describe("brainProvenance", () => {
  it("nothing saved yet: nothing is claimed", async () => {
    const { ctx, ws } = await setup();
    expect(brainProvenance(ctx, ws.id)).toMatchObject({ saved: false, version: 0, scalars: [], lists: [], records: [] });
  });

  it("the owner's own entries (including a no-website questionnaire) are labelled as theirs, the default tone as a default, demo text as demo", async () => {
    const { ctx, ws } = await setup();
    putBrain(ctx, ws.id, { ...BRAIN, tone: "friendly and professional", differentiators: ["Real strength", "Licensed and insured (DEMO claim)"], description: "DEMO DATA: not real" });
    const p = brainProvenance(ctx, ws.id);
    const by = (f: string) => p.scalars.find((x) => x.field === f)!;
    expect(by("businessName")).toMatchObject({ source: "owner", value: BRAIN.businessName });
    expect(by("tone")).toMatchObject({ source: "default" });
    expect(by("description")).toMatchObject({ source: "demo" });
    const strengths = p.lists.find((l) => l.field === "differentiators")!.items;
    expect(strengths.map((i) => [i.value, i.source])).toEqual([["Real strength", "owner"], ["Licensed and insured (DEMO claim)", "demo"]]);
    expect(p.counts.website).toBe(0);
  });

  it("values the server recorded from a website are labelled with the site; the owner's own lines beside them are not", async () => {
    const { ctx, ws } = await setup();
    const { patch } = await analyzeAndFill(ctx, ws.id);
    putBrain(ctx, ws.id, { ...BRAIN, businessName: patch.fields.businessName!, services: [...patch.services, "Gutter cleaning"] });
    const p = brainProvenance(ctx, ws.id);
    expect(p.scalars.find((x) => x.field === "businessName")).toMatchObject({ source: "website", site: "roofs.example.com", value: "Roof Pros" });
    const services = p.lists.find((l) => l.field === "services")!.items;
    expect(services.find((i) => i.value === "Roof Repair")).toMatchObject({ source: "website", site: "roofs.example.com" });
    expect(services.find((i) => i.value === "Gutter cleaning")).toMatchObject({ source: "owner" });
    expect(p.scalars.find((x) => x.field === "offer")).toMatchObject({ source: "owner" }); // never filled by a website
  });

  it("text the owner changed after the fill is theirs, and the ledger forgets it when the Brain is saved", async () => {
    const { ctx, ws } = await setup();
    const { patch } = await analyzeAndFill(ctx, ws.id);
    const count = () => (ctx.db.prepare("SELECT COUNT(*) n FROM website_fill_ledger WHERE workspace_id = ?").get(ws.id) as { n: number }).n;
    const before = count();
    expect(before).toBeGreaterThan(1);
    // the owner reworded the name and dropped a service before saving
    putBrain(ctx, ws.id, { ...BRAIN, businessName: "Roof Pros LLC", services: patch.services.slice(1) });
    expect(reconcileLedger(ctx, ws.id)).toBe(2); // the old name and the dropped service
    expect(count()).toBe(before - 2);
    const p = brainProvenance(ctx, ws.id);
    expect(p.scalars.find((x) => x.field === "businessName")).toMatchObject({ source: "owner", value: "Roof Pros LLC" });
  });

  it("a browser cannot keep phantom website entries: values never saved are pruned on save, through the real route", async () => {
    const { ctx, ws, token } = await setup();
    await analyzeAndFill(ctx, ws.id); // the ledger now claims name + services were added to the form
    const app = buildServer(ctx);
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const put = await app.inject({ method: "PUT", url: `/api/workspaces/${ws.id}/brain`, headers: auth, payload: JSON.stringify({ ...BRAIN }) }); // saved WITHOUT any of them
    expect(put.statusCode).toBe(200);
    expect((ctx.db.prepare("SELECT COUNT(*) n FROM website_fill_ledger WHERE workspace_id = ?").get(ws.id) as { n: number }).n).toBe(0);
    const res = await app.inject({ method: "GET", url: `/api/workspaces/${ws.id}/brain/provenance`, headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.counts.website).toBe(0);
    expect(body.saved).toBe(true);
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it("the route needs the workspace's own credentials and shows nothing of another workspace", async () => {
    const { ctx, ws, token } = await setup();
    const other = createWorkspace(ctx, "Other Co");
    putBrain(ctx, other.workspace.id, BRAIN);
    const app = buildServer(ctx);
    const get = (id: string, t?: string) => app.inject({ method: "GET", url: `/api/workspaces/${id}/brain/provenance`, headers: t ? { authorization: `Bearer ${t}` } : {} });
    expect((await get(ws.id)).statusCode).toBe(401);
    expect((await get(ws.id, other.token)).statusCode).toBe(401);
    const mine = await get(ws.id, token);
    expect(mine.json()).toMatchObject({ saved: false });
    expect(getBrain(ctx, ws.id)).toBeNull();
  });
});
