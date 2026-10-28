import { initAi } from "./ai.js";
import { initActivity } from "./activity.js";
import { initAiTest } from "./aitest.js";
import { initClaimsReview } from "./claims.js";
import { initDashboard } from "./dashboard.js";
import { initGoal } from "./goal.js";
import { initLeads } from "./leads.js";
import { initWorkspaceSettings } from "./workspace.js";
import { initBrand } from "./brand.js";
import { initPlans } from "./plans.js";
import { initCreative } from "./creative.js";
import { initTeam } from "./team.js";
import { initOnboarding } from "./onboarding.js";
import { initProvenance } from "./provenance.js";
import { DEMO_BUSINESS, formatRecoveryCode, parseRecoveryCode } from "./recovery.js";

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

const state = { config: null, sessions: [], current: null, campaigns: [], campaign: null, campaignId: null, dash: null, workspace: null, analysis: null, brainVersion: 0, brainMissing: [], role: null, permissions: null, loading: false, loadError: null };

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

// ---- authentication boundary ----
// Workspace routes are authenticated by the workspace token today (a documented, temporary mechanism). OpenID Connect sign-in
// is NOT implemented in this UI: it needs an identity provider that has not been selected or deployed (docs/milestone-4-auth.md).
// When it is, the sign-in flow and the bearer header for a signed-in person belong in this one object, the workspace token and its
// localStorage copy are removed, and nothing else in this file changes. The server already reports its mode at /api/config (auth.mode).
const Auth = {
  header: (session) => `Bearer ${session.token}`,
};

// ---- API ----
function showError(msg) {
  const box = $("errors");
  box.hidden = !msg;
  box.textContent = msg || "";
}
// ---- pending actions: the same action cannot be started twice while it is running ----
const busy = new Set();
function setBusy(controls, on) {
  for (const el of controls) {
    if (!el) continue;
    el.disabled = on || el.dataset.denied === "1"; // a control the role may not use stays disabled when its action ends
    el.setAttribute("aria-busy", on ? "true" : "false");
    if (el.dataset.idleLabel === undefined) el.dataset.idleLabel = el.textContent;
    if (el.dataset.busyLabel) el.textContent = on ? el.dataset.busyLabel : el.dataset.idleLabel;
  }
}
// ---- what the signed-in role may do: the server derives it and the screen only SHOWS it (every route is still checked on the server) ----
/** True when the role allows it. Before the workspace has loaded nothing is hidden, and the server decides anyway. */
const can = (permission) => state.permissions === null || state.permissions.includes(permission);
const ROLE_LABEL = { viewer: "viewer", operator: "operator", admin: "admin", owner: "owner" };
const DENIED_TEXT = {
  "brain.write": "You can read the Business Brain, but your role does not allow changing it. Ask an admin or owner.",
  "campaigns.generate": "You can read campaigns, but your role does not allow creating or editing them. Ask an operator, admin or owner.",
  "proposals.decide": "Only an admin or owner can approve or reject a proposal. Your role can look, and an operator can propose.",
  "plans.write": "You can look at plans, but your role does not allow asking for one or changing it. Ask an operator, admin or owner.",
  "brandkit.write": "You can read the Brand Kit, but your role does not allow changing it. Ask an operator, admin or owner.",
  "creatives.write": "You can look at creatives, but your role does not allow making or editing them. Ask an operator, admin or owner.",
  "tasks.write": "You can look at the inbox and calendar, but your role does not allow adding or changing tasks. Ask an operator, admin or owner.",
  "assignments.manage": "Only an admin or owner can set who owns and reviews a campaign.",
  "assets.write": "You can look at the assets, but your role does not allow uploading them. Ask an operator, admin or owner.",
  "proposals.execute": "Approving does not run anything. Someone allowed to run approved actions (an admin or owner, or a custom role with that permission) has to press Run.",
  "leads.simulate": "Your role does not allow adding test leads. Ask an operator, admin or owner.",
  "ai.settings.write": "Your role does not allow changing AI settings or running AI tests. Ask an admin or owner.",
};
function applyPermissions() {
  const pill = $("role-pill");
  pill.hidden = !state.role;
  if (state.role) pill.textContent = `Your role: ${ROLE_LABEL[state.role] || state.role}`;
  for (const el of document.querySelectorAll("[data-needs]")) {
    const denied = !can(el.dataset.needs);
    const wasDenied = el.dataset.denied === "1";
    el.dataset.denied = denied ? "1" : "";
    if (denied) el.disabled = true; else if (wasDenied) el.disabled = false; // other reasons for a control being off are re-applied by the view that owns it
    if (denied) el.setAttribute("title", "Your role does not allow this."); else el.removeAttribute("title");
  }
  for (const note of document.querySelectorAll(".role-note")) {
    const p = note.dataset.for;
    note.textContent = can(p) ? "" : DENIED_TEXT[p] || "Your role does not allow this.";
    note.hidden = can(p);
  }
}

