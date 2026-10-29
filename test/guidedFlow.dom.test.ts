/**
 * DOM-LEVEL TEST (jsdom, not a real browser) of the guided flow: "Does your business have a website?", the website analysis and its review,
 * the questionnaire for a business with no website, the five-step path, and the developer-mode AI test. The page's fetch() goes to the REAL
 * server code through inject(); the "website" is a real local HTTP server reached through the same address checks as production.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContext } from "../src/app/context.js";
import { approveSafeInsights, brainPatchFor, latestWebsiteAnalysis, recordFillApplied, startWebsiteAnalysis } from "../src/app/websiteAnalysis.js";
import { createWorkspace, getBrain, putBrain } from "../src/app/workspaces.js";
import { generateCampaign, updateBrief } from "../src/app/campaigns.js";
import { createProposal } from "../src/app/proposals.js";
import { BRAIN } from "./fixtures.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import type { FetchDeps } from "../src/web/safeFetch.js";
import { createWorker } from "../src/app/worker.js";
import { decideProposal, requestExecution } from "../src/app/proposals.js";

const HTML = readFileSync("public/index.html", "utf8");
const asScript = (f: string) => readFileSync(`public/${f}`, "utf8").replace(/^export /gm, "").replace(/^import .*\n/gm, "");
const SCRIPT = [asScript("recovery.js"), asScript("dashboard.js"), asScript("activity.js"), asScript("claims.js"), asScript("onboarding.js"), asScript("provenance.js"), asScript("goal.js"), asScript("leads.js"), asScript("workspace.js"), asScript("brand.js"), asScript("plans.js"), asScript("creative.js"), asScript("team.js"), asScript("intake.js"), asScript("results.js"), asScript("learning.js"), asScript("integrations.js"), asScript("privacy.js"), asScript("aitest.js"), asScript("ai.js"), asScript("app.js")].join("\n");

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()?.(); });

const SITE: Record<string, string> = {
  "/": `<html><head><title>Lone Star Cooling | Round Rock HVAC</title><meta name="description" content="Air conditioning repair in Round Rock."></head><body><h1>Lone Star Cooling</h1><p>We serve Round Rock, TX.</p><a href="/services">Services</a><p>Call today for a free estimate.</p></body></html>`,
  "/services": `<html><head><title>Services</title></head><body><h2>Our services</h2><ul><li>AC repair</li><li>Furnace repair</li></ul><p>24/7 emergency service available.</p></body></html>`,
};

async function fakeSite(address = "93.184.216.34") {
  const srv = http.createServer((req, res) => {
    const body = SITE[req.url ?? ""];
    res.writeHead(body ? 200 : 404, { "content-type": req.url === "/robots.txt" ? "text/plain" : "text/html" });
    res.end(body ?? "none");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  cleanup.push(() => srv.close());
  const port = (srv.address() as AddressInfo).port;
  const deps: FetchDeps = { resolve: async () => [{ address, family: 4 }], testConnectOverride: { address: "127.0.0.1", port } };
  return deps;
}

/** Several websites on one local server, told apart by the Host header (the address checks still run as in production). */
async function multiSite(sites: Record<string, Record<string, string>>) {
  const srv = http.createServer((req, res) => {
    const host = String(req.headers.host ?? "").split(":")[0] as string;
    const body = sites[host]?.[req.url ?? ""];
    res.writeHead(body ? 200 : 404, { "content-type": req.url === "/robots.txt" ? "text/plain" : "text/html" });
    res.end(body ?? "none");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  cleanup.push(() => srv.close());
  const port = (srv.address() as AddressInfo).port;
  const deps: FetchDeps = { resolve: async () => [{ address: "93.184.216.34", family: 4 }], testConnectOverride: { address: "127.0.0.1", port } };
  return deps;
}

function server(deps?: FetchDeps, env: Record<string, string> = {}, now?: () => Date) {
  const db = openDb(":memory:");
  migrate(db);
  const ctx = buildContext({ db, env, now, backoffMs: () => 0, gateway: { sleep: async () => {} }, webFetchDeps: deps, webCrawl: { limits: { timeoutMs: 2000 } } });
  const app = buildServer(ctx);
  cleanup.push(() => { if (db.open) db.close(); });
  return { ctx, app, db };
}

async function openPage(s: ReturnType<typeof server>) {
  const dom = new JSDOM(HTML, { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window as unknown as Window & Record<string, any>;
  const requests: string[] = [];
  w.fetch = (async (url: string, init: any = {}) => {
    requests.push(`${init.method ?? "GET"} ${url}`);
    const res = await s.app.inject({ method: init.method ?? "GET", url: String(url), headers: init.headers, payload: init.body });
    return { ok: res.statusCode < 400, status: res.statusCode, json: async () => JSON.parse(res.body || "{}"), text: async () => res.body };
  }) as never;
  w.setInterval = () => 0;
  w.confirm = () => false;
  w.eval(SCRIPT);
  const doc = w.document;
  const $ = (id: string) => doc.getElementById(id) as HTMLElement;
  const text = (id: string) => $(id).textContent ?? "";
  const submit = (form: HTMLElement) => form.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
  const click = (el: Element | null | undefined) => (el as HTMLElement).click();
  const buttonIn = (id: string, label: string) => Array.from($(id).querySelectorAll("button")).find((b) => b.textContent === label) as HTMLButtonElement | undefined;
  await vi.waitFor(() => expect(text("ai-mode").length).toBeGreaterThan(0), { timeout: 3000 });
  const ui = {
    w, doc, $, text, submit, click, buttonIn, requests,
    async createWorkspace(name = "Lone Star Cooling") {
      (($("ws-create") as HTMLFormElement).elements.namedItem("name") as HTMLInputElement).value = name;
      submit($("ws-create"));
      await vi.waitFor(() => expect(($("ws-select") as HTMLSelectElement).value).toMatch(/^ws_/), { timeout: 3000 });
      await vi.waitFor(() => expect(text("dash-view")).toMatch(/Campaigns/), { timeout: 3000 });
    },
    async analyze(url: string) {
      ui.click($("site-has-yes")); $("site-has-yes").dispatchEvent(new w.Event("change", { bubbles: true }));
      ($("site-url") as HTMLInputElement).value = url;
      submit($("site-form"));
    },
  };
  return ui;
}
type UI = Awaited<ReturnType<typeof openPage>>;
const ready = (ui: UI) => vi.waitFor(() => expect(ui.$("site-results").hidden).toBe(false), { timeout: 4000 });
const form = (ui: UI) => (ui.$("brain-form") as HTMLFormElement).elements as any;

describe("the guided business flow (DOM-level)", () => {
  it("starts with the website question, shows nothing else until answered, and explains what will be inspected", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    expect(ui.text("s-brain")).toMatch(/Does your business have a website\?/);
    expect(ui.$("site-yes").hidden).toBe(true);
    expect(ui.$("site-no").hidden).toBe(true);
    ui.$("site-has-yes").dispatchEvent(new ui.w.Event("change", { bubbles: true }));
    expect(ui.$("site-yes").hidden).toBe(false);
    expect(ui.text("site-yes")).toMatch(/What will MotiveStack look at\?/);
    expect(ui.text("site-yes")).toMatch(/robots\.txt/);
    expect(ui.text("site-yes")).toMatch(/Nothing you approve is saved to your Business Brain until you press Save/);
    expect(ui.$("brain-details").hasAttribute("open")).toBe(false); // the long form is not shown up front
  });

  it("asks for an address, and shows the server's plain refusal for an unsafe one (nothing is fetched)", async () => {
    const ui = await openPage(server(await fakeSite()));
    await ui.createWorkspace();
    await ui.analyze("");
    expect(ui.text("site-msg")).toMatch(/Type your website address first/);
    for (const bad of ["http://localhost:3000", "http://169.254.169.254/", "file:///etc/passwd"]) {
      await ui.analyze(bad);
      await vi.waitFor(() => expect(ui.$("site-msg").hidden).toBe(false), { timeout: 3000 });
      await vi.waitFor(() => expect(ui.text("site-msg")).not.toMatch(/Failed|undefined/), { timeout: 3000 });
      expect(ui.$("site-results").hidden).toBe(true);
    }
    expect(ui.requests.filter((r) => r.startsWith("POST") && r.includes("website-analyses"))).toHaveLength(3);
  });

  it("analyzes a website in mock mode, shows evidence-linked findings, and copies only approved ones into the form without saving", async () => {
    const s = server(await fakeSite());
    const ui = await openPage(s);
    await ui.createWorkspace();
    await ui.analyze("http://shop.example.com");
    await ready(ui);
    const results = ui.text("site-results");
    expect(results).toMatch(/Simulated analysis/);
    expect(results).toMatch(/No AI was used and nothing was charged/);
    expect(results).toMatch(/Found on your website/);
    expect(results).toMatch(/Questions only you can answer/);
    expect(results).toMatch(/“AC repair”/); // the quote that was found
    expect(ui.$("site-results").querySelector("a[href^='http']")?.getAttribute("rel")).toBe("noopener noreferrer");

    // nothing is in the form or saved yet
    expect(form(ui).services.value).toBe("");
    expect(ui.$("demo-row").hidden).toBe(true); // fictional demo data is not offered next to the owner's real findings
    // reject one service finding; the button approves what is clearly stated and copies it
    const card = Array.from(ui.$("site-results").querySelectorAll("li.finding")).find((li) => li.textContent?.includes("Furnace repair"))!;
    ui.click(Array.from(card.querySelectorAll("button")).find((b) => b.textContent === "No, leave it out"));
    await vi.waitFor(() => expect(ui.text("site-results")).toMatch(/Not used/), { timeout: 3000 });
    ui.click(ui.$("site-use"));
    await vi.waitFor(() => expect(form(ui).services.value).toContain("AC repair"), { timeout: 3000 });
    expect(form(ui).businessName.value).toBe("Lone Star Cooling"); // the findings appear in the form without any manual approving
    expect(form(ui).services.value).not.toContain("Furnace repair"); // rejected: not copied
    expect(form(ui).unverifiedClaims.value).toBe(""); // claims were not approved, so they are not copied
    expect(ui.$("brain-details").hasAttribute("open")).toBe(true);
    expect(ui.text("notice")).toMatch(/Still needed before you can save/);
    expect(ui.requests.some((r) => r.startsWith("PUT") && r.endsWith("/brain"))).toBe(false); // nothing was saved
  });

  it("puts each finding in its own field in short form, says where everything went, and refreshes its own earlier fill", async () => {
    const ui = await openPage(server(await fakeSite()));
    await ui.createWorkspace();
    await ui.analyze("http://shop.example.com");
    await ready(ui);
    ui.click(ui.$("site-use"));
    await vi.waitFor(() => expect(ui.$("site-fill-summary").hidden).toBe(false), { timeout: 3000 });
    expect(form(ui).businessName.value).toBe("Lone Star Cooling");
    expect(form(ui).serviceArea.value).toBe("Round Rock, TX"); // places, not the sentences around them
    expect(form(ui).offer.value).toBe("Free estimate"); // the offer, not "Call today for a free estimate."
    expect(form(ui).services.value.split("\n")).toEqual(expect.arrayContaining(["AC repair", "Furnace repair"]));
    const summary = ui.text("site-fill-summary");
    expect(summary).toMatch(/What went into your Business Brain form/);
    expect(summary).toMatch(/Service area: Round Rock, TX/);
    expect(summary).toMatch(/Not found on your site, please fill in: .*who you serve/);
    // a second press refreshes what the first one wrote, and keeps what the owner typed since
    form(ui).offer.value = "My own offer";
    form(ui).serviceArea.value = "Round Rock, TX"; // untouched by the owner: still the earlier fill
    ui.click(ui.$("site-use"));
    await vi.waitFor(() => expect(ui.text("site-fill-summary")).toMatch(/Left as you wrote it: Offer/), { timeout: 3000 });
    expect(form(ui).offer.value).toBe("My own offer");
  });

  it("replaces demo data (and only demo data) with the real findings, in every field", async () => {
    const ui = await openPage(server(await fakeSite()));
    await ui.createWorkspace();
    ui.click(ui.$("brain-demo")); // the fictional business fills the form
    expect(form(ui).businessName.value).toMatch(/\(DEMO\)/);
    form(ui).targetCustomer.value = "My own customers"; // typed by the owner after the demo: must survive
    await ui.analyze("http://shop.example.com");
    await ready(ui);
    ui.click(ui.$("site-use"));
    await vi.waitFor(() => expect(ui.$("site-fill-summary").hidden).toBe(false), { timeout: 3000 });
    expect(form(ui).businessName.value).toBe("Lone Star Cooling");
    expect(form(ui).serviceArea.value).toBe("Round Rock, TX");
    expect(form(ui).tone.value).not.toMatch(/plain-spoken/); // the demo's tone is gone
    expect(form(ui).targetCustomer.value).toBe("My own customers");
    for (const k of ["services", "differentiators", "verifiedFacts", "unverifiedClaims", "prohibitedClaims", "description"]) expect(form(ui)[k].value, k).not.toMatch(/DEMO|Lowest prices|Guaranteed lowest/);
    expect(ui.text("site-fill-summary")).toMatch(/Demo data was replaced by your real findings in/);
  });

  it("never overwrites what the owner already wrote when applying findings", async () => {
    const ui = await openPage(server(await fakeSite()));
    await ui.createWorkspace();
    form(ui).serviceArea.value = "My own service area";
    await ui.analyze("http://shop.example.com");
    await ready(ui);
    ui.click(ui.$("site-approve-safe"));
    ui.click(ui.$("site-use"));
    await vi.waitFor(() => expect(ui.$("brain-details").hasAttribute("open")).toBe(true), { timeout: 3000 });
    expect(form(ui).serviceArea.value).toBe("My own service area");
    expect(form(ui).businessName.value).toBe("Lone Star Cooling");
  });

  it("lets the owner edit a finding in their own words", async () => {
    const ui = await openPage(server(await fakeSite()));
    await ui.createWorkspace();
    await ui.analyze("http://shop.example.com");
    await ready(ui);
    const card = Array.from(ui.$("site-results").querySelectorAll("li.finding")).find((li) => li.textContent?.includes("Furnace repair"))!;
    ui.click(Array.from(card.querySelectorAll("button")).find((b) => b.textContent === "Edit"));
    const input = ui.$("site-results").querySelector("input[id^='edit-']") as HTMLInputElement;
    input.value = "Furnace tune-ups";
    ui.click(Array.from(ui.$("site-results").querySelectorAll("button")).find((b) => b.textContent === "Save my wording"));
    await vi.waitFor(() => expect(ui.text("site-results")).toMatch(/Furnace tune-ups/), { timeout: 3000 });
    expect(ui.text("site-results")).toMatch(/You changed this\. Original: “Furnace repair”/);
  });

  it("explains a failed analysis in plain words and offers to continue manually", async () => {
    const ui = await openPage(server(await fakeSite("10.0.0.7")));
    await ui.createWorkspace();
    await ui.analyze("http://shop.example.com");
    await vi.waitFor(() => expect(ui.$("site-failure").hidden).toBe(false), { timeout: 8000 });
    expect(ui.text("site-failure-text")).toMatch(/private or internal/);
    expect(ui.text("site-failure-text")).not.toMatch(/Error:|at \w+\.|node:/);
    ui.click(ui.$("site-manual"));
    expect(ui.$("site-no").hidden).toBe(false);
  });

  it("lets a business with no website describe itself with a few questions", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    ui.$("site-has-no").dispatchEvent(new ui.w.Event("change", { bubbles: true }));
    expect(ui.$("site-no").hidden).toBe(false);
    const q = (ui.$("quick-form") as HTMLFormElement).elements as any;
    q.businessName.value = "Maple Street Bakery"; q.industry.value = "Bakery"; q.services.value = "Bread\nCakes"; q.serviceArea.value = "Portland, OR"; q.targetCustomer.value = "Neighbours"; q.offer.value = "Free cookie";
    ui.submit(ui.$("quick-form"));
    expect(form(ui).businessName.value).toBe("Maple Street Bakery");
    expect(form(ui).services.value).toBe("Bread\nCakes");
    expect(ui.$("brain-details").hasAttribute("open")).toBe(true);
    expect(ui.text("notice")).toMatch(/Check the details below, then press Save Business Brain/);
    ui.submit(ui.$("brain-form"));
    await vi.waitFor(() => expect(ui.text("brain-version")).toMatch(/Saved \(version 1\)/), { timeout: 3000 });
  });

  it("shows the five steps in plain language with one primary action, and moves forward as work is done", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    const steps = () => Array.from(ui.$("path-view").querySelectorAll("li.path-step"));
    expect(steps().map((s) => s.querySelector("strong")?.textContent?.replace(/\s*\(done\)$/, ""))).toEqual([
      "Understand my business", "Review my Business Brain", "Choose a marketing goal", "Review my proposed campaign", "Approve and track results",
    ]);
    const primary = () => steps().filter((s) => s.querySelector("button:not(.linklike)")).map((s) => s.className);
    expect(primary()).toHaveLength(1);
    expect(steps()[0]!.className).toMatch(/current/);
    ui.click(ui.$("brain-demo"));
    ui.submit(ui.$("brain-form"));
    await vi.waitFor(() => expect(steps()[1]!.className).toMatch(/done/), { timeout: 4000 });
    await vi.waitFor(() => expect(steps()[2]!.className).toMatch(/current/), { timeout: 4000 });
    ui.submit(ui.$("gen-form"));
    await vi.waitFor(() => expect(steps()[3]!.className).toMatch(/current/), { timeout: 5000 });
    expect(ui.text("path-view")).not.toMatch(/\b(roas|ctr|impressions|conversions)\b/i); // no performance is implied
  });

  it("keeps advanced AI controls in developer mode and runs the one-request test in mock mode without any key", async () => {
    const ui = await openPage(server(undefined, { OPENAI_API_KEY: "sk-FAKE-dom-test-0000000000000000" }));
    await ui.createWorkspace();
    expect(ui.$("dev-mode").contains(ui.$("ai-form"))).toBe(true);
    expect(ui.$("dev-mode").contains(ui.$("aitest-form"))).toBe(true);
    expect(ui.$("dev-mode").hasAttribute("open")).toBe(false);
    await vi.waitFor(() => expect(ui.text("aitest-status")).toMatch(/AI mode:/), { timeout: 3000 });
    expect(ui.text("aitest-status")).toMatch(/SIMULATED/);
    expect(ui.text("aitest-status")).toMatch(/key present on the server/);
    expect(ui.text("aitest-status")).toMatch(/ignored in mock mode/);
    expect(ui.text("aitest-status")).toMatch(/not your provider's own billing limit/);
    ui.submit(ui.$("aitest-form"));
    await vi.waitFor(() => expect(ui.text("aitest-result")).toMatch(/Simulated: no provider was contacted/), { timeout: 3000 });
    expect(ui.text("aitest-result")).toMatch(/Cost: n\/a \(simulated\)/);
    expect(ui.doc.documentElement.outerHTML).not.toContain("sk-FAKE-dom-test"); // the key never reaches the page
  });

  it("labels the campaign step honestly: one goal available, a draft is not sent anywhere", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    expect(ui.text("s-campaigns")).toMatch(/Choose a marketing goal/);
    expect(ui.text("s-campaigns")).toMatch(/Get more leads/);
    expect(ui.text("s-campaigns")).toMatch(/not available in this version/);
    expect(ui.text("s-campaigns")).toMatch(/Nothing is sent anywhere until you approve/);
    expect(ui.$("gen-form").querySelector("button[type=submit]")?.textContent).toBe("Create my campaign draft");
  });
});

describe("creating a campaign draft always gives feedback (DOM-level)", () => {
  it("without a saved Business Brain it says why, next to the button and in the top bar, and points to the missing step", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    expect(ui.$("gen-hint").hidden).toBe(false); // the reason is shown before anything is clicked
    expect(ui.$("chrome").contains(ui.$("errors"))).toBe(true); // errors sit in the sticky bar: visible from every section
    ui.submit(ui.$("gen-form"));
    await vi.waitFor(() => expect(ui.text("gen-error")).toMatch(/Business Brain is not saved yet/), { timeout: 3000 });
    expect(ui.$("brain-details").hasAttribute("open")).toBe(true);
    expect(ui.$("errors").hidden).toBe(false);
  });

  it("with a saved Business Brain it creates the draft, says so, and shows it", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    ui.click(ui.$("brain-demo"));
    ui.submit(ui.$("brain-form"));
    await vi.waitFor(() => expect(ui.text("brain-version")).toMatch(/Saved \(version 1\)/), { timeout: 3000 });
    expect(ui.$("gen-hint").hidden).toBe(true);
    ui.submit(ui.$("gen-form"));
    await vi.waitFor(() => expect(ui.text("notice")).toMatch(/campaign draft was created/), { timeout: 5000 });
    expect(ui.text("gen-error")).toBe("");
    expect(ui.doc.querySelectorAll("#campaign-list .camp").length).toBeGreaterThan(0);
  });
});

