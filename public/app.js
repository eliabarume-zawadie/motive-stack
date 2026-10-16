import { initAi } from "./ai.js";

// MotiveStack local UI. Talks only to this server's API. Uses textContent everywhere (no innerHTML),
// and holds no provider credentials: the only secret here is this workspace's own access token.

const $ = (id) => document.getElementById(id);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
const lines = (s) => s.split("\n").map((x) => x.trim()).filter(Boolean);

const state = { config: null, sessions: [], current: null, campaigns: [], campaign: null, campaignId: null };

// ---- session storage (workspace id + token live only in this browser) ----
const SKEY = "ms_sessions", CKEY = "ms_current";
function loadSessions() {
  try { state.sessions = JSON.parse(localStorage.getItem(SKEY) || "[]"); state.current = localStorage.getItem(CKEY); } catch { state.sessions = []; }
  if (!state.sessions.find((s) => s.id === state.current)) state.current = state.sessions[0]?.id ?? null;
}
function saveSessions() {
  try { localStorage.setItem(SKEY, JSON.stringify(state.sessions)); if (state.current) localStorage.setItem(CKEY, state.current); } catch { /* storage unavailable: session lasts until reload */ }
}
const session = () => state.sessions.find((s) => s.id === state.current) ?? null;

// ---- API ----
function showError(msg) {
  const box = $("errors");
  box.hidden = !msg;
  box.textContent = msg || "";
}
async function api(path, { method = "GET", body, scoped = true, quiet = false } = {}) {
  const s = session();
  const headers = { "content-type": "application/json" };
  let url = path;
  if (scoped) {
    if (!s) throw new Error("Create or select a workspace first");
    url = `/api/workspaces/${s.id}${path}`;
    headers.authorization = `Bearer ${s.token}`;
  }
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    const issues = e.issues ? ` (${e.issues.map((i) => `${i.path}: ${i.message}`).join("; ")})` : "";
    const msg = `${e.message || `Request failed (${res.status})`}${issues}`;
    if (!quiet) showError(msg);
    throw new Error(msg);
  }
  if (!quiet) showError("");
  return data;
}

// ---- helpers ----
const statusClass = (st) => ({ executed: "ok", approved: "info", proposed: "warn", rejected: "bad", failed: "bad", stale: "warn", needs_review: "bad", executing: "info" }[st] || "");
const pill = (text, cls = "") => h("span", { class: `pill ${cls}` }, text);
const simBadge = () => pill("SIMULATED", "sim");
const kv = (rows) => h("dl", { class: "kv" }, rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));

// ---- rendering ----
function renderBanner() {
  const c = state.config;
  const b = $("banner");
  if (!c) return;
  const anyLive = c.live.meta || c.live.ai;
  const local = !!c.ai?.local;
  b.className = `banner${anyLive ? " live" : ""}`;
  const parts = [
    c.live.meta ? "Meta: LIVE (writes stay approval-gated and paused-only)" : "Meta: simulated",
    c.live.ai ? "AI: LIVE (real provider calls, possibly billed)" : local ? "AI: LOCAL model on this machine (real output, free, nothing leaves this computer)" : "AI: simulated",
    "GoHighLevel: simulated",
  ];
  b.textContent = anyLive || local
    ? `${parts.join(" | ")}. Simulated parts are NOT real results.`
    : "MOCK MODE: Meta, GoHighLevel and AI are all simulated. No real ads, spend, messages or provider calls. Results are NOT real advertising performance.";
}

function renderWorkspaces() {
  const sel = $("ws-select");
  sel.replaceChildren(...(state.sessions.length ? state.sessions.map((s) => h("option", { value: s.id, selected: s.id === state.current }, s.name)) : [h("option", { value: "" }, "No workspace yet")]));
}

function fillBrainForm(brain, version) {
  const f = $("brain-form");
  if (!brain) { $("brain-version").textContent = "Not saved yet"; return; }
  for (const k of ["businessName", "industry", "serviceArea", "targetCustomer", "offer", "tone", "maxDailyBudgetCents"]) f.elements[k].value = brain[k];
  f.elements.services.value = brain.services.join("\n");
  f.elements.differentiators.value = brain.differentiators.join("\n");
  f.elements.verifiedFacts.value = (brain.verifiedFacts || []).join("\n");
  f.elements.approvedPricing.value = brain.approvedPricing || "";
  f.elements.unverifiedClaims.value = (brain.unverifiedClaims || []).join("\n");
  f.elements.prohibitedClaims.value = (brain.prohibitedClaims || []).join("\n");
  f.elements.description.value = brain.description || "";
  state.brainFacts = brain.facts || []; // records with provenance are not editable in this form, but must survive a save
  $("brain-version").textContent = `Saved (version ${version})`;
}