async function once(key, controls, fn) {
  if (busy.has(key)) return undefined; // already running: a repeat click or Enter does nothing
  busy.add(key);
  setBusy(controls, true);
  try { return await fn(); } finally {
    busy.delete(key); setBusy(controls, false);
    // A redraw during the action rebuilt the card while the key was still busy (its buttons were drawn disabled); draw it again now that the action is over.
    if (state.campaign) renderProposals();
  }
}

// Informational and success messages (errors use showError). Text comes from what the server answered, never from an assumption.
let noticeTimer;
function showNotice(msg) {
  const box = $("notice");
  box.textContent = msg || "";
  box.hidden = !msg;
  clearTimeout(noticeTimer);
  if (msg) noticeTimer = setTimeout(() => { box.hidden = true; }, 7000);
}

async function api(path, { method = "GET", body, scoped = true, quiet = false } = {}) {
  const s = session();
  const headers = { "content-type": "application/json" };
  let url = path;
  if (scoped) {
    if (!s) {
      const msg = "Create or select a workspace first";
      if (!quiet) showError(msg); // callers swallow this error on the assumption it was already shown
      throw new Error(msg);
    }
    url = `/api/workspaces/${s.id}${path}`;
    headers.authorization = Auth.header(s);
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
  state.brainVersion = brain ? version : 0;
  if (!brain) { $("brain-version").textContent = "Not saved yet"; provUi?.render(null); return; }
  $("brain-details").open = true; // there is something to review
  for (const k of ["businessName", "industry", "serviceArea", "targetCustomer", "offer", "tone", "maxDailyBudgetCents"]) f.elements[k].value = brain[k];
  f.elements.services.value = brain.services.join("\n");
  f.elements.differentiators.value = brain.differentiators.join("\n");
  f.elements.verifiedFacts.value = (brain.verifiedFacts || []).join("\n");
  f.elements.approvedPricing.value = brain.approvedPricing || "";
  f.elements.unverifiedClaims.value = (brain.unverifiedClaims || []).join("\n");
  f.elements.prohibitedClaims.value = (brain.prohibitedClaims || []).join("\n");
  f.elements.description.value = brain.description || "";
  state.brainFacts = brain.facts || []; // records with provenance are not editable in this form, but must survive a save
  claimsUi?.render();
  updateBrainMissing();
  $("brain-version").textContent = `Saved (version ${version})`;
  provUi?.load();
}

function fillEditForm(c) {
  const f = $("edit-form");
  f.elements.name.value = c.brief.name;
  f.elements.dailyBudgetCents.value = c.brief.dailyBudgetCents;
  f.elements.headlines.value = c.brief.headlines.join("\n");
  f.elements.primaryTexts.value = c.brief.primaryTexts.join("\n");
}

// Dashboard, campaign list, operations and integrations are re-drawn only when their data changed, so a click or keyboard focus is not lost on every poll.
let lastViewsKey = "";
function renderDashboardViews() {
  const key = JSON.stringify([state.loading, state.loadError, state.role, state.dash, state.campaignId, state.workspace?.id, state.config?.mode, state.brainVersion, state.analysis?.id, state.analysis?.status, state.current, state.brainMissing, state.analysis?.insights?.filter((i) => i.status === "proposed").length, state.campaign?.brief?.openQuestions?.length], (k, v) => (k === "generatedAt" ? undefined : v));
  if (key === lastViewsKey) return;
  lastViewsKey = key;
  updateGenHint();
  if (state.loadError && !state.dash) { dashUi.renderError(state.loadError, () => { state.loadError = null; state.loading = true; renderDashboardViews(); refresh(); }); return; }
  if (state.loading && !state.dash) { dashUi.renderLoading(); return; }
  dashUi.renderPath(state);
  dashUi.renderDashboard(state.dash);
  dashUi.renderCampaignList(state.dash);
  dashUi.renderOps(state.dash, state.role);
  dashUi.renderIntegrations(state.dash, state.workspace);
}

const usd = (cents) => "$" + (cents / 100).toFixed(2);
const list = (items, empty) => (items && items.length ? h("ul", { class: "plain" }, items.map((x) => h("li", {}, x))) : h("span", { class: "muted" }, empty));

/** Archive (any campaign not queued to run) and Complete (a campaign that was run): explicit, audited, and the server refuses an invalid change. */
function lifecycleButtons(c) {
  if (!c.lifecycle || !can("campaigns.archive")) return null;
  const s = c.lifecycle.state, kids = [];
  const go = (path, ok) => () => once("life-" + path + c.id, [], () => act(async () => { await api("/campaigns/" + c.id + path, { method: "POST" }); showNotice(ok); }));
  if (s === "executed_simulated" || s === "executed_external") kids.push(h("button", { type: "button", class: "secondary", onclick: go("/complete", "Marked completed.") }, "Mark completed"));
  if (!["archived", "ready_for_execution"].includes(s)) kids.push(h("button", { type: "button", class: "secondary", onclick: go("/archive", "Archived.") }, "Archive this campaign"));
  return kids.length ? h("div", { class: "actions" }, ...kids) : null;
}

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
    ...(t.basis !== "owner_provided" && !(t.needsFromOwner && t.needsFromOwner.length) ? [["Tip", "To narrow who sees your ads, describe your best customers under My business > Target customer (for example, homeowners aged 35 to 65 in these towns). Until then targeting stays broad."]] : []),
    ["Settings the platform can apply", b.audience.locations.join(", ") + ", ages " + b.audience.ageMin + "-" + b.audience.ageMax + (b.audience.interests.length ? "; interests: " + b.audience.interests.join(", ") : "; no interest targeting")],
  ];

  const decisions = (b.differentiatorDecisions || []).map((d) => h("li", {}, pill(d.used ? "used" : "held back", d.used ? "ok" : ""), " " + d.differentiator + (d.reason ? " (" + d.reason + ")" : "")));
  const questions = (b.openQuestions || []).map((q) => h("li", {}, q.blocking ? pill("BLOCKS LAUNCH", "bad") : pill("question", "warn"), " ", h("strong", {}, q.question), q.impact ? h("div", { class: "hint" }, "Why it matters: " + q.impact) : null));
  const checks = (c.platformValidation || []).map((k) => h("li", {}, pill(k.pass ? "pass" : "fail", k.pass ? "ok" : "bad"), " " + k.label + ": ", h("span", { class: "muted" }, k.detail)));

  v.replaceChildren(
    h("div", { class: "card" },
      h("strong", {}, b.name), " ", pill(c.status === "draft" ? "draft (nothing external)" : "paused draft launched", c.status === "draft" ? "" : "ok"), " ", pill("version " + c.currentVersion),
      c.lifecycle ? [" ", pill(c.lifecycle.label, ["draft", "needs_review"].includes(c.lifecycle.state) ? "warn" : c.lifecycle.state === "archived" ? "" : "ok")] : null,
      c.marketingPlan ? h("p", { class: "hint" }, `Part of the plan "${c.marketingPlan.name}": ${c.marketingPlan.plannedShareCents == null ? "no planned share set" : "planned share " + usd(c.marketingPlan.plannedShareCents) + " per day"}, plan total ${c.marketingPlan.totalDailyCents == null ? "not set" : usd(c.marketingPlan.totalDailyCents) + " per day"}. ${c.marketingPlan.reviewDone ? "The plan budget has been reviewed." : "The plan budget still needs a review before this campaign can be proposed."}`) : null,
      lifecycleButtons(c),
      c.plan ? kv([["Your goal", c.plan.goalLabel + (c.plan.focusService ? ": " + c.plan.focusService : "") + (c.plan.durationDays ? ", about " + c.plan.durationDays + " days" : "")]]) : h("p", { class: "hint" }, "No goal was recorded with this draft."),
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
      h("h3", {}, "Version history"),
      h("ul", { class: "plain version-history" }, (c.versionHistory || []).map((x) => {
        const v = c.versions.find((y) => y.version === x.version);
        const who = x.source === "ai" ? "Written by AI (" + (v?.aiProvider || "?") + "/" + (v?.aiModel || "?") + ")" : "Edited by a person";
        return h("li", {}, h("strong", {}, "Version " + x.version + (x.version === c.currentVersion ? " (current)" : "")), " ", h("span", { class: "muted" }, who + ", " + new Date(x.createdAt).toLocaleString()),
          x.version === 1 ? h("div", { class: "hint" }, "First version.") : x.changes.length
            ? h("ul", { class: "plain" }, x.changes.map((ch) => h("li", {}, h("strong", {}, ch.label + ": "), h("span", { class: "muted" }, "was "), ch.from, h("span", { class: "muted" }, " → now "), ch.to)))
            : h("div", { class: "hint" }, "Saved with no changes."));
      })),
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
    const key = `propose:${c.id}`;
    const propose = h("button", { type: "button", disabled: busy.has(key) || !can("proposals.create"), title: can("proposals.create") ? null : "Your role does not allow this.", onclick: () => once(key, [propose], () => act(() => api(`/campaigns/${c.id}/proposals`, { method: "POST", body: {} }))) }, "Propose a paused draft on the ad platform");
    nodes.push(propose);
    nodes.push(h("p", { class: "hint" }, "Proposing changes nothing outside this app. An explicit approval is required before any simulated platform write."));
  }
  for (const p of c.proposals) nodes.push(proposalCard(p));
  v.replaceChildren(...nodes);
}

