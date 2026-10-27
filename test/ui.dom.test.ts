/**
 * DOM-LEVEL UI TEST (jsdom). This is NOT a real-browser test: no layout, CSS rendering or real event loop timing.
 * It loads the REAL public/index.html, public/app.js and public/ai.js, routes the page's fetch() to the REAL server
 * code via inject() (no network), then drives the screen by filling forms and clicking buttons.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { getBrain, putBrain } from "../src/app/workspaces.js";
import { BRAIN } from "./fixtures.js";

const HTML = readFileSync("public/index.html", "utf8");
// The page is a set of ES modules; the test evaluates them as one script in jsdom, so `export` and `import` lines are removed (names are unique across the files).
const asScript = (f: string) => readFileSync(`public/${f}`, "utf8").replace(/^export /gm, "").replace(/^import .*\n/gm, "");
const AI_JS = [asScript("recovery.js"), asScript("dashboard.js"), asScript("claims.js"), asScript("onboarding.js"), asScript("aitest.js"), asScript("ai.js")].join("\n");
const APP_JS = asScript("app.js");
const FAKE_KEYS = { OPENAI_API_KEY: "sk-FAKE-OPENAI-DOM-TEST", ANTHROPIC_API_KEY: "sk-ant-FAKE-DOM-TEST", META_ACCESS_TOKEN: "EAA-FAKE-META-DOM-TEST" };

const open: Array<() => void> = [];
afterEach(() => { while (open.length) open.pop()?.(); });

function server(env: Record<string, string> = FAKE_KEYS) {
  const db = openDb(":memory:");
  migrate(db);
  const ctx = buildContext({ db, env, backoffMs: () => 0, gateway: { sleep: async () => {} } });
  const app = buildServer(ctx);
  open.push(() => db.open && db.close());
  return { ctx, app, db };
}

/** Open the page against a server. `storage` carries the browser's localStorage between page loads. */
async function openPage(s: ReturnType<typeof server>, storage: Record<string, string> = {}) {
  const dom = new JSDOM(HTML, { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window as unknown as Window & Record<string, any>;
  for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  const requests: string[] = [];
  w.fetch = (async (url: string, init: any = {}) => {
    requests.push(`${init.method ?? "GET"} ${url}`);
    const res = await s.app.inject({ method: init.method ?? "GET", url: String(url), headers: init.headers, payload: init.body });
    return { ok: res.statusCode < 400, status: res.statusCode, json: async () => JSON.parse(res.body || "{}"), text: async () => res.body };
  }) as never;
  w.setInterval = () => 0; // no background polling in tests: refreshes happen on actions
  w.confirm = () => false;
  w.eval(`${AI_JS}\n${APP_JS}`);
  const doc = w.document;
  const $ = (id: string) => doc.getElementById(id) as HTMLElement;
  const submit = (form: HTMLElement) => form.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
  const settle = () => vi.waitFor(() => expect($("ai-mode").textContent?.length ?? 0).toBeGreaterThan(0), { timeout: 3000 });
  await settle();
  return {
    w, doc, $, requests, submit, dom,
    storage: () => Object.fromEntries(Array.from({ length: w.localStorage.length }, (_, i) => [w.localStorage.key(i) as string, w.localStorage.getItem(w.localStorage.key(i) as string) as string])),
    text: () => doc.body.textContent ?? "",
    async createWorkspace(name = "Sunrise Plumbing") {
      (($("ws-create") as HTMLFormElement).elements.namedItem("name") as HTMLInputElement).value = name;
      submit($("ws-create"));
      await vi.waitFor(() => expect(($("ws-select") as HTMLSelectElement).value).toMatch(/^ws_/), { timeout: 3000 });
      await vi.waitFor(() => expect((($("ai-form") as HTMLFormElement).elements.namedItem("primary") as HTMLSelectElement).options.length).toBeGreaterThan(0), { timeout: 3000 });
    },
    async saveBrain() {
      const f = ($("brain-form") as HTMLFormElement).elements as any;
      f.businessName.value = BRAIN.businessName; f.industry.value = BRAIN.industry; f.services.value = BRAIN.services.join("\n");
      f.serviceArea.value = BRAIN.serviceArea; f.targetCustomer.value = BRAIN.targetCustomer; f.offer.value = BRAIN.offer;
      f.differentiators.value = BRAIN.differentiators.join("\n"); f.maxDailyBudgetCents.value = String(BRAIN.maxDailyBudgetCents);
      submit($("brain-form"));
      await vi.waitFor(() => expect($("brain-version").textContent).toMatch(/version 1/), { timeout: 3000 });
    },
  };
}

describe("AI settings screen, mock mode (DOM-level)", () => {
  it("identifies mock mode clearly, in both banners", async () => {
    const ui = await openPage(server());
    expect($text(ui, "banner")).toMatch(/MOCK MODE.*all simulated/i);
    expect($text(ui, "banner")).toMatch(/NOT real advertising performance/);
    expect($text(ui, "ai-mode")).toMatch(/MOCK mode.*simulated.*no provider is contacted/i);
    expect($text(ui, "ai-mode")).not.toMatch(/LIVE/);
  });

  it("shows the models, with real ones unavailable and a useful reason", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    const table = $text(ui, "ai-models");
    expect(table).toMatch(/Mock \(deterministic, offline\)\s*SIMULATED/);
    for (const label of ["OpenAI GPT-6 Luna", "OpenAI GPT-5.5", "Anthropic Claude Haiku 5.5", "Anthropic Claude Sonnet 5.5", "Anthropic Claude Opus 5.5"]) expect(table).toContain(label);
    expect(table).toMatch(/unavailable\s*live providers are disabled in mock mode/);
    expect(table).toMatch(/no \(cost shown as unknown\)|yes/);
    // the model dropdowns mark unusable options disabled and say why
    const opts = Array.from((ui.$("ai-form") as HTMLFormElement).querySelectorAll("select[name=primary] option")) as HTMLOptionElement[];
    const gpt = opts.find((o) => o.textContent?.includes("GPT-6 Luna"));
    expect(gpt?.disabled).toBe(true);
    expect(gpt?.textContent).toMatch(/unavailable: live providers are disabled in mock mode/);
    expect(opts.find((o) => o.textContent?.includes("Mock"))?.disabled).toBe(false);
  });

  it("the generate dropdown offers only usable models and defaults to the workspace settings", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    const sel = ui.$("gen-model") as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(["Use workspace AI settings", "Mock (deterministic, offline)"]);
    expect(sel.value).toBe("");
  });

  it("the connection test is labelled simulated, and never reports a real connection", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    expect(ui.$("ai-test-btn").textContent).toBe("Run simulated test (no real connection)");
    const before = ui.requests.length;
    ui.$("ai-test-btn").click();
    await vi.waitFor(() => expect($text(ui, "ai-test-result")).toMatch(/^SIMULATED:/), { timeout: 3000 });
    const out = $text(ui, "ai-test-result");
    expect(out).toMatch(/nothing was verified/i);
    expect(out).not.toMatch(/connected|real request succeeded/i);
    expect(ui.requests.slice(before).some((r) => r.includes("/ai/connection-test"))).toBe(true);
  });

  it("model selection and routing preferences persist across a page reload", async () => {
    const s = server();
    const ui = await openPage(s);
    await ui.createWorkspace();
    const f = (ui.$("ai-form") as HTMLFormElement).elements as any;
    f.routingMode.value = "manual";
    f.routingMode.dispatchEvent(new ui.w.Event("change"));
    expect(ui.$("ai-primary-wrap").hidden).toBe(false);
    expect(ui.$("ai-fallback-wrap").hidden).toBe(true);
    f.primary.value = "mock|mock-deterministic-1";
    f.maxRequestsPerDay.value = "7";
    f.monthlyBudget.value = "1.50";
    ui.submit(ui.$("ai-form"));
    await vi.waitFor(() => expect(ui.$("ai-saved").textContent).toBe("Saved"), { timeout: 3000 });

    const again = await openPage(s, ui.storage()); // a fresh page load with the same browser storage
    await vi.waitFor(() => expect(((again.$("ai-form") as HTMLFormElement).elements as any).routingMode.value).toBe("manual"), { timeout: 3000 });
    const g = (again.$("ai-form") as HTMLFormElement).elements as any;
    expect(g.primary.value).toBe("mock|mock-deterministic-1");
    expect(g.maxRequestsPerDay.value).toBe("7");
    expect(g.monthlyBudget.value).toBe("1.5");
    expect(again.$("ai-primary-wrap").hidden).toBe(false);
  });

  it("surfaces a server-side validation failure instead of silently saving", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    const f = (ui.$("ai-form") as HTMLFormElement).elements as any;
    f.routingMode.value = "preferred_with_fallback";
    f.primary.value = "mock|mock-deterministic-1";
    f.fallback.value = "mock|mock-deterministic-1"; // same as the preferred model: the server must refuse
    ui.submit(ui.$("ai-form"));
    await vi.waitFor(() => expect($text(ui, "errors")).toMatch(/must differ/), { timeout: 3000 });
    expect(ui.$("ai-saved").textContent).toBe("");
  });
});