function fillEditForm(c) {
  const f = $("edit-form");
  f.elements.name.value = c.brief.name;
  f.elements.dailyBudgetCents.value = c.brief.dailyBudgetCents;
  f.elements.headlines.value = c.brief.headlines.join("\n");
  f.elements.primaryTexts.value = c.brief.primaryTexts.join("\n");
}

let lastCampaignListKey = "";
function renderCampaignList() {
  const sel = $("campaign-select");
  const key = JSON.stringify([state.campaigns, state.campaignId]);
  if (key === lastCampaignListKey) return; // unchanged: keep the open dropdown stable
  lastCampaignListKey = key;
  sel.replaceChildren(...(state.campaigns.length ? state.campaigns.map((c) => h("option", { value: c.id, selected: c.id === state.campaignId }, `${c.name} (${c.status.replace("_", " ")})`)) : [h("option", { value: "" }, "No campaigns yet")]));
}

const usd = (cents) => "$" + (cents / 100).toFixed(2);
const list = (items, empty) => (items && items.length ? h("ul", { class: "plain" }, items.map((x) => h("li", {}, x))) : h("span", { class: "muted" }, empty));

function renderCampaign() {
  const c = state.campaign, v = $("campaign-view");
  if (!c) { v.replaceChildren(h("p", { class: "hint" }, "Generate a brief to create a campaign.")); return; }
  const b = c.brief, t = b.targeting || {};
  const ceiling = c.ceilingCents;
  const missing = "Not provided (this brief was written before this field existed)";
  const budgetRows = [
    ["Proposed starting budget", usd(b.dailyBudgetCents) + " per day"],
    ["Your ceiling", ceiling == null ? "unknown" : usd(ceiling) + " per day. A hard limit, never a target."],
    ["Why this budget", b.budgetRationale || h("span", { class: "muted" }, missing)],
  ];
  if (b.reviewFlags && b.reviewFlags.length) budgetRows.push(["Needs review", h("ul", { class: "plain" }, b.reviewFlags.map((x) => h("li", {}, pill("review", "warn"), " " + x)))]);
  if (c.specialAdCategories && c.specialAdCategories.length) budgetRows.push(["Special ad category", pill(c.specialAdCategories.join(", "), "bad")]);

  const targetingRows = [
    ["Approach", t.approach || h("span", { class: "muted" }, missing)],
    ["How it connects to the service", t.connection || h("span", { class: "muted" }, missing)],
    ["Basis", t.basis ? pill(t.basis.replace(/_/g, " "), t.basis === "owner_provided" ? "ok" : "warn") : h("span", { class: "muted" }, "unknown")],
    ["Evidence supplied", list(t.evidence, "None supplied by the owner")],
    ["What is not known", list(t.uncertainties, "Nothing stated")],
    ["Restrictions", list(t.restrictions, "None stated")],
    ["Needed from you", list(t.needsFromOwner, "Nothing")],
    ["Settings the platform can apply", b.audience.locations.join(", ") + ", ages " + b.audience.ageMin + "-" + b.audience.ageMax + (b.audience.interests.length ? "; interests: " + b.audience.interests.join(", ") : "; no interest targeting")],
  ];

  const decisions = (b.differentiatorDecisions || []).map((d) => h("li", {}, pill(d.used ? "used" : "held back", d.used ? "ok" : ""), " " + d.differentiator + (d.reason ? " (" + d.reason + ")" : "")));
  const questions = (b.openQuestions || []).map((q) => h("li", {}, q.blocking ? pill("BLOCKS LAUNCH", "bad") : pill("question", "warn"), " ", h("strong", {}, q.question), q.impact ? h("div", { class: "hint" }, "Why it matters: " + q.impact) : null));
  const checks = (c.platformValidation || []).map((k) => h("li", {}, pill(k.pass ? "pass" : "fail", k.pass ? "ok" : "bad"), " " + k.label + ": ", h("span", { class: "muted" }, k.detail)));

  v.replaceChildren(
    h("div", { class: "card" },
      h("strong", {}, b.name), " ", pill(c.status === "draft" ? "draft (nothing external)" : "paused draft launched", c.status === "draft" ? "" : "ok"), " ", pill("version " + c.currentVersion),
      h("h3", {}, "Budget"), kv(budgetRows),
      h("h3", {}, "Targeting recommendation"), kv(targetingRows),
      h("p", { class: "hint" }, c.applicableTargetingNote || ""),
      h("h3", {}, "Creative"),
      kv([
        ["Objective", b.objective + ", call to action " + b.callToAction],
        ["Headlines", h("ul", { class: "plain" }, b.headlines.map((x) => h("li", {}, x + " ", h("span", { class: "muted" }, "(" + x.length + "/40)"))))],
        ["Primary texts", h("ul", { class: "plain" }, b.primaryTexts.map((x) => h("li", {}, x + " ", h("span", { class: "muted" }, "(" + x.length + "/125)"))))],
        ["How the variations differ", b.variations && b.variations.length ? h("ul", { class: "plain" }, b.variations.map((x) => h("li", {}, h("strong", {}, x.angle + ": "), x.strategicDifference))) : h("span", { class: "muted" }, missing)],
        ["Approved differentiators", decisions.length ? h("ul", { class: "plain" }, decisions) : h("span", { class: "muted" }, missing)],
        ["Overall rationale", b.rationale],
      ]),
      h("h3", {}, "Open questions and assumptions"),
      questions.length ? h("ul", { class: "plain" }, questions) : h("p", { class: "hint" }, "No open questions: nothing material was missing, or the model judged none would change this campaign."),
      kv([["Assumptions made", list(b.assumptions, "None stated")]]),
      h("h3", {}, "Meta platform checks"),
      checks.length ? h("ul", { class: "plain" }, checks) : h("p", { class: "hint" }, "Save the Business Brain to see these."),
      h("div", { class: "hint" }, "Versions: ", c.versions.map((x) => "v" + x.version + " " + (x.source === "ai" ? "AI (" + x.aiProvider + "/" + x.aiModel + ")" : "human edit")).join(" → ")),
    ),
  );
}