function proposalCard(p) {
  const by = h("input", { id: `by-${p.id}`, value: localStorage.getItem("ms_by") || "", placeholder: "Your name", maxlength: "100" });
  const flags = (p.payload && p.payload.reviewFlags) || [];
  const ack = h("input", { type: "checkbox", id: "ack-" + p.id });
  const key = `decide:${p.id}`;
  let approveBtn, rejectBtn;
  const decide = (d) => () => {
    if (!by.value.trim()) { showError("Enter your name to record the decision"); return; }
    try { localStorage.setItem("ms_by", by.value.trim()); } catch { /* ignore */ }
    // The proposal list is not redrawn while an input in it has focus (so typing is never clobbered). A decision is done typing: release the focus,
    // otherwise the card would keep showing the old status in browsers that do not move focus to a clicked button (Safari).
    by.blur();
    ack.blur();
    const body = { decidedBy: by.value.trim() };
    if (d === "approve" && flags.length) body.acknowledgedReview = ack.checked;
    return once(key, [approveBtn, rejectBtn], () => act(() => api(`/proposals/${p.id}/${d}`, { method: "POST", body })));
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
  if (p.status === "proposed" && p.budgetImpact && p.budgetImpact.ceilingCents != null) {
    const bi = p.budgetImpact;
    card.append(h("p", { class: bi.wouldFit ? "hint" : "flag-note" }, bi.blocked ? "A budget already committed cannot be read as a daily amount, so the remaining limit cannot be worked out. It must be reviewed before anything else is approved." : `Approving this commits ${usd(bi.requestedCents)} per day. ${usd(bi.committedCents)} of your ${usd(bi.ceilingCents)} daily limit is already committed, leaving ${usd(bi.availableCents)}.${bi.wouldFit ? "" : " It does not fit: approving it will be refused until something is archived or completed, or the limit is raised."}`));
  }
  if (p.status === "proposed") {
    if (flags.length) card.append(h("label", { class: "chk" }, ack, "I read the review reasons above"));
    if (!can("proposals.decide")) {
      card.append(h("p", { class: "flag-note" }, DENIED_TEXT["proposals.decide"]));
    } else card.append(h("div", { class: "actions" }, h("label", {}, "Approver (a typed note; the server records who actually signed in)", by), (approveBtn = h("button", { type: "button", disabled: busy.has(key), onclick: decide("approve") }, "Approve")), (rejectBtn = h("button", { type: "button", class: "danger", disabled: busy.has(key), onclick: decide("reject") }, "Reject"))));
  }
  if (p.approval) card.append(h("p", { class: "hint" }, `${p.approval.decision === "approve" ? "Approved" : "Rejected"} by ${p.approval.decided_by}${p.approval.claimed_label ? ` (typed name, not verified: ${p.approval.claimed_label})` : ""} at ${p.approval.decided_at}`));
  const SEPARATION = {
    enforced: "A different person approved this: separation of duties was enforced.",
    not_enforceable_token_mode: "Local sign-in is in use: everyone shares one access token, so the app cannot tell who proposed and who approved. Separation of duties is NOT enforced here (it needs real sign-in).",
    policy_off: "Separation of duties is switched off for this workspace, so the proposer could approve.",
  };
  if (p.approval && p.approval.decision === "approve" && SEPARATION[p.approval.separation]) card.append(h("p", { class: p.approval.separation === "enforced" ? "hint" : "flag-note" }, SEPARATION[p.approval.separation]));
  if (p.status === "approved") {
    // Approving does not run anything: running is its own step with its own permission.
    const runKey = `run:${p.id}`;
    let runBtn;
    card.append(h("p", {}, pill("NOT RUN YET", "warn"), " Approved, but nothing has happened. ", p.mode === "mock" ? "Running creates a PAUSED draft in the simulator only." : "Running creates a PAUSED draft on the real ad platform."));
    if (!can("proposals.execute")) card.append(h("p", { class: "flag-note" }, DENIED_TEXT["proposals.execute"]));
    else card.append(h("div", { class: "actions" }, (runBtn = h("button", { type: "button", disabled: busy.has(runKey), onclick: () => once(runKey, [runBtn], () => act(() => api(`/proposals/${p.id}/execute`, { method: "POST" }))) }, p.mode === "mock" ? "Run (simulated)" : "Run"))));
  }
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
  $("lead-btn").disabled = !launched || !!state.config?.live.meta || busy.has("lead") || $("lead-btn").dataset.denied === "1";
  $("lead-hint").textContent = state.config?.live.meta ? "Disabled: synthetic leads are not allowed when Meta is live." : launched ? "" : "Available after the paused draft exists.";
  leadsUi.render(leads);
}

function renderActivity(items) { activityUi.render(items); }

// ---- data loading ----
async function act(fn) { try { await fn(); } catch { /* error already shown */ } await refresh(); plansUi.load(); teamUi.load(); /* a campaign change can change its plan (budget sum, review) */ }

async function refresh({ fillForms = false } = {}) {
  if (!session()) { state.dash = null; state.campaigns = []; renderDashboardViews(); renderCampaign(); renderProposals(); renderLeads([]); renderActivity([]); return; }
  try {
    state.dash = await api("/dashboard", { quiet: true }); // one summary: campaigns, approvals, failures, jobs, usage, integrations
    state.loadError = null; state.loading = false;
    state.campaigns = state.dash.campaigns.list;
    if (!state.campaigns.find((c) => c.id === state.campaignId)) state.campaignId = state.campaigns[0]?.id ?? null;
    renderDashboardViews();
    state.campaign = state.campaignId ? await api(`/campaigns/${state.campaignId}`, { quiet: true }) : null;
    if (fillForms && state.campaign) fillEditForm(state.campaign);
    renderCampaign(); renderProposals();
    renderLeads(await api("/leads", { quiet: true }));
    renderActivity(await api("/activity", { quiet: true }));
    await aiUi.load();
  } catch (e) { state.loading = false; state.loadError = e.message; showError(e.message); renderDashboardViews(); }
}

// Scrolling is a convenience: where the browser cannot do it, the action still completes.
function scrollToEl(el, block) { if (typeof el.scrollIntoView === "function") el.scrollIntoView({ behavior: "smooth", block }); }

async function selectWorkspace(id) {
  state.current = id || null; saveSessions(); state.campaignId = null; state.campaign = null; state.dash = null; state.workspace = null; state.brainVersion = 0; state.role = null; state.permissions = null; state.loadError = null; state.loading = !!session();
  applyPermissions();
  $("brain-form").reset();
  claimsUi.render();
  updateBrainMissing();
  $("brain-details").open = false;
  if (session()) {
    state.brainFacts = [];
    try { state.workspace = await api("", { quiet: true }); state.role = state.workspace.role ?? null; state.permissions = Array.isArray(state.workspace.permissions) ? state.workspace.permissions : null; applyPermissions(); } catch { /* shown by the next call if the session is bad */ }
    try { const b = await api("/brain", { quiet: true }); fillBrainForm(b.brain, b.version); } catch (e) { showError(e.message); }
    try { await aiUi.load({ refillForm: true }); } catch (e) { showError(e.message); }
  }
  await onboardUi.load();
  if (session()) aiTestUi.load();
  await refresh({ fillForms: true });
  settingsUi.load();
  brandUi.load();
  plansUi.load();
  creativeUi.load();
  teamUi.load();
}

async function retryJob(id, button) {
  await once("job-retry-" + id, [button], async () => {
    try { await api(`/jobs/${id}/retry`, { method: "POST" }); showNotice("The job was put back in the queue."); } catch { /* shown */ }
    await refresh();
  });
}

async function openCampaign(id) {
  state.campaignId = id;
  await refresh({ fillForms: true });
  scrollToEl($("campaign-view"), "start");
}
async function goProposal(id) {
  state.campaignId = id;
  await refresh({ fillForms: true });
  scrollToEl($("s-launch"), "start");
}
const dashUi = initDashboard({ $, h, pill, simBadge, usd, state, openCampaign, goProposal, can, retryJob });
const aiUi = initAi({ $, h, api, state, session, pill, simBadge, showError, once });
const claimsUi = initClaimsReview({ $, h, pill });
const provUi = initProvenance({ $, h, api, pill });
const goalUi = initGoal({ $, h });
const settingsUi = initWorkspaceSettings({ $, h, api, state, can, once, pill, simBadge, showNotice, session });
// A file is fetched with the same credentials as every other call, then drawn on a canvas: no image URL (and no blob: URL) is ever needed.
const fetchFile = async (path) => { const s = session(); const res = await fetch(`/api/workspaces/${s.id}${path}`, { headers: { authorization: Auth.header(s) } }); if (!res.ok) throw new Error("file unavailable"); return res.blob(); };
const plansUi = initPlans({ $, h, api, state, can, once, pill, usd, showNotice, openCampaign: (id) => openCampaign(id), session, reloadCampaigns: () => refresh() });
const teamUi = initTeam({ $, h, api, state, can, once, pill, showNotice, session });
const creativeUi = initCreative({ $, h, api, state, can, once, pill, showNotice, session, fetchFile });
const brandUi = initBrand({ $, h, api, state, can, once, pill, simBadge, showNotice, session, fetchFile });
const leadsUi = initLeads({ $, h, api, pill, simBadge, can, once, showNotice, state, reload: async () => { if (session()) renderLeads(await api("/leads", { quiet: true })); } });
const activityUi = initActivity({ $, h, pill, simBadge, state });
const onboardUi = initOnboarding({ $, h, api, state, showNotice, once, pill, simBadge, can, onFormChanged: () => { claimsUi.render(); updateBrainMissing(); renderDashboardViews(); refreshDashIfAnalysisChanged(); } });
const aiTestUi = initAiTest({ $, h, api, once, pill, simBadge });
$("dev-mode").addEventListener("toggle", () => { if ($("dev-mode").open && session()) aiTestUi.load(); });

// ---- navigation: highlights the section being read (links are plain in-page anchors, so they work without this) ----
function initNav() {
  const links = [...document.querySelectorAll("#main-nav a")];
  const ids = links.map((a) => a.getAttribute("href").slice(1));
  const mark = (id) => links.forEach((a) => a.setAttribute("aria-current", a.getAttribute("href") === `#${id}` ? "true" : "false"));
  mark(ids[0]);
  if (!("IntersectionObserver" in window)) return;
  const inBand = new Set();
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) (en.isIntersecting ? inBand.add(en.target.id) : inBand.delete(en.target.id));
    const current = ids.filter((id) => inBand.has(id)).at(-1);
    if (current) mark(current);
  }, { rootMargin: "-130px 0px -65% 0px", threshold: 0 });
  for (const id of ids) { const el = document.getElementById(id); if (el) io.observe(el); }
  for (const a of links) a.addEventListener("click", () => mark(a.getAttribute("href").slice(1)));
}

