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
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import type { FetchDeps } from "../src/web/safeFetch.js";

const HTML = readFileSync("public/index.html", "utf8");
const asScript = (f: string) => readFileSync(`public/${f}`, "utf8").replace(/^export /gm, "").replace(/^import .*\n/gm, "");
const SCRIPT = [asScript("recovery.js"), asScript("dashboard.js"), asScript("claims.js"), asScript("onboarding.js"), asScript("aitest.js"), asScript("ai.js"), asScript("app.js")].join("\n");

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

function server(deps?: FetchDeps, env: Record<string, string> = {}) {
  const db = openDb(":memory:");
  migrate(db);
  const ctx = buildContext({ db, env, backoffMs: () => 0, gateway: { sleep: async () => {} }, webFetchDeps: deps, webCrawl: { limits: { timeoutMs: 2000 } } });
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