function renderProposals() {
  const c = state.campaign, v = $("proposal-view");
  if (v.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return; // don't wipe what the user is typing
  if (!c) { v.replaceChildren(h("p", { class: "hint" }, "Select a campaign first.")); return; }
  const open = c.proposals.find((p) => ["proposed", "approved", "executing"].includes(p.status));
  const nodes = [];
  if (c.status === "draft" && !open) {
    nodes.push(h("button", { onclick: () => act(() => api(`/campaigns/${c.id}/proposals`, { method: "POST", body: {} })) }, "Propose a paused draft on the ad platform"));
    nodes.push(h("p", { class: "hint" }, "Proposing changes nothing outside this app. An explicit approval is required before any simulated platform write."));
  }
  for (const p of c.proposals) nodes.push(proposalCard(p));
  v.replaceChildren(...nodes);
}

function proposalCard(p) {
  const by = h("input", { id: `by-${p.id}`, value: localStorage.getItem("ms_by") || "", placeholder: "Your name", maxlength: "100" });
  const flags = (p.payload && p.payload.reviewFlags) || [];
  const ack = h("input", { type: "checkbox", id: "ack-" + p.id });
  const decide = (d) => () => {
    if (!by.value.trim()) { showError("Enter your name to record the decision"); return; }
    try { localStorage.setItem("ms_by", by.value.trim()); } catch { /* ignore */ }
    const body = { decidedBy: by.value.trim() };
    if (d === "approve" && flags.length) body.acknowledgedReview = ack.checked;
    act(() => api(`/proposals/${p.id}/${d}`, { method: "POST", body }));
  };
  const pay = p.payload;
  const card = h("div", { class: "card" },
    pill(p.status.replace("_", " "), statusClass(p.status)), " ", p.mode === "mock" ? simBadge() : pill("LIVE", "warn"), " ", h("span", { class: "muted" }, `Action: create PAUSED campaign draft (campaign version ${p.campaignVersion})`),
    kv([
      ["Ad account", pay.accountId], ["External name", pay.name], ["Objective", pay.objective],
      ["Proposed starting budget", `$${(p.plannedDailyBudgetCents / 100).toFixed(2)} per day${pay.budgetCeilingCents ? `, under a ceiling of $${(pay.budgetCeilingCents / 100).toFixed(2)}` : ""} (not sent; the draft is created paused with no budget)`],
    ]),
  );
  if (flags.length) card.append(h("div", { class: "card" }, pill("NEEDS REVIEW", "warn"), h("ul", { class: "plain" }, flags.map((f) => h("li", {}, f)))));
  if (p.status === "proposed") {
    if (flags.length) card.append(h("label", { class: "chk" }, ack, "I read the review reasons above"));
    card.append(h("div", { class: "actions" }, h("label", {}, "Approver", by), h("button", { onclick: decide("approve") }, "Approve"), h("button", { class: "danger", onclick: decide("reject") }, "Reject")));
  }
  if (p.approval) card.append(h("p", { class: "hint" }, `${p.approval.decision === "approve" ? "Approved" : "Rejected"} by ${p.approval.decided_by} at ${p.approval.decided_at}`));
  if (p.attempts.length) {
    card.append(h("table", {}, h("thead", {}, h("tr", {}, ...["Attempt", "Result", "Error"].map((x) => h("th", {}, x)))),
      h("tbody", {}, p.attempts.map((a) => h("tr", {}, h("td", {}, a.attempt_no), h("td", {}, a.status), h("td", {}, a.error_kind ? `${a.error_kind}: ${a.error_message ?? ""}` : "-"))))));
  }
  if (p.externalResource) {
    const e = p.externalResource;
    card.append(h("p", {}, e.simulated ? simBadge() : pill("LIVE", "warn"), " ", `${e.platform} ${e.kind} `, h("strong", {}, e.externalId), ` verified ${e.verifiedState} at ${e.verifiedAt}`));
  }
  if (p.lastError) card.append(h("p", { class: "pill bad" }, `Last error: ${p.lastError}`));
  if (p.status === "needs_review") card.append(h("p", {}, "The outcome could not be confirmed automatically. Check the ad platform before doing anything else; the app will not retry on its own."));
  return card;
}

function renderLeads(leads) {
  const v = $("leads-view");
  const launched = state.campaign?.status === "launched_paused";
  $("lead-btn").disabled = !launched || !!state.config?.live.meta;
  $("lead-hint").textContent = state.config?.live.meta ? "Disabled: synthetic leads are not allowed when Meta is live." : launched ? "" : "Available after the paused draft exists.";
  if (!leads.length) { v.replaceChildren(h("p", { class: "hint" }, "No leads yet.")); return; }
  v.replaceChildren(h("table", {}, h("thead", {}, h("tr", {}, ...["Lead", "Contact", "CRM sync", "CRM contact"].map((x) => h("th", {}, x)))),
    h("tbody", {}, leads.map((l) => h("tr", {},
      h("td", {}, l.fullName, " ", l.simulated ? simBadge() : null),
      h("td", {}, [l.email, l.phone].filter(Boolean).join(" / ")),
      h("td", {}, pill(l.crmStatus, l.crmStatus === "synced" ? "ok" : l.crmStatus === "failed" ? "bad" : "warn"), l.crmError ? ` ${l.crmError}` : ""),
      h("td", {}, l.crmContactId ? `${l.crmContactId} (${l.crmContactCreated ? "created" : "matched existing"})` : "-"))))));
}

function renderActivity(items) {
  $("activity-view").replaceChildren(...(items.length ? items.map((a) => h("div", { class: "log" }, h("time", {}, a.at.replace("T", " ").slice(0, 19)), h("strong", {}, a.type), h("span", { class: "muted" }, `${a.actor}`), h("span", {}, JSON.stringify(a.detail)))) : [h("p", { class: "hint" }, "No activity yet.")]));
}

// ---- data loading ----
async function act(fn) { try { await fn(); } catch { /* error already shown */ } await refresh(); }

async function refresh({ fillForms = false } = {}) {
  if (!session()) { renderCampaign(); renderProposals(); renderLeads([]); renderActivity([]); return; }
  try {
    state.campaigns = await api("/campaigns", { quiet: true });
    if (!state.campaigns.find((c) => c.id === state.campaignId)) state.campaignId = state.campaigns[0]?.id ?? null;
    renderCampaignList();
    state.campaign = state.campaignId ? await api(`/campaigns/${state.campaignId}`, { quiet: true }) : null;
    if (fillForms && state.campaign) fillEditForm(state.campaign);
    renderCampaign(); renderProposals();
    renderLeads(await api("/leads", { quiet: true }));
    renderActivity(await api("/activity", { quiet: true }));
    await aiUi.load();
  } catch (e) { showError(e.message); }
}

async function selectWorkspace(id) {
  state.current = id || null; saveSessions(); state.campaignId = null; state.campaign = null;
  $("brain-form").reset();
  if (session()) {
    state.brainFacts = [];
    try { const b = await api("/brain", { quiet: true }); fillBrainForm(b.brain, b.version); } catch (e) { showError(e.message); }
    try { await aiUi.load({ refillForm: true }); } catch (e) { showError(e.message); }
  }
  await refresh({ fillForms: true });
}

const aiUi = initAi({ $, h, api, state, session, pill, simBadge, showError });

// ---- events ----
$("ws-select").addEventListener("change", (e) => selectWorkspace(e.target.value));
$("campaign-select").addEventListener("change", (e) => { state.campaignId = e.target.value; refresh({ fillForms: true }); });

$("ws-create").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await api("/api/workspaces", { method: "POST", body: { name: e.target.elements.name.value }, scoped: false });
    state.sessions.push({ id: r.workspace.id, name: r.workspace.name, token: r.token });
    e.target.reset(); renderWorkspaces(); await selectWorkspace(r.workspace.id); renderWorkspaces();
  } catch { /* shown */ }
});