describe("text that came from an earlier website fill can be replaced by a better one (DOM-level)", () => {
  it("a saved offer that is a whole sentence from the site is replaced by the short offer", async () => {
    const ui = await openPage(server(await fakeSite()));
    await ui.createWorkspace();
    await ui.analyze("http://shop.example.com");
    await ready(ui);
    form(ui).offer.value = "Call today for a free estimate."; // what an older fill wrote and the owner saved
    ui.click(ui.$("site-use"));
    await vi.waitFor(() => expect(form(ui).offer.value).toBe("Free estimate"), { timeout: 3000 });
  });
  it("explains a validation failure in plain words and says what to check", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    const src = readFileSync("public/app.js", "utf8");
    expect(src).toMatch(/grounding_ambiguous\|failed validation/);
    expect(src).toMatch(/Offer is a short offer such as/);
  });
});

describe("cleaning up after an earlier, worse fill, and finding the line the campaign checker objects to (DOM-level)", () => {
  it("a fill removes website-derived lines the findings no longer support and keeps the owner's own lines", async () => {
    const ui = await openPage(server(await fakeSite()));
    await ui.createWorkspace();
    await ui.analyze("http://shop.example.com");
    await ready(ui);
    form(ui).differentiators.value = "Call today for a free estimate.\nWe have never missed a Sunday call-out"; // the first came from the site earlier, the second is the owner's
    ui.click(ui.$("site-use"));
    await vi.waitFor(() => expect(ui.$("site-fill-summary").hidden).toBe(false), { timeout: 3000 });
    expect(form(ui).differentiators.value).not.toMatch(/Call today for a free estimate/);
    expect(form(ui).differentiators.value).toMatch(/never missed a Sunday call-out/);
  });

  it("when the campaign checker quotes a line, the message says which Business Brain field holds it", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    const real = ui.w.fetch as (u: string, i?: any) => Promise<any>;
    ui.w.fetch = (async (url: string, init: any = {}) => {
      if (String(url).endsWith("/campaigns/generate")) {
        return { ok: false, status: 422, json: async () => ({ error: { message: 'Model output failed validation: copy: uses a free offer ("Free") but the Business Brain states it only conditionally ("Everything homeowners want to know before scheduling a free inspection"). Remove the claim [grounding_ambiguous]' } }), text: async () => "" };
      }
      return real(url, init);
    }) as never;
    form(ui).differentiators.value = "Licensed\nEverything homeowners want to know before scheduling a free inspection.";
    ui.submit(ui.$("gen-form"));
    await vi.waitFor(() => expect(ui.text("gen-error")).toMatch(/The text it objects to is in: Approved differentiators/), { timeout: 3000 });
    expect(ui.$("brain-details").hasAttribute("open")).toBe(false);
  });
});