describe("usage display (DOM-level)", () => {
  it("generating a campaign shows a simulated usage row and a campaign, with cost 'n/a (simulated)'", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    await ui.saveBrain();
    ui.submit(ui.$("gen-form"));
    await vi.waitFor(() => expect($text(ui, "campaign-view")).toMatch(/Sunrise Plumbing - Emergency plumbing Leads/), { timeout: 3000 });
    await vi.waitFor(() => expect($text(ui, "ai-usage")).toMatch(/campaign_brief/), { timeout: 3000 });
    const usage = $text(ui, "ai-usage");
    expect(usage).toMatch(/SIMULATED/);
    expect(usage).toMatch(/n\/a \(simulated\)/);
    expect(usage).toMatch(/\(simulated\)/); // token counts are marked simulated
    expect(usage).toMatch(/mock\/mock-deterministic-1/);
    expect($text(ui, "campaign-view")).toMatch(/rationale/i);
    // explicit unknowns from the model are shown to the owner, not hidden
    expect(ui.text()).not.toMatch(/undefined|NaN|\[object Object\]/);
  });

  it("unknown tokens and unknown cost render as 'unknown', never as 0", async () => {
    const s = server();
    const ui = await openPage(s);
    await ui.createWorkspace();
    const wsId = (ui.$("ws-select") as HTMLSelectElement).value;
    const at = new Date().toISOString();
    // A real (non-simulated) request whose provider reported no usage and has no configured price.
    s.db.prepare(
      `INSERT INTO ai_usage (id, workspace_id, task_id, task_type, provider, model, mode, simulated, attempt_no, attempt_kind, outcome, started_at, latency_ms,
         input_tokens, output_tokens, usage_source, estimated_cost_micros, currency, cost_status, request_id)
       VALUES ('u1', ?, 't1', 'campaign_brief', 'openai', 'gpt-x', 'live', 0, 1, 'initial', 'ok', ?, 321, NULL, NULL, NULL, NULL, 'USD', 'unknown_no_pricing', 'req_1')`,
    ).run(wsId, at);
    // and one where tokens ARE known but the price is not
    s.db.prepare(
      `INSERT INTO ai_usage (id, workspace_id, task_id, task_type, provider, model, mode, simulated, attempt_no, attempt_kind, outcome, started_at, latency_ms,
         input_tokens, output_tokens, usage_source, estimated_cost_micros, currency, cost_status, request_id)
       VALUES ('u2', ?, 't2', 'campaign_brief', 'openai', 'gpt-y', 'live', 0, 1, 'initial', 'ok', ?, 100, 120, 30, 'provider', NULL, 'USD', 'unknown_no_pricing', 'req_2')`,
    ).run(wsId, new Date(Date.now() + 1000).toISOString());
    ui.$("ai-test-btn").click(); // any action triggers a reload of usage
    await vi.waitFor(() => expect($text(ui, "ai-usage")).toMatch(/gpt-x/), { timeout: 3000 });
    const usage = $text(ui, "ai-usage");
    expect(usage).toMatch(/gpt-x[\s\S]*?unknown[\s\S]*?unknown \(unknown no pricing\)/); // unknown tokens, unknown cost with the reason
    expect(usage).toMatch(/gpt-y[\s\S]*?120 in \/ 30 out[\s\S]*?unknown \(unknown no pricing\)/); // known tokens, unknown cost
    // regression: an all-unknown month used to read "0.0000 USD plus 2 requests with unknown cost", i.e. like zero spend
    expect(usage).toMatch(/This month, live spend: unknown \(2 live request\(s\) have no priced cost yet\)/);
    expect(usage).not.toMatch(/0\.0000 USD|0\.00 USD|0 in \/ 0 out/); // unknown is never displayed as zero
  });
});