// ---- events ----
$("ws-select").addEventListener("change", (e) => selectWorkspace(e.target.value));

// The recovery code is shown once, in this panel, and removed from the page when dismissed. It is never logged and never put in an address.
function showRecoveryCode(code) {
  const input = $("token-code");
  input.value = code;
  input.type = "password";
  $("token-show").textContent = "Show";
  $("token-status").textContent = "";
  $("token-panel").hidden = false;
  scrollToEl($("token-panel"), "nearest");
}
function dismissRecoveryCode() {
  $("token-code").value = "";
  $("token-code").type = "password";
  $("token-status").textContent = "";
  $("token-panel").hidden = true;
}
$("token-show").addEventListener("click", () => {
  const input = $("token-code");
  const hide = input.type === "text";
  input.type = hide ? "password" : "text";
  $("token-show").textContent = hide ? "Show" : "Hide";
});
$("token-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("token-code").value);
    $("token-status").textContent = "Copied to the clipboard. Paste it somewhere safe.";
  } catch {
    $("token-status").textContent = "Could not copy automatically. Press Show, then select the code and copy it yourself.";
  }
});
$("token-dismiss").addEventListener("click", dismissRecoveryCode);

$("ws-create").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  await once("ws-create", [form.querySelector("button[type=submit]")], async () => {
    try {
      const r = await api("/api/workspaces", { method: "POST", body: { name: form.elements.name.value }, scoped: false });
      state.sessions.push({ id: r.workspace.id, name: r.workspace.name, token: r.token });
      form.reset();
      renderWorkspaces();
      showRecoveryCode(formatRecoveryCode(r.workspace.id, r.token));
      await selectWorkspace(r.workspace.id);
      renderWorkspaces();
    } catch { /* shown */ }
  });
});