$("brain-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = {
    businessName: f.businessName.value, industry: f.industry.value, services: lines(f.services.value), serviceArea: f.serviceArea.value,
    targetCustomer: f.targetCustomer.value, offer: f.offer.value, tone: f.tone.value, differentiators: lines(f.differentiators.value),
    verifiedFacts: lines(f.verifiedFacts.value), unverifiedClaims: lines(f.unverifiedClaims.value), prohibitedClaims: lines(f.prohibitedClaims.value),
    maxDailyBudgetCents: Number(f.maxDailyBudgetCents.value),
  };
  body.facts = state.brainFacts || [];
  if (f.approvedPricing.value.trim()) body.approvedPricing = f.approvedPricing.value.trim();
  if (f.description.value.trim()) body.description = f.description.value.trim();
  try { const r = await api("/brain", { method: "PUT", body }); fillBrainForm(r.brain, r.version); await refresh(); } catch { /* shown */ }
});

$("gen-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("gen-status");
  const btn = e.target.querySelector("button[type=submit]");
  status.textContent = state.config?.ai?.local
    ? "Generating with the local model. On a CPU this can take a few minutes; keep this page open."
    : "Generating...";
  btn.disabled = true;
  try {
    const c = await api("/campaigns/generate", { method: "POST", body: aiUi.generateBody() });
    state.campaignId = c.id;
    await refresh({ fillForms: true });
  } catch { /* shown */ } finally {
    status.textContent = "";
    btn.disabled = false;
  }
});