describe("secrets and the browser (DOM-level)", () => {
  it("no credential appears in the page, its scripts, its storage, or any API response it received", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    await ui.saveBrain();
    ui.submit(ui.$("gen-form"));
    await vi.waitFor(() => expect($text(ui, "campaign-view")).toMatch(/Leads/), { timeout: 3000 });
    const surfaces = [ui.dom.serialize(), JSON.stringify(ui.storage()), AI_JS, APP_JS, HTML, ui.requests.join("\n")].join("\n");
    for (const secret of Object.values(FAKE_KEYS)) expect(surfaces).not.toContain(secret);
    expect(surfaces).not.toMatch(/sk-ant-|sk-FAKE|EAA-FAKE|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
    // the only credential the browser holds is this workspace's own token
    expect(Object.keys(ui.storage()).sort()).toEqual(["ms_by", "ms_current", "ms_sessions"].filter((k) => k in ui.storage()).sort());
  });
});

describe("empty request bodies from the UI (DOM-level)", () => {
  it("'Use workspace AI settings' sends an empty options object and generation succeeds", async () => {
    const s = server();
    const ui = await openPage(s);
    await ui.createWorkspace();
    await ui.saveBrain();
    let seenBody: string | undefined;
    const orig = ui.w.fetch;
    ui.w.fetch = ((url: string, init: any) => { if (String(url).endsWith("/campaigns/generate")) seenBody = init?.body; return orig(url, init); }) as never;
    ui.submit(ui.$("gen-form"));
    await vi.waitFor(() => expect($text(ui, "campaign-view")).toMatch(/Leads/), { timeout: 3000 });
    expect(seenBody).toBe("{}");
  });
});