// Open an existing workspace from its recovery code. The server decides: a wrong code and an unknown workspace get the same answer.
$("ws-open").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const field = form.elements.code;
  await once("ws-open", [form.querySelector("button[type=submit]")], async () => {
    const parsed = parseRecoveryCode(field.value);
    if (!parsed) { showError("That recovery code is not in the right format. It looks like ws_...:msw_... and is shown once when a workspace is created."); return; }
    let res;
    try { res = await fetch(`/api/workspaces/${parsed.workspaceId}`, { headers: { authorization: Auth.header({ token: parsed.token }) } }); } catch { showError("Could not reach the server."); return; }
    if (!res.ok) { showError("That recovery code was not accepted by this server."); return; }
    const w = await res.json();
    const existing = state.sessions.find((x) => x.id === parsed.workspaceId);
    if (existing) existing.token = parsed.token; else state.sessions.push({ id: parsed.workspaceId, name: w.name, token: parsed.token });
    field.value = "";
    showError("");
    renderWorkspaces();
    await selectWorkspace(parsed.workspaceId);
    renderWorkspaces();
    showNotice(`Opened workspace “${w.name}”.`);
  });
});

// Demo data fills the FORM only; nothing is saved until the person presses Save.
let demoArmed = false;
$("brain-demo").addEventListener("click", () => {
  const f = $("brain-form").elements;
  const btn = $("brain-demo");
  const hasOwnText = ["businessName", "industry", "services", "serviceArea", "targetCustomer", "offer"].some((k) => f[k].value.trim()) && f.businessName.value !== DEMO_BUSINESS.businessName;
  if (hasOwnText && !demoArmed) {
    demoArmed = true;
    btn.textContent = "Click again to replace the form with demo data";
    setTimeout(() => { demoArmed = false; btn.textContent = "Load demo business"; }, 6000);
    return;
  }
  demoArmed = false;
  btn.textContent = "Load demo business";
  const d = DEMO_BUSINESS;
  for (const k of ["businessName", "industry", "serviceArea", "targetCustomer", "offer", "tone", "approvedPricing", "description"]) f[k].value = d[k];
  for (const k of ["services", "differentiators", "verifiedFacts", "unverifiedClaims", "prohibitedClaims"]) f[k].value = d[k].join("\n");
  f.maxDailyBudgetCents.value = String(d.maxDailyBudgetCents);
  $("brain-details").open = true;
  claimsUi.render();
  $("brain-version").textContent = "Demo data loaded: review it, then press Save Business Brain.";
  showNotice(session() ? "Demo business loaded into the form. It is fictional and is not saved until you press Save." : "Demo business loaded into the form. Create or open a workspace before you save it.");
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
  await once("brain", [e.target.querySelector("button[type=submit]")], async () => {
    try { const r = await api("/brain", { method: "PUT", body }); fillBrainForm(r.brain, r.version); showNotice(`Business Brain saved (version ${r.version}).`); await refresh(); } catch { /* shown */ }
  });
});