describe("What your ads may say (DOM-level)", () => {
  it("lists every strength, credential and price from the form, marks wording that needs proof, and removes a line on request", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    expect(ui.text("claims-review")).toMatch(/Nothing yet/);
    const f = form(ui);
    f.differentiators.value = "Family run crews\nOur shingles perform better than the rest";
    f.verifiedFacts.value = "Licensed & Insured";
    f.approvedPricing.value = "Financing available; Free estimates";
    f.unverifiedClaims.value = "Lowest prices in town";
    f.differentiators.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
    const panel = ui.$("claims-review");
    expect(panel.textContent).toMatch(/Strengths ads may use/);
    expect(panel.textContent).toMatch(/Credentials and facts ads may use[\s\S]*Licensed & Insured/);
    expect(panel.textContent).toMatch(/Prices and payment statements ads may use[\s\S]*Financing available[\s\S]*Free estimates/);
    expect(panel.textContent).toMatch(/Kept out of ads \(not verified\)[\s\S]*Lowest prices in town/);
    const rows = Array.from(panel.querySelectorAll("li.claim-row"));
    expect(rows.find((r) => /perform better/.test(r.textContent ?? ""))?.textContent).toMatch(/sounds like a claim that needs proof/);
    expect(rows.find((r) => /Family run crews/.test(r.textContent ?? ""))?.textContent).not.toMatch(/needs proof/);
    ui.click(rows.find((r) => /perform better/.test(r.textContent ?? ""))!.querySelector("button"));
    expect(f.differentiators.value).toBe("Family run crews");
    expect(ui.$("claims-review").textContent).not.toMatch(/perform better/);
    expect(ui.text("brain-version")).toMatch(/press Save Business Brain to keep the change/);
    ui.click(Array.from(ui.$("claims-review").querySelectorAll("li.claim-row")).find((r) => /Financing/.test(r.textContent ?? ""))!.querySelector("button"));
    expect(f.approvedPricing.value).toBe("Free estimates");
  });
  it("is filled by the website fill, so the owner sees what will be said", async () => {
    const ui = await openPage(server(await fakeSite()));
    await ui.createWorkspace();
    await ui.analyze("http://shop.example.com");
    await ready(ui);
    ui.click(ui.$("site-approve-claims") ?? ui.$("site-use"));
    await vi.waitFor(() => expect(ui.$("site-fill-summary").hidden).toBe(false), { timeout: 3000 });
    expect(ui.text("claims-review")).toMatch(/24\/7 emergency service available/);
  });
});

describe("Home says what is missing, what needs evidence, and whether a step is simulated or needs approval (DOM-level)", () => {
  it("lists missing Business Brain fields with the reason, marks platform steps SIMULATED, and keeps the five step titles", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    expect(ui.text("path-view")).toMatch(/Needs your attention/);
    expect(ui.text("path-view")).toMatch(/Still missing in your Business Brain: business name, type of business, services, where you work, who you serve, your offer/);
    expect(ui.text("path-view")).toMatch(/Why: The campaign is written from these/);
    const titles = Array.from(ui.$("path-view").querySelectorAll("li.path-step strong")).map((s) => s.textContent?.replace(/\s*\(done\)$/, ""));
    expect(titles).toEqual(["Understand my business", "Review my Business Brain", "Choose a marketing goal", "Review my proposed campaign", "Approve and track results"]);
    const steps = Array.from(ui.$("path-view").querySelectorAll("li.path-step"));
    expect(steps[3]!.textContent).toMatch(/SIMULATED/);
    expect(steps[4]!.textContent).toMatch(/SIMULATED/);
    expect(steps[0]!.textContent).not.toMatch(/SIMULATED/);
    // typing the business name removes it from the list straight away
    form(ui).businessName.value = "Acme"; form(ui).businessName.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
    expect(ui.text("path-view")).not.toMatch(/missing in your Business Brain: business name/);
    expect(ui.text("path-view")).toMatch(/Still missing in your Business Brain: type of business/);
  });
  it("shows the statements that need the owner's confirmation, and nothing is marked simulated for a live platform that is not there", async () => {
    const ui = await openPage(server(await fakeSite()));
    await ui.createWorkspace();
    await ui.analyze("http://shop.example.com");
    await ready(ui);
    await vi.waitFor(() => expect(ui.text("path-view")).toMatch(/statements? from your website need your confirmation/), { timeout: 3000 });
    expect(ui.text("path-view")).toMatch(/Why: Ads may only repeat what you confirm is true and can prove/);
  });
});