function $text(ui: { $: (id: string) => HTMLElement }, id: string): string {
  return (ui.$(id).textContent ?? "").replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ local mode (Ollama) */
import { AnthropicProvider } from "../src/ai/anthropicProvider.js";
import { MockAiProvider } from "../src/ai/mockProvider.js";
import { OllamaProvider } from "../src/ai/ollamaProvider.js";
import { OpenAIProvider } from "../src/ai/openaiProvider.js";
import { ModelRegistry } from "../src/ai/registry.js";
import { BRIEF_OK } from "./briefFixture.js";

function localServer(opts: { gate?: Promise<void>; replies?: number } = {}) {
  const db = openDb(":memory:");
  migrate(db);
  const registry = ModelRegistry.fromFile("config/ai-models.json");
  const ok = () => new Response(JSON.stringify({
    id: "resp_1", object: "response", status: "completed", model: "llama3.1:latest",
    output: [{ type: "message", role: "assistant", id: "m", status: "completed", content: [{ type: "output_text", text: JSON.stringify(BRIEF_OK), annotations: [] }] }],
    usage: { input_tokens: 120, output_tokens: 90, total_tokens: 210 },
  }), { status: 200, headers: { "content-type": "application/json" } });
  const fake = (async () => { if (opts.gate) await opts.gate; return ok(); }) as unknown as typeof fetch;
  const ctx = buildContext({
    db, env: { AI_PROVIDER_MODE: "local", ...FAKE_KEYS }, registry, backoffMs: () => 0, gateway: { sleep: async () => {}, repairAttempts: 0 },
    // the full provider set, as in the real app: only Ollama is eligible in local mode, the rest must say why not
    aiProviders: [
      new MockAiProvider(),
      new OpenAIProvider({ models: registry.modelsFor("openai") }),
      new AnthropicProvider({ models: registry.modelsFor("anthropic") }),
      new OllamaProvider({ models: registry.modelsFor("ollama"), enabled: true, fetch: fake }),
    ],
  });
  const app = buildServer(ctx);
  open.push(() => db.open && db.close());
  return { ctx, app, db };
}

describe("AI settings screen, LOCAL mode (DOM-level)", () => {
  it("says plainly that a local model answers: real output, no charge, nothing leaves the machine", async () => {
    const ui = await openPage(localServer());
    expect($text(ui, "banner")).toMatch(/AI: LOCAL model on this machine/);
    expect($text(ui, "banner")).toMatch(/nothing leaves this computer/);
    expect($text(ui, "banner")).not.toMatch(/MOCK MODE/);
    expect($text(ui, "ai-mode")).toMatch(/LOCAL mode.*Ollama.*no charge.*nothing leaves this machine/i);
    expect($text(ui, "ai-mode")).toMatch(/validated/);
    expect(ui.$("ai-test-btn").textContent).toMatch(/Test local model.*free/);
  });

  it("offers only the local model, and explains why the others are unavailable", async () => {
    const ui = await openPage(localServer());
    await ui.createWorkspace();
    const table = $text(ui, "ai-models");
    expect(table).toMatch(/Ollama llama3\.1 8B \(local\)[\s\S]*no charge \(runs locally\)[\s\S]*usable/);
    expect(table).toMatch(/simulated providers are disabled in local mode/);
    expect(table).toMatch(/live providers are disabled in local mode/);
    const sel = ui.$("gen-model") as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(["Use workspace AI settings", "Ollama llama3.1 8B (local)"]);
  });

  it("the connection test is a real request here, and says so without calling it simulated or billed", async () => {
    const ui = await openPage(localServer());
    await ui.createWorkspace();
    ui.$("ai-test-btn").click();
    await vi.waitFor(() => expect($text(ui, "ai-test-result")).toMatch(/^Connected to the local model server \(real request\)/), { timeout: 3000 });
    expect($text(ui, "ai-test-result")).not.toMatch(/SIMULATED|billed/i);
  });

  it("shows a slow-model hint while generating, disables the button, then shows a LOCAL usage row with no charge", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ui = await openPage(localServer({ gate }));
    await ui.createWorkspace();
    await ui.saveBrain();
    const btn = (ui.$("gen-form") as HTMLFormElement).querySelector("button[type=submit]") as HTMLButtonElement;
    ui.submit(ui.$("gen-form"));
    await vi.waitFor(() => expect($text(ui, "gen-status")).toMatch(/local model.*few minutes.*keep this page open/i), { timeout: 3000 });
    expect(btn.disabled).toBe(true);
    release();
    await vi.waitFor(() => expect($text(ui, "campaign-view")).toMatch(/Leads/), { timeout: 3000 });
    expect($text(ui, "gen-status")).toBe("");
    expect(btn.disabled).toBe(false);
    await vi.waitFor(() => expect($text(ui, "ai-usage")).toMatch(/campaign_brief/), { timeout: 3000 });
    const usage = $text(ui, "ai-usage");
    expect(usage).toMatch(/LOCAL/);
    expect(usage).toMatch(/no charge \(local\)/);
    expect(usage).toMatch(/120 in \/ 90 out/);
    expect(usage).not.toMatch(/SIMULATED|\(simulated\)|unknown/);
    expect(usage).toMatch(/1 local \(no charge\)/);
  });

  it("no credential reaches the page in local mode either", async () => {
    const ui = await openPage(localServer());
    await ui.createWorkspace();
    await ui.saveBrain();
    ui.submit(ui.$("gen-form"));
    await vi.waitFor(() => expect($text(ui, "campaign-view")).toMatch(/Leads/), { timeout: 3000 });
    const surfaces = [ui.dom.serialize(), JSON.stringify(ui.storage()), ui.requests.join("\n")].join("\n");
    for (const secret of Object.values(FAKE_KEYS)) expect(surfaces).not.toContain(secret);
  });
});