$("edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.campaign) return;
  const f = e.target.elements;
  const brief = { ...state.campaign.brief, name: f.name.value, dailyBudgetCents: Number(f.dailyBudgetCents.value), headlines: lines(f.headlines.value), primaryTexts: lines(f.primaryTexts.value) };
  try { await api(`/campaigns/${state.campaign.id}/brief`, { method: "PUT", body: brief }); await refresh({ fillForms: true }); } catch { /* shown */ }
});

$("lead-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.campaign) return;
  const f = e.target.elements;
  const body = { fullName: f.fullName.value };
  if (f.email.value.trim()) body.email = f.email.value.trim();
  if (f.phone.value.trim()) body.phone = f.phone.value.trim();
  if (f.eventId.value.trim()) body.eventId = f.eventId.value.trim();
  try {
    const r = await api(`/campaigns/${state.campaign.id}/simulate-lead`, { method: "POST", body });
    if (r.duplicate) showError("Duplicate event: ignored, no second lead or CRM contact was created.");
    await refresh();
  } catch { /* shown */ }
});

// ---- boot ----
async function boot() {
  try { state.config = await api("/api/config", { scoped: false, quiet: true }); } catch (e) { showError(`Cannot reach the server: ${e.message}`); return; }
  renderBanner(); aiUi.renderBanner();
  loadSessions(); renderWorkspaces();
  await selectWorkspace(state.current);
  setInterval(() => { if (!document.hidden) refresh(); }, 1500);
}
boot();