/** The Business Brain field that holds a line the campaign checker quoted, so the person knows what to fix. */
function whereInBrain(message) {
  const quoted = [...message.matchAll(/\("([^"]{8,300})"\)/g)].map((m) => m[1].trim().toLowerCase().replace(/\s+/g, " "));
  if (!quoted.length) return "";
  const labels = { businessName: "Business name", industry: "Industry", services: "Services", serviceArea: "Service area", targetCustomer: "Target customer", offer: "Offer", tone: "Tone", differentiators: "Approved differentiators", verifiedFacts: "Other verified facts", approvedPricing: "Approved pricing statement", unverifiedClaims: "Claims you have not verified", prohibitedClaims: "Things ads must never say", description: "Business description" };
  const f = $("brain-form").elements;
  const found = new Set();
  for (const [k, label] of Object.entries(labels)) {
    const v = String(f[k]?.value || "").toLowerCase().replace(/\s+/g, " ");
    if (quoted.some((q) => v.includes(q.replace(/[.]+$/, "")))) found.add(label);
  }
  if ((state.brainFacts || []).some((x) => quoted.some((q) => String(x.text).toLowerCase().includes(q.replace(/[.]+$/, ""))))) found.add("the saved website records (press Fill my Business Brain from these findings again to rebuild them)");
  return [...found].join(", ");
}

// The server builds the attention list from stored data, so when the analysis or the owner's decisions on it change, ask for the figures again straight away
// (instead of waiting for the next regular refresh).
let lastAnalysisSig = "";
async function refreshDashIfAnalysisChanged() {
  const a = state.analysis;
  const sig = a ? `${a.id}|${a.status}|${a.insights.filter((i) => i.status === "proposed").length}` : "";
  if (sig === lastAnalysisSig || !session()) return;
  lastAnalysisSig = sig;
  try { state.dash = await api("/dashboard", { quiet: true }); renderDashboardViews(); } catch { /* the regular refresh will show the problem */ }
}

/** The required Business Brain fields that are still empty, by their plain names (for "what is missing" on Home). */
function updateBrainMissing() {
  const f = $("brain-form").elements;
  const need = [["businessName", "business name"], ["industry", "type of business"], ["services", "services"], ["serviceArea", "where you work"], ["targetCustomer", "who you serve"], ["offer", "your offer"]];
  const missing = need.filter(([k]) => !String(f[k].value || "").trim()).map(([, label]) => label);
  if (JSON.stringify(missing) !== JSON.stringify(state.brainMissing)) { state.brainMissing = missing; renderDashboardViews(); }
}
$("brain-form").addEventListener("input", updateBrainMissing);

// Shown next to the button, so it is clear why a draft cannot be created yet
function updateGenHint() { $("gen-hint").hidden = !session() || state.brainVersion > 0; }

$("gen-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("gen-status");
  const btn = e.target.querySelector("button[type=submit]");
  $("gen-error").textContent = "";
  if (!session()) { $("gen-error").textContent = "Create or open a workspace first (on Home)."; return; }
  await once("generate", [btn], async () => {
    status.textContent = state.config?.ai?.local
      ? "Generating with the local model. On a CPU this can take a few minutes; keep this page open."
      : "Generating...";
    try {
      const c = await api("/campaigns/generate", { method: "POST", body: { ...aiUi.generateBody(), ...goalUi.body() } });
      state.campaignId = c.id;
      await refresh({ fillForms: true });
      showNotice("Your campaign draft was created. It is only a plan: nothing is sent anywhere until you approve it.");
      scrollToEl($("campaign-view"), "start");
    } catch (err) {
      // the server's answer, next to the button (and in the top bar). A missing Business Brain is the usual reason: say where to fix it.
      const missingBrain = /Save the Business Brain before/i.test(err.message);
      const grounding = /grounding_ambiguous|failed validation/i.test(err.message);
      const where = grounding ? whereInBrain(err.message) : "";
      $("gen-error").textContent = missingBrain ? "Your Business Brain is not saved yet. Review it under My business and press Save Business Brain first, then try again."
        : grounding ? `${err.message}\n\n${where ? `The text it objects to is in: ${where}. Remove or reword that line, then press Save Business Brain and try again.` : "What to do: open My business and check that Offer is a short offer such as “Free estimate” (not a whole sentence), and that each strength or fact is something you can stand behind. Press Save Business Brain, then try again."}` : err.message;
      if (missingBrain) { $("brain-details").open = true; scrollToEl($("s-brain"), "start"); }
    } finally {
      status.textContent = "";
    }
  });
});