describe("analysing a different website, or the same one again, replaces only what a website put in the form (DOM-level)", () => {
  const ROOFS: Record<string, string> = {
    "/": `<html><head><title>Roof Pros | Roofing</title></head><body><h1>Roof Pros</h1><p>We help homeowners across Utah keep their roofs sound.</p><a href="/services">Services</a><p>Free roof inspection today.</p><p>Serving Salt Lake County, UT.</p></body></html>`,
    "/services": `<html><head><title>Services</title></head><body><h2>Our services</h2><ul><li>Roof Repair</li><li>Roof Replacement</li></ul></body></html>`,
  };
  const BAKERY: Record<string, string> = {
    "/": `<html><head><title>Maple Bakery | Bakery</title></head><body><h1>Maple Bakery</h1><a href="/menu">Menu</a><p>Fresh bread baked every morning in Portland, OR.</p></body></html>`,
    "/menu": `<html><head><title>Menu</title></head><body><h2>Our menu</h2><ul><li>Sourdough</li><li>Cinnamon rolls</li></ul></body></html>`,
  };
  const latest = (s: ReturnType<typeof server>, ws: string) => latestWebsiteAnalysis(s.ctx, ws)!;
  const waitFor = (ui: UI, re: RegExp) => vi.waitFor(() => expect(ui.text("site-results")).toMatch(re), { timeout: 8000 });

  it("two different websites: the first one's values go, the owner's own wording stays, and nothing is approved for the new site until the owner approves it", async () => {
    const s = server(await multiSite({ "roofs.example.com": ROOFS, "bakery.example.com": BAKERY }));
    const ui = await openPage(s);
    await ui.createWorkspace();
    await ui.analyze("http://roofs.example.com");
    await waitFor(ui, /roofs\.example\.com/);
    ui.click(ui.$("site-use"));
    await vi.waitFor(() => expect(form(ui).businessName.value).toBe("Roof Pros"), { timeout: 4000 });
    expect(form(ui).services.value).toMatch(/Roof Repair/);
    expect(form(ui).targetCustomer.value).toBe("Homeowners");
    expect(form(ui).serviceArea.value).toMatch(/Salt Lake County, UT/);
await vi.waitFor(() => expect((s.ctx.db.prepare("SELECT COUNT(*) n FROM website_fill_ledger").get() as { n: number }).n).toBeGreaterThan(0), { timeout: 4000 }); // the server has recorded what the fill added
    // the owner adds their own wording, and replaces the offer with their own
    form(ui).services.value += "\nGutter cleaning";
    form(ui).differentiators.value = "Family run since 1999";
    form(ui).offer.value = "My own offer";
    // a different website
    await ui.analyze("http://bakery.example.com");
    await waitFor(ui, /bakery\.example\.com/);
    const wsId = (ui.$("ws-select") as HTMLSelectElement).value;
    const second = latest(s, wsId);
    expect(second.site).toBe("bakery.example.com");
    expect(second.insights.filter((i) => i.status === "approved")).toHaveLength(0); // earlier approvals are not carried over to the new site
    ui.click(ui.$("site-use"));
    await vi.waitFor(() => expect(form(ui).businessName.value).toBe("Maple Bakery"), { timeout: 4000 });
    const services = form(ui).services.value.split("\n");
    expect(services).toEqual(expect.arrayContaining(["Sourdough", "Cinnamon rolls", "Gutter cleaning"])); // the new site's, and the owner's own
    expect(services).not.toContain("Roof Repair"); // the first site's are gone
    expect(services).not.toContain("Roof Replacement");
    expect(form(ui).serviceArea.value).not.toMatch(/Salt Lake/);
    expect(form(ui).serviceArea.value).toMatch(/Portland/);
    expect(form(ui).targetCustomer.value).toBe(""); // the first site said "Homeowners"; the second says nothing about customers, so it is cleared, not left behind
    expect(form(ui).offer.value).toBe("My own offer"); // the owner's wording stays
    expect(form(ui).differentiators.value).toBe("Family run since 1999");
    expect(ui.text("site-fill-summary")).toMatch(/Removed because an earlier website analysis put it there/);
    expect(ui.text("site-fill-summary")).toMatch(/Roof Repair/);
    // saving keeps no record that points at the first website
    form(ui).industry.value ||= "Bakery"; form(ui).targetCustomer.value = "Neighbours";
    ui.submit(ui.$("brain-form"));
    await vi.waitFor(() => expect(ui.text("brain-version")).toMatch(/Saved \(version/), { timeout: 4000 });
    const saved = getBrain(s.ctx, wsId)!.brain;
    expect(JSON.stringify(saved)).not.toMatch(/roofs\.example\.com|Roof Repair|Roof Pros/);
    expect(saved.offer).toBe("My own offer");
  }, 30000); // a long multi-step flow with two website analyses: it is slow only when the whole suite runs in parallel

  it("the same website again: what it no longer says goes, new things arrive, the owner's own lines stay", async () => {
    let t = Date.parse("2026-10-20T10:00:00Z");
    const pages = { ...ROOFS };
    const s = server(await multiSite({ "roofs.example.com": pages }), {}, () => new Date(t));
    const ui = await openPage(s);
    await ui.createWorkspace();
    await ui.analyze("http://roofs.example.com");
    await waitFor(ui, /roofs\.example\.com/);
    ui.click(ui.$("site-use"));
    await vi.waitFor(() => expect(form(ui).services.value).toMatch(/Roof Replacement/), { timeout: 4000 });
await vi.waitFor(() => expect((s.ctx.db.prepare("SELECT COUNT(*) n FROM website_fill_ledger").get() as { n: number }).n).toBeGreaterThan(0), { timeout: 4000 }); // the server has recorded what the fill added
    form(ui).services.value += "\nGutter cleaning";
    // the site changes: one service goes, another arrives
    pages["/services"] = `<html><head><title>Services</title></head><body><h2>Our services</h2><ul><li>Roof Repair</li><li>Gutter Guards</li></ul></body></html>`;
    t += 2 * 60_000;
    ui.click(ui.$("site-refresh"));
    await vi.waitFor(() => expect(ui.text("site-results")).toMatch(/Gutter Guards/), { timeout: 8000 });
    ui.click(ui.$("site-use"));
    await vi.waitFor(() => expect(form(ui).services.value).toMatch(/Gutter Guards/), { timeout: 4000 });
    const services = form(ui).services.value.split("\n");
    expect(services).toEqual(expect.arrayContaining(["Roof Repair", "Gutter Guards", "Gutter cleaning"]));
    expect(services).not.toContain("Roof Replacement");
    // pressing the button again changes nothing more (idempotent)
    const before = form(ui).services.value;
    ui.click(ui.$("site-use"));
    await vi.waitFor(() => expect(ui.$("site-fill-summary").hidden).toBe(false), { timeout: 3000 });
    expect(form(ui).services.value).toBe(before);
  });
});

describe("the server's record of what a website put in the form", () => {
  it("accepts only values it offered itself, forgets values the fill removed, and keeps each workspace apart", async () => {
    const s = server(await fakeSite());
    const a = await openPage(s);
    await a.createWorkspace();
    await a.analyze("http://shop.example.com");
    await ready(a);
    const wsId = (a.$("ws-select") as HTMLSelectElement).value;
    const analysis = latestWebsiteAnalysis(s.ctx, wsId)!;
    approveSafeInsights(s.ctx, wsId, analysis.id, "owner");
    const patch = brainPatchFor(s.ctx, wsId, analysis.id);
    expect(patch.ledger).toEqual([]);
    // the owner's own text, or a value in the wrong field, cannot be recorded as the website's
    expect(() => recordFillApplied(s.ctx, wsId, analysis.id, { added: [{ field: "services", value: "My own service" }], removed: [] }, "owner")).toThrow(/was not offered/);
    expect(() => recordFillApplied(s.ctx, wsId, analysis.id, { added: [{ field: "offer", value: patch.services[0]! }], removed: [] }, "owner")).toThrow(/was not offered/);
    expect(() => recordFillApplied(s.ctx, wsId, analysis.id, { added: [{ field: "nonsense", value: "x" }], removed: [] }, "owner")).toThrow(/was not offered/);
    expect(recordFillApplied(s.ctx, wsId, analysis.id, { added: [{ field: "services", value: patch.services[0]! }, { field: "businessName", value: patch.fields.businessName! }], removed: [] }, "owner")).toMatchObject({ recorded: 2 });
    expect(brainPatchFor(s.ctx, wsId, analysis.id).ledger.map((x) => x.field).sort()).toEqual(["businessName", "services"]);
    expect(recordFillApplied(s.ctx, wsId, analysis.id, { added: [], removed: [{ field: "services", value: patch.services[0]!.toUpperCase() }] }, "owner")).toMatchObject({ forgotten: 1 });
    expect(brainPatchFor(s.ctx, wsId, analysis.id).ledger.map((x) => x.field)).toEqual(["businessName"]);
    // another workspace never sees it
    const b = createWorkspace(s.ctx, "Other Co").workspace;
    const other = startWebsiteAnalysis(s.ctx, b.id, "http://shop.example.com", "owner");
    await other.done;
    expect(brainPatchFor(s.ctx, b.id, other.analysis.id).ledger).toEqual([]);
  });
});

describe("Phase 1: permission-denied, loading and error states, and a readable Activity page (DOM-level)", () => {
  /** Make the page believe the server said this role/permissions (the server's real derivation is tested in dashboard.test.ts). */
  function asRole(ui: UI, role: string, permissions: string[]) {
    const real = ui.w.fetch as (u: string, i?: any) => Promise<any>;
    ui.w.fetch = (async (url: string, init: any = {}) => {
      const res = await real(url, init);
      if (/\/api\/workspaces\/ws_[0-9a-f]+$/.test(String(url)) && (init.method ?? "GET") === "GET") {
        const body = await res.json();
        return { ...res, json: async () => ({ ...body, role, permissions }) };
      }
      return res;
    }) as never;
  }
  const VIEWER = ["workspace.read", "brain.read", "campaigns.read", "proposals.read", "leads.read", "activity.read", "ai.settings.read", "ai.usage.read", "brandkit.read", "assets.read", "plans.read", "creatives.read", "tasks.read", "forms.read", "analytics.read", "experiments.read", "learnings.read", "recommendations.read"];
  const OPERATOR = [...VIEWER, "jobs.read", "campaigns.generate", "campaigns.edit", "proposals.create", "leads.simulate", "leads.update", "brandkit.write", "assets.write", "plans.write", "creatives.write", "tasks.write", "leads.import", "forms.write", "experiments.write", "learnings.write"];
  const ADMIN = [...OPERATOR, "proposals.decide", "proposals.execute", "brain.write", "workspace.update", "ai.settings.write", "ai.connection_test", "jobs.retry", "brandkit.approve", "assets.review", "assets.archive", "plans.review", "campaigns.archive", "creatives.review", "assignments.manage", "experiments.decide", "learnings.confirm", "recommendations.decide", "data.export", "leads.erase", "usage.read"];
  const disabled = (ui: UI, sel: string) => (ui.doc.querySelector(sel) as HTMLButtonElement).disabled;

  it("a viewer sees what their role is, every control they cannot use is disabled, and each section says why", async () => {
    const ui = await openPage(server());
    asRole(ui, "viewer", VIEWER);
    await ui.createWorkspace();
    await vi.waitFor(() => expect(ui.text("role-pill")).toBe("Your role: viewer"), { timeout: 3000 });
    for (const sel of ["#brain-form button[type=submit]", "#site-start", "#brain-demo", "#gen-form button[type=submit]", "#edit-form button[type=submit]", "#lead-btn", "#ai-form button[type=submit]", "#aitest-send", "#ai-test-btn", "#quick-form button[type=submit]"]) {
      expect(disabled(ui, sel), sel).toBe(true);
    }
    const notes = Array.from(ui.doc.querySelectorAll(".role-note")).filter((n) => !(n as HTMLElement).hidden).map((n) => n.textContent);
    expect(notes).toHaveLength(15); // the five from before, plus the Brand Kit, the assets, the plans and the Creative section
    expect(notes.join(" ")).toMatch(/can look at plans, but your role does not allow asking for one/);
    expect(notes.join(" ")).toMatch(/can read the Brand Kit, but your role does not allow changing it/);
    expect(notes.join(" ")).toMatch(/can look at the assets, but your role does not allow uploading them/);
    expect(notes.join(" ")).toMatch(/can read the Business Brain, but your role does not allow changing it/);
    expect(notes.join(" ")).toMatch(/Only an admin or owner can approve or reject/);
    // a disabled control stays disabled even when something else toggles pending states
    ui.submit(ui.$("gen-form")); // the submit event itself is still refused by the server, never by trusting the button
    await vi.waitFor(() => expect(ui.text("gen-error").length).toBeGreaterThan(0), { timeout: 3000 });
    expect(disabled(ui, "#gen-form button[type=submit]")).toBe(true);
  });

  it("an operator can draft and propose but is told approval belongs to an admin; an admin sees the approval controls", async () => {
    const s = server();
    const ui = await openPage(s);
    asRole(ui, "operator", OPERATOR);
    await ui.createWorkspace();
    await vi.waitFor(() => expect(ui.text("role-pill")).toBe("Your role: operator"), { timeout: 3000 });
    expect(disabled(ui, "#gen-form button[type=submit]")).toBe(false);
    expect(disabled(ui, "#brain-form button[type=submit]")).toBe(true); // saving the Business Brain is an admin action
    expect(ui.doc.querySelector('.role-note[data-for="proposals.decide"]')).toBeTruthy();
    // a proposal exists: the operator sees a note instead of Approve / Reject
    const wsId = (ui.$("ws-select") as HTMLSelectElement).value;
    putBrain(s.ctx, wsId, BRAIN);
    const campaign = await generateCampaign(s.ctx, wsId, { providerId: "mock", model: "mock-deterministic-1" });
    createProposal(s.ctx, wsId, campaign.id);
    ui.$("ws-select").dispatchEvent(new ui.w.Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(ui.text("proposal-view")).toMatch(/Only an admin or owner can approve or reject/), { timeout: 4000 });
    expect(Array.from(ui.$("proposal-view").querySelectorAll("button")).map((b) => b.textContent)).not.toContain("Approve");

    const admin = await openPage(s);
    asRole(admin, "admin", ADMIN);
    admin.$("ws-select").dispatchEvent(new admin.w.Event("change", { bubbles: true }));
    await admin.createWorkspace("Admin View Co");
    await vi.waitFor(() => expect(admin.text("role-pill")).toBe("Your role: admin"), { timeout: 3000 });
    expect(disabled(admin, "#brain-form button[type=submit]")).toBe(false);
    expect(Array.from(admin.doc.querySelectorAll(".role-note")).every((n) => (n as HTMLElement).hidden)).toBe(true);
  });

  it("while the first answer is on its way the data views say Loading, and a failure shows the problem with a way to try again", async () => {
    const ui = await openPage(server());
    const real = ui.w.fetch as (u: string, i?: any) => Promise<any>;
    let mode: "slow" | "fail" | "ok" = "slow";
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    ui.w.fetch = (async (url: string, init: any = {}) => {
      if (String(url).endsWith("/dashboard")) {
        if (mode === "slow") await gate;
        if (mode === "fail") return { ok: false, status: 500, json: async () => ({ error: { message: "The dashboard could not be read" } }), text: async () => "" };
      }
      return real(url, init);
    }) as never;
    ((ui.$("ws-create") as HTMLFormElement).elements.namedItem("name") as HTMLInputElement).value = "Loading Co";
    ui.submit(ui.$("ws-create"));
    await vi.waitFor(() => expect(ui.text("dash-view")).toMatch(/Loading…/), { timeout: 3000 });
    expect(ui.text("campaign-list")).toMatch(/Loading…/);
    expect(ui.text("ops-view")).toMatch(/Loading…/);
    mode = "fail";
    release();
    await vi.waitFor(() => expect(ui.text("dash-view")).toMatch(/This could not be loaded: The dashboard could not be read/), { timeout: 4000 });
    expect(ui.$("dash-view").querySelector("[role=alert]")).toBeTruthy();
    mode = "ok";
    ui.click(Array.from(ui.$("dash-view").querySelectorAll("button")).find((b) => b.textContent === "Try again"));
    await vi.waitFor(() => expect(ui.text("dash-view")).toMatch(/Campaigns/), { timeout: 4000 });
    expect(ui.text("dash-view")).not.toMatch(/This could not be loaded/);
  });

  it("Activity reads as sentences with who and whether it was simulated, keeps the raw record under Details, and can be filtered", async () => {
    const s = server();
    const ui = await openPage(s);
    await ui.createWorkspace();
    ui.click(ui.$("brain-demo"));
    ui.submit(ui.$("brain-form"));
    await vi.waitFor(() => expect(ui.text("brain-version")).toMatch(/Saved \(version 1\)/), { timeout: 3000 });
    ui.submit(ui.$("gen-form"));
    await vi.waitFor(() => expect(ui.text("notice")).toMatch(/campaign draft was created/), { timeout: 5000 });
    await vi.waitFor(() => expect(ui.text("activity-view")).toMatch(/Campaign draft created/), { timeout: 4000 });
    const strongs = Array.from(ui.$("activity-view").querySelectorAll(".log > span > strong")).map((x) => x.textContent);
    expect(strongs).toEqual(expect.arrayContaining(["Business Brain saved", "Campaign draft created", "Workspace created"]));
    expect(strongs.join(" ")).not.toMatch(/brain\.saved|campaign\.generated/); // raw event names are not the headline
    expect(ui.text("activity-view")).toMatch(/by someone with the workspace token/);
    expect(ui.text("activity-view")).not.toMatch(/workspace-token:ws_/); // no identifiers needed to read the trail
    const details = ui.$("activity-view").querySelector("details")!;
    expect(details.hasAttribute("open")).toBe(false); // the raw record is there, but folded away
    expect(details.textContent).toMatch(/"event":/);
    // filter
    (ui.$("activity-filter") as HTMLSelectElement).value = "campaign";
    ui.$("activity-filter").dispatchEvent(new ui.w.Event("change", { bubbles: true }));
    const shown = Array.from(ui.$("activity-view").querySelectorAll(".log > span > strong")).map((x) => x.textContent);
    expect(shown).toContain("Campaign draft created");
    expect(shown).not.toContain("Business Brain saved");
    (ui.$("activity-filter") as HTMLSelectElement).value = "lead";
    ui.$("activity-filter").dispatchEvent(new ui.w.Event("change", { bubbles: true }));
    expect(ui.text("activity-view")).toMatch(/No activity of that kind/);
  });

  it("an empty Activity page explains what will appear there", async () => {
    const ui = await openPage(server());
    expect(ui.text("activity-view")).toMatch(/Nothing has happened in this workspace yet|Create or open|No activity/);
  });

  it("after saving, shows where each saved item came from: the questionnaire is the owner's, the demo is demo, nothing claims a website", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    expect(ui.$("provenance-review").hidden).toBe(true);
    ui.$("site-has-no").dispatchEvent(new ui.w.Event("change", { bubbles: true }));
    const q = (ui.$("quick-form") as HTMLFormElement).elements as any;
    q.businessName.value = "Maple Street Bakery"; q.industry.value = "Bakery"; q.services.value = "Bread\nCakes"; q.serviceArea.value = "Portland, OR"; q.targetCustomer.value = "Neighbours"; q.offer.value = "Free cookie";
    ui.submit(ui.$("quick-form"));
    ui.submit(ui.$("brain-form"));
    await vi.waitFor(() => expect(ui.$("provenance-review").hidden).toBe(false), { timeout: 3000 });
    const t = ui.text("provenance-review");
    expect(t).toMatch(/Nothing saved here came from a website/);
    expect(t).toMatch(/Business name: Maple Street Bakery\s*You entered this/);
    expect(t).not.toMatch(/From \S+\.\S+/);
    ui.click(ui.$("brain-demo")); // replacing the owner's answers asks first: a second click confirms
    ui.click(ui.$("brain-demo"));
    ui.submit(ui.$("brain-form"));
    await vi.waitFor(() => expect(ui.text("provenance-review")).toMatch(/Demo data/), { timeout: 3000 });
  });

  it("Phase 3: the goal is chosen in Step 3, sent with the draft, shown in the detail, and the version history says what an edit changed", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    ui.click(ui.$("brain-demo"));
    ui.submit(ui.$("brain-form"));
    await vi.waitFor(() => expect(ui.text("brain-version")).toMatch(/Saved \(version 1\)/), { timeout: 4000 });
    expect(ui.$("goal-service-wrap").hidden).toBe(true);
    const promote = ui.doc.querySelector("input[name=goal][value=promote_service]") as HTMLInputElement;
    promote.checked = true; promote.dispatchEvent(new ui.w.Event("change", { bubbles: true }));
    expect(ui.$("goal-service-wrap").hidden).toBe(false);
    const options = Array.from((ui.$("goal-service") as HTMLSelectElement).options).map((o) => o.value);
    expect(options.length).toBeGreaterThan(0);
    expect(options).toEqual(form(ui).services.value.split("\n").map((x: string) => x.trim()).filter(Boolean));
    (ui.$("goal-days") as HTMLInputElement).value = "14";
    ui.submit(ui.$("gen-form"));
    await vi.waitFor(() => expect(ui.text("campaign-view")).toMatch(/Your goal/), { timeout: 5000 });
    expect(ui.text("campaign-view")).toMatch(/Promote one service or offer: .+, about 14 days/);
    expect(ui.text("campaign-view")).toMatch(/Version 1 \(current\)\s*.*First version/);
    // an edit makes version 2 and the history names the changed field
    const e = (ui.$("edit-form") as HTMLFormElement).elements as any;
    e.name.value = "A clearer name";
    ui.submit(ui.$("edit-form"));
    await vi.waitFor(() => expect(ui.text("campaign-view")).toMatch(/Version 2 \(current\)/), { timeout: 4000 });
    expect(ui.text("campaign-view")).toMatch(/Name: was .* → now A clearer name/);
    expect(ui.text("campaign-view")).toMatch(/Edited by a person/);
  });

  it("Phase 3: the campaign list can be searched and filtered, and says when nothing matches", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace();
    ui.click(ui.$("brain-demo"));
    ui.submit(ui.$("brain-form"));
    await vi.waitFor(() => expect(ui.text("brain-version")).toMatch(/Saved \(version 1\)/), { timeout: 4000 });
    ui.submit(ui.$("gen-form"));
    await vi.waitFor(() => expect(ui.$("campaign-list").querySelectorAll("li.camp").length).toBe(1), { timeout: 5000 });
    const search = ui.$("camp-search") as HTMLInputElement;
    search.value = "zzz-no-such"; search.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
    expect(ui.text("campaign-list")).toMatch(/No campaigns match your search \(1 in this workspace\)/);
    search.value = ""; search.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
    expect(ui.$("campaign-list").querySelectorAll("li.camp").length).toBe(1);
    const status = ui.$("camp-status") as HTMLSelectElement;
    status.value = "approved"; status.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
    expect(ui.text("campaign-list")).toMatch(/No campaigns match/);
    status.value = "draft"; status.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
    expect(ui.$("campaign-list").querySelectorAll("li.camp").length).toBe(1);
  });

  it("Phase 4: leads show a status the owner sets, a detail with history and repeated-event state, and failed jobs can be retried a bounded number of times", async () => {
    const s = server();
    const ui = await openPage(s);
    await ui.createWorkspace();
    ui.click(ui.$("brain-demo"));
    ui.submit(ui.$("brain-form"));
    await vi.waitFor(() => expect(ui.text("brain-version")).toMatch(/Saved \(version 1\)/), { timeout: 4000 });
    ui.submit(ui.$("gen-form"));
    await vi.waitFor(() => expect(ui.$("campaign-list").querySelectorAll("li.camp").length).toBe(1), { timeout: 5000 });
    const wsId = (ui.$("ws-select") as HTMLSelectElement).value;
    const cid = (s.db.prepare("SELECT id FROM campaigns").get() as { id: string }).id;
    const prop = createProposal(s.ctx, wsId, cid, "owner");
    decideProposal(s.ctx, wsId, prop.id, "approve", { decidedBy: "test", approver: { kind: "legacy_token" }, claimedLabel: "test", acknowledgedReview: true } as never);
    requestExecution(s.ctx, wsId, prop.id, "test");
    const worker = createWorker(s.ctx);
    await worker.runUntilIdle();
    ((ui.$("lead-form") as HTMLFormElement).elements.namedItem("eventId") as HTMLInputElement).value = "e1";
    ((ui.$("lead-form") as HTMLFormElement).elements.namedItem("email") as HTMLInputElement).value = "pat@example.com";
    ui.submit(ui.$("lead-form")); // queues the lead (no worker yet)
    await vi.waitFor(() => expect(s.db.prepare("SELECT COUNT(*) n FROM jobs WHERE type = 'process_lead'").get()).toEqual({ n: 1 }), { timeout: 3000 });
    await worker.runUntilIdle();
    ui.submit(ui.$("lead-form")); // the same event id again: a duplicate, and the page reloads its lists
    await vi.waitFor(() => expect(ui.$("leads-view").querySelectorAll("tbody tr").length).toBe(1), { timeout: 4000 });
    const sel = ui.$("leads-view").querySelector("select") as HTMLSelectElement;
    expect(sel.value).toBe("new");
    sel.value = "contacted"; sel.dispatchEvent(new ui.w.Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(ui.text("lead-detail")).toMatch(/Status history/), { timeout: 4000 });
    expect(ui.text("lead-detail")).toMatch(/New → Contacted by workspace-token/);
    expect(ui.text("lead-detail")).toMatch(/Repeated events ignored: 1/);
    expect(ui.text("lead-detail")).toMatch(/no real contact was created/);
    expect((ui.$("leads-view").querySelector("select") as HTMLSelectElement).value).toBe("contacted");

    // a lead job that gave up shows a Retry button, once
    s.db.prepare("UPDATE jobs SET status = 'dead', attempts = max_attempts, last_error = 'CRM said no' WHERE type = 'process_lead'").run();
    ui.submit(ui.$("lead-form"));
    await vi.waitFor(() => expect(ui.text("ops-view")).toMatch(/Failed or retrying/), { timeout: 4000 });
    const retry = ui.buttonIn("ops-view", "Retry");
    expect(retry).toBeTruthy();
    ui.click(retry);
    await vi.waitFor(() => expect((s.db.prepare("SELECT manual_retries n FROM jobs WHERE type = 'process_lead'").get() as { n: number }).n).toBe(1), { timeout: 4000 });
    expect(ui.text("notice")).toMatch(/put back in the queue/);
  });

  it("Phase 5: Settings shows the workspace and role, says honestly that local sign-in has no accounts, shows AI usage as estimates, and lists what each integration can do and when it was tested", async () => {
    const ui = await openPage(server());
    await ui.createWorkspace("Settings Co");
    await vi.waitFor(() => expect(ui.text("ws-people-view")).toMatch(/Settings Co/), { timeout: 4000 });
    expect(ui.text("ws-people-view")).toMatch(/Your role: admin/);
    expect(ui.text("ws-people-view")).toMatch(/local-development sign-in/);
    expect(ui.text("ws-people-view")).toMatch(/can never manage people/);
    const add = ui.$("member-add").querySelector("button") as HTMLButtonElement;
    expect(add.disabled).toBe(true); // the token is never a person: only a signed-in owner can manage people
    expect(ui.text("ws-meta-view")).toMatch(/SIMULATED/);
    expect(ui.text("ws-meta-view")).toMatch(/No real ad account is connected/);
    await vi.waitFor(() => expect(ui.text("ws-usage-view")).toMatch(/Nothing is sent to any AI provider/), { timeout: 4000 });
    expect(ui.text("ws-usage-view")).toMatch(/not your provider's bill/);
    expect(ui.text("ws-usage-view")).toMatch(/No live spending ceiling is set/);
    expect(ui.text("ws-usage-view")).not.toMatch(/sk-[A-Za-z0-9]/);
    await vi.waitFor(() => expect(ui.text("integrations-view")).toMatch(/Last test/), { timeout: 4000 });
    expect(ui.text("integrations-view")).toMatch(/Never tested: there is no Meta connection test/);
    expect(ui.text("integrations-view")).toMatch(/No connection test has been run/);
  });

  it("Phase 1: approving shows 'NOT RUN YET' with a separate Run button, says honestly that local sign-in cannot enforce separation of duties, and Settings shows the policy", async () => {
    const s = server();
    const ui = await openPage(s);
    await ui.createWorkspace();
    ui.click(ui.$("brain-demo"));
    ui.submit(ui.$("brain-form"));
    await vi.waitFor(() => expect(ui.text("brain-version")).toMatch(/Saved \(version 1\)/), { timeout: 4000 });
    ui.submit(ui.$("gen-form"));
    await vi.waitFor(() => expect(ui.$("campaign-list").querySelectorAll("li.camp").length).toBe(1), { timeout: 5000 });
    const wsId = (ui.$("ws-select") as HTMLSelectElement).value;
    const cid = (s.db.prepare("SELECT id FROM campaigns").get() as { id: string }).id;
    const prop = createProposal(s.ctx, wsId, cid, "workspace-token:" + wsId); // proposed by the same shared token the page uses
    ui.click(ui.$("campaign-list").querySelector("li.camp .actions button")); // reload the selected campaign and its proposals
    await vi.waitFor(() => expect(ui.buttonIn("proposal-view", "Approve")).toBeTruthy(), { timeout: 4000 });
    (ui.$("proposal-view").querySelector("input[id^=by-]") as HTMLInputElement).value = "Pat";
    const flags = ui.$("proposal-view").querySelector("input[type=checkbox]") as HTMLInputElement | null;
    if (flags) flags.checked = true;
    ui.click(ui.buttonIn("proposal-view", "Approve"));
    await vi.waitFor(() => expect(ui.text("proposal-view")).toMatch(/NOT RUN YET/), { timeout: 4000 });
    expect(ui.text("proposal-view")).toMatch(/Approved, but nothing has happened/);
    expect(ui.text("proposal-view")).toMatch(/Local sign-in is in use: everyone shares one access token/);
    expect(ui.text("proposal-view")).toMatch(/NOT enforced here/);
    expect((s.db.prepare("SELECT COUNT(*) n FROM jobs WHERE type = 'execute_proposal'").get() as { n: number }).n).toBe(0);
    await createWorker(s.ctx).runUntilIdle();
    expect((s.db.prepare("SELECT status FROM action_proposals WHERE id = ?").get(prop.id) as { status: string }).status).toBe("approved"); // still nothing ran
    ui.click(ui.buttonIn("proposal-view", "Run (simulated)"));
    await vi.waitFor(() => expect((s.db.prepare("SELECT COUNT(*) n FROM jobs WHERE type = 'execute_proposal'").get() as { n: number }).n).toBe(1), { timeout: 4000 });
    await createWorker(s.ctx).runUntilIdle();
    expect((s.db.prepare("SELECT status FROM action_proposals WHERE id = ?").get(prop.id) as { status: string }).status).toBe("executed");
    // Settings: the policy is shown, on by default, and cannot be changed by the shared token
    await vi.waitFor(() => expect(ui.text("ws-people-view")).toMatch(/Require a second person to approve/), { timeout: 4000 });
    expect((ui.$("policy-self") as HTMLInputElement).checked).toBe(true);
    expect((ui.$("policy-self") as HTMLInputElement).disabled).toBe(true);
    expect(ui.text("ws-people-view")).toMatch(/cannot enforce this/);
    expect(ui.text("ws-people-view")).toMatch(/Organization: personal/);
  });

  it("Phase 2: the Brand section saves a versioned Brand Kit, shows review and approval honestly, and keeps the asset library's rights and review rules visible", async () => {
    const s = server();
    const ui = await openPage(s);
    await ui.createWorkspace();
    expect(ui.text("s-brand")).toMatch(/a brand preference is never proof that a claim is true/);
    const kit = (ui.$("kit-form") as HTMLFormElement).elements as any;
    const setKit = (name: string, v: string) => { kit[name].value = v; };
    // a colour line the page cannot understand is reported by line, and nothing is sent
    setKit("colors", "Brand blue 1A4D8F primary");
    ui.submit(ui.$("kit-form"));
    expect(ui.text("kit-error")).toMatch(/Colour line 1 is not understood/);
    expect(ui.requests.some((r) => r.startsWith("PUT") && r.includes("brand-kit"))).toBe(false);
    setKit("descriptors", "warm\ndirect"); setKit("avoidTerms", "cheap"); setKit("colors", "Brand blue #1A4D8F primary"); setKit("audiences", "Homeowners: owners of older houses"); setKit("disclaimers", "Terms apply | offers");
    ui.submit(ui.$("kit-form"));
    await vi.waitFor(() => expect(ui.text("kit-status")).toMatch(/DRAFT\s*version 1/), { timeout: 4000 });
    ui.click(ui.$("kit-submit"));
    await vi.waitFor(() => expect(ui.text("kit-status")).toMatch(/WAITING FOR REVIEW/), { timeout: 4000 });
    expect(ui.$("kit-review").hidden).toBe(false);
    ui.click(ui.$("kit-approve"));
    await vi.waitFor(() => expect(ui.text("kit-status")).toMatch(/APPROVED/), { timeout: 4000 });
    expect(ui.text("kit-status")).toMatch(/separation of duties could not be enforced/); // the shared local token: said plainly
    // an edit after approval makes a newer draft; the approved version is named, and the approval does not cover the edit
    setKit("notes", "A later change");
    ui.submit(ui.$("kit-form"));
    await vi.waitFor(() => expect(ui.text("kit-status")).toMatch(/DRAFT\s*version 2/), { timeout: 4000 });
    expect(ui.text("kit-status")).toMatch(/Version 1 is the approved one\. This newer version needs its own review/);
    // rejection needs a reason
    ui.click(ui.$("kit-submit"));
    await vi.waitFor(() => expect(ui.text("kit-status")).toMatch(/WAITING FOR REVIEW/), { timeout: 4000 });
    ui.click(ui.$("kit-reject"));
    expect(ui.text("kit-error")).toMatch(/Say why it is being rejected/);
    (ui.$("kit-reject-reason") as HTMLInputElement).value = "Too vague";
    ui.click(ui.$("kit-reject"));
    await vi.waitFor(() => expect(ui.text("kit-status")).toMatch(/REJECTED/), { timeout: 4000 });
    expect(ui.text("kit-status")).toMatch(/Too vague/);
    // the Business Brain was not touched by any of this
    expect((s.db.prepare("SELECT COUNT(*) n FROM business_brains").get() as { n: number }).n).toBe(0);

    // assets: an imported file must say where it came from; a file that is not an image is refused by the server with a plain message
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 3, 8, 2, 0, 0, 0, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 1]);
    const pick = (bytes: Uint8Array, name: string, type: string) => { const inp = (ui.$("asset-form") as HTMLFormElement).elements.namedItem("file") as HTMLInputElement; Object.defineProperty(inp, "files", { value: [new ui.w.File([bytes], name, { type })], configurable: true }); };
    const af = (ui.$("asset-form") as HTMLFormElement).elements as any;
    ui.submit(ui.$("asset-form"));
    expect(ui.text("asset-error")).toMatch(/Choose a PNG, JPEG or WebP file/);
    pick(png, "logo.png", "image/png"); af.source.value = "imported";
    ui.submit(ui.$("asset-form"));
    expect(ui.text("asset-error")).toMatch(/Say where an imported file came from/);
    af.source.value = "uploaded"; af.name.value = "Main logo";
    ui.submit(ui.$("asset-form"));
    await vi.waitFor(() => expect(ui.text("asset-list")).toMatch(/Main logo/), { timeout: 4000 });
    expect(ui.text("asset-list")).toMatch(/4 x 3/);
    expect(ui.text("asset-list")).toMatch(/nothing approved yet/);
    expect(ui.text("asset-list")).toMatch(/Nothing may rely on this asset until a version is approved/);
    expect(ui.text("asset-usage")).toMatch(/1 asset, .* stored in the local development folder \(no backup or retention is provided\)/);
    pick(new TextEncoder().encode("<svg><script>alert(1)</script></svg>"), "evil.png", "image/png"); af.name.value = "Disguised";
    ui.submit(ui.$("asset-form"));
    await vi.waitFor(() => expect(ui.text("errors")).toMatch(/Only PNG, JPEG and WebP images are accepted/), { timeout: 4000 });
    expect(ui.text("asset-list")).not.toMatch(/Disguised/);
    // submit, then approve (the shared local token may review; the page says separation was not enforceable)
    ui.click(ui.buttonIn("asset-list", "Submit for review"));
    await vi.waitFor(() => expect(ui.text("asset-list")).toMatch(/waiting for review/), { timeout: 4000 });
    ui.click(ui.buttonIn("asset-list", "Approve"));
    await vi.waitFor(() => expect(ui.text("asset-list")).toMatch(/version 1 approved/), { timeout: 4000 });
    expect(ui.text("asset-list")).toMatch(/separation of duties could not be enforced/);
    expect(ui.text("asset-list")).toMatch(/We own it/);
  });

  it("Phase 3: the Plans panel asks for a rule-based plan, makes separate drafts that share one total, needs the budget reviewed, and shows each campaign's lifecycle", async () => {
    const s = server();
    const ui = await openPage(s);
    await ui.createWorkspace();
    ui.click(ui.$("brain-demo"));
    ui.submit(ui.$("brain-form"));
    await vi.waitFor(() => expect(ui.text("brain-version")).toMatch(/Saved \(version 1\)/), { timeout: 4000 });
    expect(ui.text("s-campaigns")).toMatch(/the plan is never approved as a whole/);
    const f = (ui.$("plan-form") as HTMLFormElement).elements as any;
    f.total.value = "-5"; // a number input cannot hold text, so a negative total stands in for a value the page must refuse
    ui.submit(ui.$("plan-form"));
    expect(ui.text("plan-error")).toMatch(/Enter the daily total in dollars/);
    f.name.value = "Spring plan"; f.total.value = "15.00";
    ui.submit(ui.$("plan-form"));
    await vi.waitFor(() => expect(ui.text("plan-list")).toMatch(/Spring plan/), { timeout: 4000 });
    const t0 = ui.text("plan-list");
    expect(t0).toMatch(/Rule-based: one separate campaign for each service you confirmed/);
    expect(t0).toMatch(/not a forecast/);
    expect(t0).toMatch(/It is shared, not multiplied/);
    expect(t0).toMatch(/unknown, not "not offered"/);
    expect(t0).toMatch(/NOT REVIEWED/);
    expect((s.db.prepare("SELECT COUNT(*) n FROM campaigns").get() as { n: number }).n).toBe(0); // asking for a plan makes no campaign
    ui.click(ui.buttonIn("plan-list", "Make drafts for the selected opportunities"));
    await vi.waitFor(() => expect((s.db.prepare("SELECT COUNT(*) n FROM campaigns WHERE plan_id IS NOT NULL").get() as { n: number }).n).toBeGreaterThan(1), { timeout: 8000 });
    await vi.waitFor(() => expect(ui.text("plan-list")).toMatch(/draft made/), { timeout: 4000 });
    await vi.waitFor(() => expect(ui.text("campaign-list")).toMatch(/plan: Spring plan/), { timeout: 4000 });
    expect(ui.text("campaign-list")).toMatch(/Draft/);
    expect(ui.text("notice")).toMatch(/drafts? made.*Nothing is approved or sent/);
    // the campaigns together are over the plan's share: say so, lower them as a labelled edit, then review the exact numbers
    await vi.waitFor(() => expect(ui.buttonIn("plan-list", "Lower campaigns to their shares")).toBeTruthy(), { timeout: 4000 });
    ui.click(ui.buttonIn("plan-list", "Lower campaigns to their shares"));
    await vi.waitFor(() => expect(ui.buttonIn("plan-list", "Lower campaigns to their shares")).toBeFalsy(), { timeout: 5000 }); // the numbers changed: wait for the page to show them before reviewing
    await vi.waitFor(() => expect(ui.buttonIn("plan-list", "I reviewed the total and each campaign's budget")).toBeTruthy(), { timeout: 5000 });
    expect(ui.text("plan-list")).toMatch(/have not been reviewed/);
    ui.click(ui.buttonIn("plan-list", "I reviewed the total and each campaign's budget"));
    await vi.waitFor(() => expect(ui.text("plan-list")).toMatch(/BUDGET REVIEWED/), { timeout: 5000 });
    expect(ui.text("plan-list")).toMatch(/separation of duties could not be enforced/);
    // each campaign shows its own lifecycle and where it sits in the plan; one can be archived on its own
    ui.click(ui.$("campaign-list").querySelector("li.camp .actions button"));
    await vi.waitFor(() => expect(ui.text("campaign-view")).toMatch(/Part of the plan "Spring plan"/), { timeout: 4000 });
    expect(ui.text("campaign-view")).toMatch(/The plan budget has been reviewed/);
    ui.click(ui.buttonIn("campaign-view", "Archive this campaign"));
    await vi.waitFor(() => expect(ui.text("campaign-view")).toMatch(/Archived/), { timeout: 4000 });
    await vi.waitFor(() => expect(ui.text("plan-list")).toMatch(/REVIEW OUT OF DATE/), { timeout: 4000 });
  }, 30000);

  it("Budget limit: Home shows what is committed and what is left, the proposal card says what approving would do, and a refusal explains itself", async () => {
    const s = server();
    const ui = await openPage(s);
    await ui.createWorkspace();
    ui.click(ui.$("brain-demo"));
    ui.submit(ui.$("brain-form"));
    await vi.waitFor(() => expect(ui.text("brain-version")).toMatch(/Saved \(version 1\)/), { timeout: 4000 });
    const wsId = (ui.$("ws-select") as HTMLSelectElement).value;
    const mk = async (cents: number) => {
      const rec = await generateCampaign(s.ctx, wsId, { providerId: "mock", model: "mock-deterministic-1" });
      updateBrief(s.ctx, wsId, rec.id, { ...rec.brief, dailyBudgetCents: cents }, "user:editor");
      return createProposal(s.ctx, wsId, rec.id, "user:proposer");
    };
    const first = await mk(1400);
    const second = await mk(1400);
    decideProposal(s.ctx, wsId, first.id, "approve", { decidedBy: "user:approver", approver: { kind: "legacy_token" } } as never); // 1400 of the 2500 limit is now committed
    ui.$("ws-select").dispatchEvent(new ui.w.Event("change", { bubbles: true })); // reload everything from the server
    await vi.waitFor(() => expect(ui.text("dash-view")).toMatch(/Daily budget limit/), { timeout: 5000 });
    const home = ui.text("dash-view");
    expect(home).toMatch(/\$25\.00\s*your limit/);
    expect(home).toMatch(/\$14\.00\s*committed/);
    expect(home).toMatch(/\$11\.00\s*left/);
    expect(home).toMatch(/One limit for your whole workspace: every plan and stand-alone campaign counts toward it, once/);
    // open the second campaign's proposal: it says it does not fit, and approving it is refused with the full explanation
    await vi.waitFor(() => expect(ui.$("campaign-list").querySelectorAll("li.camp").length).toBe(2), { timeout: 5000 });
    ui.click(ui.$("campaign-list").querySelector("li.camp .actions button")); // the newest campaign is listed first: the one still waiting
    await vi.waitFor(() => expect(ui.text("proposal-view")).toMatch(/Approving this commits \$14\.00 per day/), { timeout: 5000 });
    expect(ui.text("proposal-view")).toMatch(/\$14\.00 of your \$25\.00 daily limit is already committed, leaving \$11\.00/);
    expect(ui.text("proposal-view")).toMatch(/It does not fit/);
    (ui.$("proposal-view").querySelector("input[id^=by-]") as HTMLInputElement).value = "Pat";
    const ack = ui.$("proposal-view").querySelector("input[type=checkbox]") as HTMLInputElement | null;
    if (ack) ack.checked = true;
    ui.click(ui.buttonIn("proposal-view", "Approve"));
    await vi.waitFor(() => expect(ui.text("errors")).toMatch(/This would commit 1400¢ per day\. 1400¢ of your 2500¢ daily limit is already committed/), { timeout: 5000 });
    expect(ui.text("errors")).toMatch(/leaving 1100¢/);
    expect((s.db.prepare("SELECT status FROM action_proposals WHERE id = ?").get(second.id) as { status: string }).status).toBe("proposed");
    expect(ui.text("path-view")).not.toMatch(/over your daily limit/);
  }, 30000);

  it("Creative: start from an idea, make placeholder pictures, see the checks with repair guidance and the AI critique marked not performed, and send for review", async () => {
    const s = server();
    const ui = await openPage(s);
    await ui.createWorkspace();
    ui.click(ui.$("brain-demo"));
    ui.submit(ui.$("brain-form"));
    await vi.waitFor(() => expect(ui.text("brain-version")).toMatch(/Saved \(version 1\)/), { timeout: 4000 });
    const wsId = (ui.$("ws-select") as HTMLSelectElement).value;
    await generateCampaign(s.ctx, wsId, { providerId: "mock", model: "mock-deterministic-1" });
    ui.$("ws-select").dispatchEvent(new ui.w.Event("change", { bubbles: true })); // reload everything from the server
    await vi.waitFor(() => expect(ui.$("campaign-list").querySelectorAll("li.camp").length).toBe(1), { timeout: 5000 });
    await vi.waitFor(() => expect(ui.$("cr-campaign").querySelectorAll("option").length).toBe(1), { timeout: 5000 });
    await vi.waitFor(() => expect(ui.text("cr-concepts")).toMatch(/Use this idea/), { timeout: 5000 });
    expect(ui.text("cr-provider")).toMatch(/not real artwork|placeholder/i);
    expect(ui.text("cr-provider")).toMatch(/Video and storyboards are planned. Only still images can be made today/);
    expect(ui.text("cr-concepts")).toMatch(/not generated by AI/);
    ui.click(ui.buttonIn("cr-concepts", "Use this idea"));
    await vi.waitFor(() => expect(ui.buttonIn("cr-list", "Make the pictures")).toBeTruthy(), { timeout: 5000 });
    expect(ui.text("cr-list")).toMatch(/No picture yet/);
    ui.click(ui.buttonIn("cr-list", "Make the pictures"));
    await vi.waitFor(() => expect(ui.text("cr-list")).toMatch(/Waiting to start|Making the picture/), { timeout: 5000 });
    await createWorker(s.ctx).runUntilIdle(); // nothing is complete until the job has run and its output was validated and stored
    await vi.waitFor(() => expect(ui.text("cr-list")).toMatch(/Placeholder from the offline mock: not real artwork/), { timeout: 8000 });
    expect(ui.text("cr-list")).toMatch(/PLACEHOLDER/);
    ui.click(ui.buttonIn("cr-list", "Check now"));
    await vi.waitFor(() => expect(ui.text("cr-list")).toMatch(/Automatic checks \(just now\)/), { timeout: 5000 });
    expect(ui.text("cr-list")).toMatch(/AI-assisted critique: No AI critique was run/);
    expect(ui.text("cr-list")).toMatch(/not a prediction of results/);
    ui.click(ui.buttonIn("cr-list", "Send for review"));
    await vi.waitFor(() => expect(ui.text("cr-list")).toMatch(/WAITING FOR REVIEW/), { timeout: 5000 });
    expect((s.db.prepare("SELECT status FROM creative_versions").get() as { status: string }).status).toBe("needs_review");
    expect(s.db.prepare("SELECT COUNT(*) n FROM creative_variants").get()).toEqual({ n: 2 }); // a suggestion asks for the square and portrait formats: one stored picture each
  }, 30000);

  it("Inbox & calendar: add a dated task tied to a campaign version, see it overdue, close it, see a proposed date labelled as not a platform schedule, and learn the token is not a person", async () => {
    const s = server();
    const ui = await openPage(s);
    await ui.createWorkspace();
    ui.click(ui.$("brain-demo"));
    ui.submit(ui.$("brain-form"));
    await vi.waitFor(() => expect(ui.text("brain-version")).toMatch(/Saved \(version 1\)/), { timeout: 4000 });
    const wsId = (ui.$("ws-select") as HTMLSelectElement).value;
    await generateCampaign(s.ctx, wsId, { providerId: "mock", model: "mock-deterministic-1" });
    ui.$("ws-select").dispatchEvent(new ui.w.Event("change", { bubbles: true }));
    await vi.waitFor(() => expect((ui.$("tm-campaign") as HTMLSelectElement).value).toMatch(/^cmp_|^[a-z]+_/), { timeout: 5000 });
    await vi.waitFor(() => expect(ui.text("tm-inbox")).toMatch(/Assigned to you/), { timeout: 5000 });
    expect(ui.text("tm-inbox")).toMatch(/not a person/); // the shared token has no inbox of its own
    expect(ui.text("tm-notes")).toMatch(/not a person/);
    expect(ui.text("s-inbox")).toMatch(/nothing is sent by e-mail, text message or push/i);

    const form = ui.$("tm-work-form") as HTMLFormElement;
    (form.elements.namedItem("title") as HTMLInputElement).value = "Finish the draft";
    (form.elements.namedItem("kind") as HTMLSelectElement).value = "draft";
    (form.elements.namedItem("dueDate") as HTMLInputElement).value = "2000-01-01";
    ui.submit(form);
    await vi.waitFor(() => expect(ui.text("tm-inbox")).toMatch(/Finish the draft/), { timeout: 5000 });
    expect(ui.text("tm-inbox").slice(0, 700)).toMatch(/overdue since 2000-01-01/);
    expect(ui.text("tm-inbox")).toMatch(/Finish and check the draft of .* \(version 1\)/); // the stated action names the exact version
    expect(ui.text("tm-inbox")).toMatch(/Campaign .* version 1/);

    ui.click(ui.buttonIn("tm-inbox", "Mark done"));
    await vi.waitFor(() => expect(ui.text("tm-inbox")).not.toMatch(/overdue since/), { timeout: 5000 });

    (form.elements.namedItem("title") as HTMLInputElement).value = "Aim to run on the 15th";
    (form.elements.namedItem("kind") as HTMLSelectElement).value = "schedule_proposal";
    const soon = new Date(s.ctx.now().getTime() + 3 * 86400000).toISOString().slice(0, 10); // relative to the server clock, which this test server may fix
    (form.elements.namedItem("dueDate") as HTMLInputElement).value = soon;
    ui.submit(form);
    await vi.waitFor(() => expect(ui.text("tm-cal")).toMatch(/Proposed date \(not a platform schedule\)/), { timeout: 5000 });
    expect(ui.text("tm-inbox")).toMatch(/PROPOSED ONLY/);
    expect(ui.text("tm-cal")).toMatch(/Nothing is scheduled on any ad platform/);
    expect((s.db.prepare("SELECT COUNT(*) n FROM work_items").get() as { n: number }).n).toBe(2);
  }, 30000);

  it("Leads and Results: paste a CSV, see IMPORTED leads kept apart from synthetic data, define a form that is not published, and see what is NOT measured", async () => {
    const s = server();
    const ui = await openPage(s);
    await ui.createWorkspace();
    ui.click(ui.$("brain-demo"));
    ui.submit(ui.$("brain-form"));
    await vi.waitFor(() => expect(ui.text("brain-version")).toMatch(/Saved \(version 1\)/), { timeout: 4000 });
    const wsId = (ui.$("ws-select") as HTMLSelectElement).value;
    await generateCampaign(s.ctx, wsId, { providerId: "mock", model: "mock-deterministic-1" });
    ui.$("ws-select").dispatchEvent(new ui.w.Event("change", { bubbles: true }));
    await vi.waitFor(() => expect((ui.$("in-campaign") as HTMLSelectElement).value).toMatch(/^[a-z]+_/), { timeout: 5000 });

    const form = ui.$("in-import-form") as HTMLFormElement;
    (form.elements.namedItem("sourceNote") as HTMLInputElement).value = "Trade show list";
    (form.elements.namedItem("rows") as HTMLTextAreaElement).value = "fullName,email,phone,utm_source\nAda Lovelace,ada@example.com,512-555-0101,fair\nNo Contact,,,\nBo Bell,bo@example.com,,";
    ui.submit(form);
    await vi.waitFor(() => expect(ui.text("in-result")).toMatch(/3 rows read: 2 imported, 0 already here \(skipped\), 1 rejected/), { timeout: 5000 });
    expect(ui.text("in-result")).toMatch(/Row 2: .*email or phone is required/);
    expect(ui.text("in-result")).toMatch(/not sent to any CRM/);
    await vi.waitFor(() => expect(ui.text("leads-view")).toMatch(/IMPORTED/), { timeout: 5000 });
    expect(ui.text("leads-view")).toMatch(/attribution inferred/);
    expect(ui.text("leads-view")).toMatch(/version not recorded/);
    expect(ui.text("in-batches")).toMatch(/2 of 3 imported .* Source: Trade show list\. Consent not recorded/);

    // a malformed paste is explained, not guessed
    (form.elements.namedItem("rows") as HTMLTextAreaElement).value = "email\nx@y.com";
    ui.submit(form);
    await vi.waitFor(() => expect(ui.text("in-error")).toMatch(/header with a fullName/), { timeout: 3000 });

    // the lead detail says what it is and how sure the link is
    ui.click(Array.from(ui.$("leads-view").querySelectorAll("button")).find((b) => b.textContent === "Details") as HTMLElement);
    await vi.waitFor(() => expect(ui.text("lead-detail")).toMatch(/Brought in by a person from somewhere else/), { timeout: 5000 });
    expect(ui.text("lead-detail")).toMatch(/Arriving after a campaign is not proof the campaign caused it/);
    expect(ui.text("lead-detail")).toMatch(/this app does not send any message to a lead/);

    // a form is a definition: not published
    ui.submit(ui.$("in-form-define"));
    await vi.waitFor(() => expect(ui.text("in-forms")).toMatch(/NOT PUBLISHED/), { timeout: 5000 });
    expect(ui.text("in-forms")).toMatch(/not published or hosted/);

    // reporting: each origin on its own, nothing blended, unknowns are not zero
    ui.$("main-nav").querySelector('a[href="#s-results"]')!.dispatchEvent(new ui.w.Event("click", { bubbles: true }));
    await vi.waitFor(() => expect(ui.text("rs-view")).toMatch(/Imported leads/), { timeout: 5000 });
    const r = ui.text("rs-view");
    expect(r).toMatch(/never added together/);
    expect(r).toMatch(/Real leads from a verified integration/);
    expect(r).toMatch(/Cost per lead\s*Not measured/);
    expect(r).toMatch(/Impressions\s*Not measured/);
    expect(r).toMatch(/Return on ad spend\s*Not measured/);
    expect(r).toMatch(/not proof the campaign caused it/);
    expect(r).not.toMatch(/Cost per lead\s*\$|Cost per lead\s*0/);
  }, 30000);

  it("Learning: plan an experiment on two exact versions, freeze it, record synthetic data and see it cannot support a decision, conclude without changing anything, and confirm a suggested learning", async () => {
    const s = server();
    const ui = await openPage(s);
    await ui.createWorkspace();
    ui.click(ui.$("brain-demo"));
    ui.submit(ui.$("brain-form"));
    await vi.waitFor(() => expect(ui.text("brain-version")).toMatch(/Saved \(version 1\)/), { timeout: 4000 });
    const wsId = (ui.$("ws-select") as HTMLSelectElement).value;
    const rec = await generateCampaign(s.ctx, wsId, { providerId: "mock", model: "mock-deterministic-1" });
    updateBrief(s.ctx, wsId, rec.id, { ...rec.brief, dailyBudgetCents: rec.brief.dailyBudgetCents - 50 }, "user:editor"); // campaign version 2
    ui.$("ws-select").dispatchEvent(new ui.w.Event("change", { bubbles: true }));
    await vi.waitFor(() => expect((ui.$("ln-exp-form-box").querySelector("select[name=vVersion]") as HTMLSelectElement | null)?.options.length).toBe(2), { timeout: 6000 });
    expect(ui.text("s-learning")).toMatch(/records and decisions only/);
    expect(ui.text("s-learning")).toMatch(/this app measures no performance/);

    const form = ui.$("ln-exp-form") as HTMLFormElement;
    const set = (n: string, v: string) => { (form.elements.namedItem(n) as HTMLInputElement).value = v; };
    set("name", "Headline test"); set("hypothesis", "A question headline gets more qualified leads"); set("variableNote", "Only the headline wording differs"); set("audienceNote", "Homeowners nearby"); set("placementNote", "Feed");
    set("decisionRule", "Switch if the variant is clearly higher with enough data; otherwise keep the control"); set("minSample", "20");
    set("cVersion", "1"); set("vVersion", "2"); set("vLabel", "Question"); set("vDesc", "Question headline");
    ui.submit(form);
    await vi.waitFor(() => expect(ui.text("ln-experiments")).toMatch(/Headline test/), { timeout: 5000 });
    expect(ui.text("ln-experiments")).toMatch(/plan can still change/);
    expect(ui.text("ln-experiments")).toMatch(/Decision rule, written before the data/);
    expect(ui.text("ln-experiments")).toMatch(/Control.*version 1.*Question.*version 2/);

    ui.click(ui.buttonIn("ln-experiments", "Start (freezes the plan)"));
    await vi.waitFor(() => expect(ui.text("ln-experiments")).toMatch(/PLAN FROZEN/), { timeout: 5000 });
    ui.click(ui.buttonIn("ln-experiments", "Show the analysis"));
    await vi.waitFor(() => expect(ui.text("ln-experiments")).toMatch(/still collecting/), { timeout: 5000 });
    expect(ui.text("ln-experiments")).toMatch(/blocks a conclusion/);
    expect(ui.text("ln-experiments")).toMatch(/cannot verify how people were assigned/);

    // record SYNTHETIC results: shown as such, and the sample does not grow
    const resForm = Array.from(ui.$("ln-experiments").querySelectorAll("form")).find((f) => f.textContent?.includes("Record a result")) as HTMLFormElement;
    (resForm.elements.namedItem("successes") as HTMLInputElement).value = "5"; (resForm.elements.namedItem("trials") as HTMLInputElement).value = "10";
    (resForm.elements.namedItem("sourceType") as HTMLSelectElement).value = "synthetic"; (resForm.elements.namedItem("observedOn") as HTMLInputElement).value = "2030-01-10"; (resForm.elements.namedItem("sourceNote") as HTMLInputElement).value = "Simulator";
    ui.submit(resForm);
    await vi.waitFor(() => expect(ui.text("ln-experiments")).toMatch(/SYNTHETIC.*5 of 10/), { timeout: 5000 });
    expect(ui.text("ln-experiments")).toMatch(/only data is synthetic/);
    expect(ui.text("ln-experiments")).toMatch(/No statistical test was run/);
    expect(ui.text("ln-experiments")).not.toMatch(/statistically significant\./);

    // concluding records a decision and changes nothing
    const budgetBefore = JSON.stringify(s.db.prepare("SELECT id, status, current_version FROM campaigns").all());
    const conForm = Array.from(ui.$("ln-experiments").querySelectorAll("form")).find((f) => f.textContent?.includes("Your decision")) as HTMLFormElement;
    (conForm.elements.namedItem("outcome") as HTMLSelectElement).value = "inconclusive"; (conForm.elements.namedItem("rationale") as HTMLTextAreaElement).value = "Only synthetic data so far";
    ui.submit(conForm);
    await vi.waitFor(() => expect(ui.text("ln-experiments")).toMatch(/CONCLUDED/), { timeout: 5000 });
    expect(ui.text("ln-experiments")).toMatch(/No clear difference: Only synthetic data so far/);
    expect(JSON.stringify(s.db.prepare("SELECT id, status, current_version FROM campaigns").all())).toBe(budgetBefore);

    // the Marketing Brain: a rule-made suggestion is not a learning until a person confirms it
    ui.click(ui.$("ln-suggest"));
    await vi.waitFor(() => expect(ui.text("ln-learnings")).toMatch(/Suggested by a rule/), { timeout: 5000 });
    expect(ui.text("ln-learnings")).toMatch(/never makes an ad claim usable/);
    expect(ui.text("ln-learnings")).toMatch(/Does not show: A person's judgement, not a proven effect/);
    expect(ui.text("ln-learnings")).not.toMatch(/HUMAN-CONFIRMED/);
    ui.click(ui.buttonIn("ln-learnings", "Confirm"));
    await vi.waitFor(() => expect(ui.text("ln-learnings")).toMatch(/HUMAN-CONFIRMED/), { timeout: 5000 });
    expect(ui.text("ln-recs")).toMatch(/derived from records in this workspace/);
  }, 40000);

  it("Integrations: the registry says nothing can reach the outside world, lists exact capabilities and what is not built, runs a SIMULATED self-test, and previews a run without changing anything", async () => {
    const s = server();
    const ui = await openPage(s);
    await ui.createWorkspace();
    ui.click(ui.$("brain-demo"));
    ui.submit(ui.$("brain-form"));
    await vi.waitFor(() => expect(ui.text("brain-version")).toMatch(/Saved \(version 1\)/), { timeout: 4000 });
    const wsId = (ui.$("ws-select") as HTMLSelectElement).value;
    const rec = await generateCampaign(s.ctx, wsId, { providerId: "mock", model: "mock-deterministic-1" });
    const prop = createProposal(s.ctx, wsId, rec.id, "user:proposer");
    ui.$("ws-select").dispatchEvent(new ui.w.Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(ui.text("integ-registry")).toMatch(/Nothing here can reach the outside world/), { timeout: 6000 });
    const r = ui.text("integ-registry");
    expect(r).toMatch(/Meta is simulated/);
    expect(r).toMatch(/cannot switch one on/);
    expect(r).toMatch(/Meta Ads.*SIMULATED/);
    expect(r).toMatch(/GoHighLevel CRM.*SIMULATED/);
    expect(r).toMatch(/Credential vault.*DISABLED/);
    expect(r).toMatch(/Set a real budget or activate a campaign.*NOT BUILT/);
    expect(r).toMatch(/Future channels \(declared, not built\)/);
    expect(r).toMatch(/Google Ads.*NOT BUILT/);
    expect(r).toMatch(/Indicative scopes: ads_management/);
    expect(r).toMatch(/checked against the vendor's documentation/);
    expect(r).not.toMatch(/sk-|Bearer /);
    // there is no control in the registry that turns anything on: the only buttons are self-tests and read-only previews
    const labels = Array.from(ui.$("integ-registry").querySelectorAll("button")).map((b) => b.textContent);
    expect(labels.every((l) => /self-test|^Preview/.test(String(l)))).toBe(true);

    const before = JSON.stringify([s.db.prepare("SELECT id, status FROM action_proposals").all(), s.db.prepare("SELECT COUNT(*) n FROM jobs").get()]);
    ui.click(ui.buttonIn("integ-registry", "Run a simulated self-test"));
    await vi.waitFor(() => expect(ui.text("integ-registry")).toMatch(/Last test \(SIMULATED\): passed/), { timeout: 5000 });
    expect(ui.text("integ-registry")).toMatch(/Nothing was contacted/);

    await vi.waitFor(() => expect((ui.$("integ-registry").querySelector("select[aria-label=Proposal]") as HTMLSelectElement | null)?.value).toBe(prop.id), { timeout: 5000 });
    ui.click(ui.buttonIn("integ-registry", "Preview this proposal's run"));
    await vi.waitFor(() => expect(ui.text("integ-preview-out")).toMatch(/SIMULATED: the built-in simulator would create a paused draft/), { timeout: 5000 });
    expect(ui.text("integ-preview-out")).toMatch(/budget sent: no/);
    expect(ui.text("integ-preview-out")).toMatch(/not everything is met/); // it is only proposed, not approved
    expect(ui.text("integ-preview-out")).toMatch(/The proposal has been approved/);
    expect(ui.text("integ-preview-out")).toMatch(/read-only preview. It changed nothing and queued nothing/);
    expect(JSON.stringify([s.db.prepare("SELECT id, status FROM action_proposals").all(), s.db.prepare("SELECT COUNT(*) n FROM jobs").get()])).toBe(before); // looking changed nothing
  }, 30000);
});