/* ------------------------------------------------------------- campaign quality sections (Milestone 3) */
describe("campaign view shows budget, targeting, decisions, questions and platform checks (DOM-level)", () => {
  /** Create the workspace through the UI, then set the brain through the same API the page uses. */
  async function withBrain(ui: Awaited<ReturnType<typeof openPage>>, brain: object) {
    await ui.createWorkspace();
    const s = JSON.parse(ui.storage().ms_sessions as string)[0] as { id: string; token: string };
    const r = await ui.w.fetch(`/api/workspaces/${s.id}/brain`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` }, body: JSON.stringify(brain) });
    expect(r.ok).toBe(true);
    ui.submit(ui.$("gen-form"));
    await vi.waitFor(() => expect($text(ui, "campaign-view")).toMatch(/Budget/), { timeout: 4000 });
  }

  it("separates the proposed starting budget from the ceiling and explains the budget", async () => {
    const ui = await openPage(server());
    await withBrain(ui, BRAIN);
    const v = $text(ui, "campaign-view");
    expect(v).toMatch(/Proposed starting budget\s*\$8\.00 per day/);
    expect(v).toMatch(/Your ceiling\s*\$20\.00 per day\. A hard limit, never a target\./);
    expect(v).toMatch(/Why this budget\s*A test budget of \$8\.00 per day, below the owner's ceiling/);
  });

  it("shows the targeting recommendation with its basis, uncertainty and what the platform can apply", async () => {
    const ui = await openPage(server());
    await withBrain(ui, BRAIN);
    const v = $text(ui, "campaign-view");
    expect(v).toMatch(/Targeting recommendation/);
    expect(v).toMatch(/Approach\s*Broad local targeting/);
    expect(v).toMatch(/How it connects to the service/);
    expect(v).toMatch(/Basis\s*general best practice/);
    expect(v).toMatch(/Evidence supplied\s*None supplied by the owner/);
    expect(v).toMatch(/What is not known\s*No audience or past performance data was supplied/);
    expect(v).toMatch(/Settings the platform can apply\s*Austin, TX, ages 18-65; no interest targeting/);
    expect(v).toMatch(/Applicable settings are: location names/);
  });

  it("shows each approved differentiator as used or held back, and how the variations differ", async () => {
    const ui = await openPage(server());
    await withBrain(ui, BRAIN);
    const v = $text(ui, "campaign-view");
    expect(v).toMatch(/used\s*24\/7 availability/);
    expect(v).toMatch(/used\s*Licensed and insured/);
    expect(v).toMatch(/Urgent need: Leads with the customer's problem/);
    expect(v).toMatch(/Trust in the provider: Leads with the approved differentiators/);
  });

  it("shows only material open questions, each with why it matters; BLOCKS LAUNCH is marked when set", async () => {
    const ui = await openPage(server());
    await withBrain(ui, { ...BRAIN, unverifiedClaims: ["Voted #1 in Austin"] });
    const v = $text(ui, "campaign-view");
    expect(v).toMatch(/question\s*Can you provide proof for the claim "Voted #1 in Austin"\?/);
    expect(v).toMatch(/Why it matters: Unverified claims stay out of the ads/);
    expect(v).not.toMatch(/Voted #1 in Austin[^?]*\b(headline|text)\b/i); // never used in the copy
    expect(v).not.toMatch(/average age|market research/i);
  });

  it("with nothing material missing it says so plainly instead of inventing questions", async () => {
    const ui = await openPage(server());
    await withBrain(ui, BRAIN);
    expect($text(ui, "campaign-view")).toMatch(/No open questions: nothing material was missing/);
  });

  it("shows computed Meta platform checks, all passing for a compliant brief", async () => {
    const ui = await openPage(server());
    await withBrain(ui, BRAIN);
    const v = $text(ui, "campaign-view");
    for (const label of ["Objective is supported", "Headlines within 40 characters", "Primary texts within 125 characters", "Starting budget is within the owner's ceiling", "Starting budget is not simply the ceiling", "Ad copy makes only approved claims", "No special ad category involved"]) {
      expect(v).toContain(`pass ${label}`); // plain substring: no regex escaping needed
    }
    expect(v).not.toMatch(/\bfail\b/);
  });

  it("a flagged proposal shows its review reasons and cannot be approved until the reviewer acknowledges them", async () => {
    const ui = await openPage(server());
    // a $1/day ceiling: the starting budget can only equal it, so the brief carries a review flag
    await withBrain(ui, { ...BRAIN, maxDailyBudgetCents: 100 });
    expect($text(ui, "campaign-view")).toMatch(/Needs review\s*review\s*The owner's ceiling \(\$1\.00 per day\) is the smallest workable start/);
    const propose = Array.from(ui.$("proposal-view").querySelectorAll("button")).find((b) => /Propose/.test(b.textContent ?? "")) as HTMLButtonElement;
    propose.click();
    await vi.waitFor(() => expect($text(ui, "proposal-view")).toMatch(/NEEDS REVIEW/), { timeout: 4000 });
    expect($text(ui, "proposal-view")).toMatch(/I read the review reasons above/);

    (ui.$("proposal-view").querySelector("input[placeholder='Your name']") as HTMLInputElement).value = "Elia";
    const approve = Array.from(ui.$("proposal-view").querySelectorAll("button")).find((b) => b.textContent === "Approve") as HTMLButtonElement;
    const activityLoads = () => ui.requests.filter((r) => r.endsWith("/activity")).length;
    const before = activityLoads();
    approve.click(); // without ticking the acknowledgement
    await vi.waitFor(() => expect($text(ui, "errors")).toMatch(/needs review before approval/), { timeout: 4000 });
    expect($text(ui, "proposal-view")).toMatch(/proposed/); // still pending: nothing was approved
    await vi.waitFor(() => expect(activityLoads()).toBeGreaterThan(before), { timeout: 4000 }); // the screen redraws after a refused decision: tick the box on the redrawn card

    (ui.$("proposal-view").querySelector("input[type=checkbox]") as HTMLInputElement).checked = true;
    (Array.from(ui.$("proposal-view").querySelectorAll("button")).find((b) => b.textContent === "Approve") as HTMLButtonElement).click();
    await vi.waitFor(() => expect($text(ui, "proposal-view")).toMatch(/approved|executed|executing/), { timeout: 4000 });
  });
});

describe("provenance records survive saving the Business Brain form (DOM-level)", () => {
  it("fact records the form cannot edit are kept when the owner saves it", async () => {
    const s = server();
    const ui = await openPage(s);
    await ui.createWorkspace();
    await ui.saveBrain();
    const wsId = ui.storage().ms_current as string;
    const facts = [{ text: "Family-run", status: "owner_approved", source: "owner_form", approvedForMarketing: true, approvedAt: "2026-10-01", approvedBy: "owner", evidence: [] },
      { text: "Licensed and bonded", status: "owner_provided", source: "owner_form", approvedForMarketing: false, evidence: [] }];
    putBrain(s.ctx, wsId, { ...BRAIN, facts });
    const again = await openPage(s, ui.storage());
    await vi.waitFor(() => expect(((again.$("brain-form") as HTMLFormElement).elements as any).businessName.value).toBe(BRAIN.businessName), { timeout: 3000 });
    again.submit(again.$("brain-form"));
    await vi.waitFor(() => expect(getBrain(s.ctx, wsId)?.version).toBe(3), { timeout: 3000 });
    expect(getBrain(s.ctx, wsId)?.brain.facts.map((f) => [f.text, f.status, f.approvedForMarketing])).toEqual([["Family-run", "owner_approved", true], ["Licensed and bonded", "owner_provided", false]]);
  });
});