$("edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.campaign) { showError("Select a campaign first"); return; }
  const f = e.target.elements;
  const brief = { ...state.campaign.brief, name: f.name.value, dailyBudgetCents: Number(f.dailyBudgetCents.value), headlines: lines(f.headlines.value), primaryTexts: lines(f.primaryTexts.value) };
  await once("edit", [e.target.querySelector("button[type=submit]")], async () => {
    $("edit-status").textContent = "";
    try {
      const saved = await api(`/campaigns/${state.campaign.id}/brief`, { method: "PUT", body: brief });
      await refresh({ fillForms: true });
      $("edit-status").textContent = `Saved as version ${saved.currentVersion}.`;
    } catch { /* shown */ }
  });
});

$("lead-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.campaign) { showError("Select a campaign first"); return; }
  const f = e.target.elements;
  const body = { fullName: f.fullName.value };
  if (f.email.value.trim()) body.email = f.email.value.trim();
  if (f.phone.value.trim()) body.phone = f.phone.value.trim();
  if (f.eventId.value.trim()) body.eventId = f.eventId.value.trim();
  await once("lead", [$("lead-btn")], async () => {
    try {
      const r = await api(`/campaigns/${state.campaign.id}/simulate-lead`, { method: "POST", body });
      showNotice(r.duplicate
        ? "Duplicate event: ignored. No second lead or CRM contact was created."
        : "Lead received. The simulated CRM sync runs in the background; its status appears in the table.");
      await refresh();
    } catch { /* shown */ }
  });
});

// ---- boot ----
async function boot() {
  initNav();
  try { state.config = await api("/api/config", { scoped: false, quiet: true }); } catch (e) { showError(`Cannot reach the server: ${e.message}`); return; }
  renderBanner(); aiUi.renderBanner();
  loadSessions(); renderWorkspaces();
  await selectWorkspace(state.current);
  setInterval(() => { if (!document.hidden) refresh(); }, 1500);
}
boot();
