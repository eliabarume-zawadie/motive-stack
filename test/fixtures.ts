import { migrate, openDb } from "../src/db/db.js";
import type { Core } from "../src/app/core.js";
import { MockAiProvider, type MockBehavior } from "../src/ai/mockProvider.js";
import { buildContext } from "../src/app/context.js";
import { generateCampaign } from "../src/app/campaigns.js";
import { createWorkspace, putBrain } from "../src/app/workspaces.js";
import { createWorker } from "../src/app/worker.js";

export const BRAIN = {
  businessName: "Sunrise Plumbing",
  industry: "Home services",
  services: ["Emergency plumbing", "Water heater repair"],
  serviceArea: "Austin, TX",
  targetCustomer: "Homeowners with urgent plumbing problems",
  offer: "Free on-site quote",
  tone: "friendly and professional",
  differentiators: ["24/7 availability", "Licensed and insured"],
  maxDailyBudgetCents: 2000,
};

/** Fresh in-memory database with a controllable clock. */
export function makeCore(start = "2026-10-15T12:00:00Z"): Core & { setNow: (iso: string) => void } {
  const db = openDb(":memory:");
  migrate(db);
  let t = new Date(start).getTime();
  return { db, now: () => new Date(t), setNow: (s: string) => { t = new Date(s).getTime(); } };
}

/** Full app context on an in-memory DB: mock AI, simulated Meta + CRM, instant retries, controllable clock. */
export function makeApp(behavior: MockBehavior = "ok") {
  const core = makeCore();
  const ctx = buildContext({ db: core.db, now: core.now, backoffMs: () => 0, aiProviders: [new MockAiProvider(behavior)] });
  return { ctx, worker: createWorker(ctx), setNow: core.setNow };
}
export type App = ReturnType<typeof makeApp>;

export const GEN = { providerId: "mock", model: "mock-deterministic-1" };

/** A workspace with a saved brain and one generated draft campaign. */
export async function draftCampaign(app: App, name = "A") {
  const { workspace, token } = createWorkspace(app.ctx, name);
  putBrain(app.ctx, workspace.id, BRAIN);
  const campaign = await generateCampaign(app.ctx, workspace.id, GEN);
  return { ws: workspace, token, campaign };
}
