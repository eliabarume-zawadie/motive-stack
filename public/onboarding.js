// "Understand my business": the website question, the safe website analysis, the review of what was found, and the short questionnaire for a
// business with no website. Nothing found here becomes part of the Business Brain until the person approves it AND presses Save on the Business
// Brain form. Everything shown is built with textContent (via h()), and website text is only ever displayed, never interpreted.

import { isDemoText } from "./recovery.js";
import { revealEl } from "./pages.js";

const OB_GROUPS = [
  { basis: "found_on_site", title: "Found on your website", hint: "These come from your own pages. Each one shows the words we found and where." },
  { basis: "ai_interpretation", title: "Suggestions from the AI", simTitle: "Suggestions from the wording of your site", hint: "These are the AI's conclusions, not facts from your site. Keep only what is true for your business.", simHint: "These are worked out by simple word rules from your pages (no AI), for example the tone. Keep only what is true for your business." },
  { basis: "needs_confirmation", title: "Questions only you can answer", hint: "Not found, or unclear, on the site. Answer them in the business details below." },
];
const OB_REQUIRED = [["businessName", "business name"], ["industry", "type of business"], ["services", "services"], ["serviceArea", "where you work"], ["targetCustomer", "who you serve"], ["offer", "your offer"]];
const OB_DEFAULT_TONE = "friendly and professional";

export function initOnboarding({ $, h, api, state, showNotice, once, pill, simBadge, can = () => true, onFormChanged = () => {} }) {
  let pollTimer = null;
  let editing = null; // id of the finding being edited
  let lastFill = null; // what the last "fill from findings" did, kept visible while the results are redrawn
  const stamp = (iso) => (iso ? new Date(iso).toLocaleString() : "");
  const pathOf = (u) => { try { const x = new URL(u); return x.pathname === "/" ? x.hostname : x.hostname + x.pathname; } catch { return String(u); } };
  const safeHref = (u) => (/^https?:\/\//i.test(u) ? u : null);
  const lines = (s) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  const say = (id, msg) => { const el = $(id); el.textContent = msg || ""; el.hidden = !msg; };

  function chooseSite(which) { // "yes", "no", or anything else for neither
    $("site-yes").hidden = which !== "yes";
    $("site-no").hidden = which !== "no";
    $("site-has-yes").checked = which === "yes";
    $("site-has-no").checked = which === "no";
  }

  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
  function poll(wsId, id) {
    stopPolling();
    pollTimer = setTimeout(async () => {
      if (state.current !== wsId) return;
      try {
        const r = await api(`/website-analyses/${id}`, { quiet: true });
        state.analysis = r.analysis;
      } catch { stopPolling(); return; }
      render();
      if (state.analysis && state.analysis.status === "running") poll(wsId, id);
    }, 1200);
  }

  /** Called when a workspace is selected: shows its latest analysis, if any. */
  async function load() {
    stopPolling();
    state.analysis = null;
    editing = null;
    lastFill = null;
    say("site-msg", "");
    $("site-url").value = "";
    chooseSite(null);
    if (state.current) {
      try { state.analysis = (await api("/website-analyses/latest", { quiet: true })).analysis; } catch { /* no workspace or no access: the section just stays empty */ }
    }
    if (state.analysis) {
      if (!$("site-url").value) $("site-url").value = state.analysis.url;
      chooseSite("yes");
      if (state.analysis.status === "running") poll(state.current, state.analysis.id);
    }
    render();
  }

  async function start(refresh) {
    const url = $("site-url").value.trim();
    say("site-msg", "");
    if (!url) { say("site-msg", "Type your website address first, for example www.example.com"); return; }
    await once("site-analyze", [$("site-start"), $("site-refresh")], async () => {
      try {
        const r = await api("/website-analyses", { method: "POST", body: refresh ? { url, refresh: true } : { url }, quiet: true });
        state.analysis = r.analysis;
        render();
        if (r.analysis.status === "running") poll(state.current, r.analysis.id);
        else if (r.cached) showNotice(`Showing your earlier analysis from ${stamp(r.analysis.completedAt || r.analysis.createdAt)}. Use “Analyze again” to read the site fresh.`);
      } catch (e) { say("site-msg", e.message); }
    });
  }

  async function retryAi() {
    if (!state.analysis) return;
    await once("site-retry", [$("site-retry-ai")], async () => {
      try {
        const r = await api(`/website-analyses/${state.analysis.id}/retry-ai`, { method: "POST", body: {}, quiet: true });
        state.analysis = r.analysis;
        render();
        poll(state.current, r.analysis.id);
      } catch (e) { say("site-msg", e.message); }
    });
  }

  async function decide(f, action, text) {
    await once(`ins:${f.id}`, [], async () => {
      try {
        const r = await api(`/website-analyses/${state.analysis.id}/insights/${f.id}`, { method: "POST", body: text === undefined ? { action } : { action, text }, quiet: true });
        const i = state.analysis.insights.findIndex((x) => x.id === f.id);
        if (i >= 0) state.analysis.insights[i] = r.insight;
        editing = null;
        render();
      } catch (e) { say("site-msg", e.message); }
    });
  }

  async function approveSafe() {
    await once("ins-safe", [$("site-approve-safe")], async () => {
      try {
        const r = await api(`/website-analyses/${state.analysis.id}/approve-safe`, { method: "POST", body: {}, quiet: true });
        state.analysis = r.analysis;
        render();
        showNotice(r.approved ? `Approved ${r.approved} finding(s) that are clearly stated on your site.` : "Nothing was approved automatically: every remaining finding needs your own decision.");
      } catch (e) { say("site-msg", e.message); }
    });
  }

  /* ---------------------------------------------------------------- rendering */
  function findingCard(f) {
    const status = f.status === "approved" ? pill("Approved", "ok") : f.status === "rejected" ? pill("Not used", "") : pill("To review", "warn");
    const decided = f.status !== "proposed";
    const isQuestion = f.basis === "needs_confirmation";
    const body = editing === f.id
      ? h("div", { class: "stack" },
        h("label", {}, "Your wording", h("input", { id: `edit-${f.id}`, value: f.text, maxlength: "300" })),
        h("div", { class: "actions" },
          h("button", { type: "button", onclick: () => decide(f, "edit", $(`edit-${f.id}`).value) }, "Save my wording"),
          h("button", { type: "button", class: "secondary", onclick: () => { editing = null; render(); } }, "Cancel")))
      : h("div", {},
        h("strong", {}, f.text),
        f.edited ? h("div", { class: "hint" }, `You changed this. Original: “${f.originalText}”`) : null,
        f.evidence.length
          ? h("ul", { class: "plain evidence" }, f.evidence.map((e) => h("li", { class: "muted" }, `“${e.quote}” `, safeHref(e.url) ? h("a", { href: safeHref(e.url), target: "_blank", rel: "noopener noreferrer" }, `(${pathOf(e.url)})`) : `(${pathOf(e.url)})`)))
          : null,
        f.flagNotes.map((n) => h("div", { class: "flag-note" }, n)),
        h("div", { class: "actions" },
          decided
            ? h("button", { type: "button", class: "secondary", disabled: !can("brain.write"), onclick: () => decide(f, "reset") }, "Undo")
            : [
              h("button", { type: "button", disabled: !can("brain.write"), onclick: () => decide(f, "approve") }, isQuestion ? "Keep as a reminder" : "Yes, this is right"),
              h("button", { type: "button", class: "secondary", disabled: !can("brain.write"), onclick: () => decide(f, "reject") }, isQuestion ? "Dismiss" : "No, leave it out"),
            ],
          isQuestion ? null : h("button", { type: "button", class: "secondary", disabled: !can("brain.write"), onclick: () => { editing = f.id; render(); } }, "Edit")));
    return h("li", { class: `finding ${f.status}` }, h("div", {}, pill(f.label, ""), " ", status, f.flags.includes("risky_claim") ? [" ", pill("Check this claim", "warn")] : null), body);
  }

  function costLine(a) {
    if (a.mode === "simulated") return "No AI was used and nothing was charged.";
    const u = a.usage;
    if (!u) return "Usage was not reported by the provider, so the cost is unknown.";
    const tokens = `${u.inputTokens ?? "unknown"} tokens in, ${u.outputTokens ?? "unknown"} out`;
    const cost = u.costMicros == null ? "cost unknown (not shown as 0)" : `about ${(u.costMicros / 1e6).toFixed(4)} ${u.currency}, estimated from the provider's token counts and our price list (not a bill)`;
    return `${tokens}; ${cost}.`;
  }

  /** Claims the site makes (licences, warranties, prices, strengths) that wait for the owner's own confirmation. */
  const pendingClaims = (a) => a.insights.filter((i) => i.status === "proposed" && i.basis === "found_on_site" && i.flags.length && i.flags.every((f) => f === "risky_claim")).length;

  async function approveClaimsAndFill() {
    if (!state.analysis) return;
    await once("site-claims", [$("site-approve-claims")], async () => {
      try {
        const r = await api(`/website-analyses/${state.analysis.id}/approve-safe`, { method: "POST", body: { includeClaims: true }, quiet: true });
        state.analysis = r.analysis;
        render();
        await useFindings(true);
      } catch (e) { say("site-msg", e.message); }
    });
  }

  function renderResults(a) {
    const root = $("site-results");
    const groups = OB_GROUPS.map((g) => {
      const items = a.insights.filter((i) => i.basis === g.basis);
      if (!items.length) return null;
      return h("div", { class: "finding-group" }, h("h4", {}, `${a.mode === "simulated" && g.simTitle ? g.simTitle : g.title} (${items.length})`), h("p", { class: "hint" }, a.mode === "simulated" && g.simHint ? g.simHint : g.hint), h("ul", { class: "plain" }, items.map(findingCard)));
    }).filter(Boolean);
    const approved = a.insights.filter((i) => i.status === "approved").length;
    const pages = a.pages;
    root.replaceChildren(
      h("div", { class: "card" },
        h("div", {}, a.mode === "simulated" ? [simBadge(), " ", h("strong", {}, "Simulated analysis. "), "No AI was used: this only lists words found on your pages. With a real AI model you also get suggestions about your customers, tone and ideas."] : [pill("AI ANALYSIS", "info"), " ", h("strong", {}, `${a.provider}/${a.model}`)]),
        h("p", { class: "hint" }, `${a.site}, read ${stamp(a.completedAt || a.createdAt)}${a.cached ? " (earlier analysis)" : ""}. ${costLine(a)}`),
        h("details", {}, h("summary", {}, `Pages we looked at (${pages.filter((p) => p.status === "read").length} read)`),
          h("ul", { class: "plain" }, pages.map((p) => h("li", { class: "muted" }, `${pathOf(p.url)}: ${p.status === "read" ? "read" : p.status}${p.reason ? `. ${p.reason}` : ""}`, p.looksLikeInstructions ? [" ", pill("contains wording aimed at AI tools: treated as plain text", "warn")] : null))),
          a.robots === "restricted" ? h("p", { class: "hint" }, "The site's robots.txt rules were followed.") : null,
          a.notes.map((n) => h("p", { class: "hint" }, n))),
        h("div", { class: "actions" },
          h("button", { type: "button", id: "site-use", disabled: !can("brain.write"), onclick: useFindings }, "Fill my Business Brain from these findings"),
          h("button", { type: "button", id: "site-approve-safe", class: "secondary", disabled: !can("brain.write"), onclick: approveSafe }, "Approve everything clearly stated on my site"),
          pendingClaims(a) ? h("button", { type: "button", id: "site-approve-claims", class: "secondary", disabled: !can("brain.write"), onclick: approveClaimsAndFill }, `Also approve the ${pendingClaims(a)} claims, I confirm they are true`) : null,
          h("button", { type: "button", id: "site-refresh", class: "secondary", disabled: !can("brain.write"), onclick: () => start(true) }, "Analyze again")),
        h("div", { id: "site-fill-summary", class: "card", hidden: true }),
        h("p", { class: "hint" }, `${approved} approved so far. The button above approves everything clearly stated on your site, then copies your approved findings into the business details below. Claims and suggestions stay out until you approve them. Nothing is saved until you press Save.`),
      ),
      ...(groups.length ? groups : [h("p", { class: "hint" }, "No findings were produced from this site. You can fill in the business details yourself.")]),
    );
  }

  function render() {
    const a = state.analysis;
    const running = !!a && a.status === "running";
    $("site-progress").hidden = !running;
    if (running) $("site-progress-text").textContent = `Working on it: ${a.step}. This usually takes under a minute. You can keep this page open.`;
    $("site-start").disabled = running || !can("brain.write");
    const failed = !!a && a.status === "failed";
    $("site-failure").hidden = !failed;
    if (failed) {
      $("site-failure-text").textContent = (a.error && a.error.message) || "The analysis did not finish.";
      $("site-retry-ai").hidden = !a.canRetryAi;
    }
    const status = $("site-status");
    status.hidden = !(a && a.status === "ready");
    status.replaceChildren(...(a && a.status === "ready" ? [h("dt", {}, "Connected website"), h("dd", {}, a.site), h("dt", {}, "Last read"), h("dd", {}, stamp(a.completedAt || a.createdAt)), h("dt", {}, "Pages read"), h("dd", {}, String(a.pages.filter((p) => p.status === "read").length))] : []));
    $("site-results").hidden = !(a && a.status === "ready");
    if (a && a.status === "ready") { renderResults(a); if (lastFill) showFillSummary(lastFill.patch, lastFill.result); } else $("site-results").replaceChildren();
    $("site-start").textContent = a && a.status === "ready" ? "Analyze a different website" : "Analyze my website";
    onFormChanged(); // Home's list of what needs attention follows the analysis
    $("demo-row").hidden = !!a && a.status === "ready"; // fictional demo data must not sit next to the owner's real findings
  }

  /* ----------------------------------------------------- copy findings into the form */
  function mergeLines(field, extra) {
    const have = lines(field.value);
    const seen = new Set(have.map((x) => x.toLowerCase()));
    for (const x of extra) if (!seen.has(x.toLowerCase())) { have.push(x); seen.add(x.toLowerCase()); }
    field.value = have.join("\n");
  }

  /**
   * Fills what is empty (or still the default tone), and what an EARLIER fill from the website put there and the person has not touched since
   * (so filling again refreshes it). Never overwrites anything the person wrote. Returns what was filled and what was left as it was.
   */
  const autoFilled = {}; // field -> the value this page last put there
  /** True when a value is text that came from the website findings (an earlier fill, possibly saved), so a better fill may replace it. */
  const fromWebsite = (value) => {
    const v = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!v || !state.analysis) return false;
    return state.analysis.insights.some((i) => i.text.toLowerCase() === v || i.originalText.toLowerCase() === v);
  };
  function applyPatchToForm(patch) {
    const f = $("brain-form").elements;
    const norm = (v) => String(v || "").replace(/\s+/g, " ").trim().toLowerCase();
    // what earlier fills (of this or any other website) put in this workspace's form: the server remembers it, so replacing it is exact and the owner's own text is never taken for it
    const ledger = patch.ledger || [];
    const ledgerHas = (field, value) => ledger.some((x) => x.field === field && norm(x.value) === norm(value));
    const filled = [], left = [], replacedDemo = [], removedEarlier = [], added = [], removedLedger = [];

    for (const k of ["businessName", "industry", "serviceArea", "targetCustomer", "offer", "tone", "approvedPricing", "description"]) {
      const el = f[k];
      if (!el) continue;
      const cur = el.value.trim();
      const v = patch.fields[k];
      const demo = isDemoText(cur);
      const fromEarlier = !!cur && ledgerHas(k, cur);
      const replaceable = !cur || (k === "tone" && cur === OB_DEFAULT_TONE) || cur === autoFilled[k] || demo || fromEarlier || fromWebsite(cur);
      if (v) {
        if (!replaceable) { left.push(k); continue; }
        if (cur !== v) el.value = v;
        autoFilled[k] = v;
        filled.push(k);
        if (demo) replacedDemo.push(k);
        if (fromEarlier && cur !== v) { removedEarlier.push({ field: k, value: cur }); removedLedger.push({ field: k, value: cur }); }
        if (cur !== v || fromEarlier) added.push({ field: k, value: v }); // (the same value the owner typed is theirs: it is not recorded as the website's)
      } else if (cur && (demo || fromEarlier)) {
        // the findings say nothing about this field any more: what the demo or an earlier website put there goes (the tone returns to its default)
        el.value = k === "tone" ? OB_DEFAULT_TONE : "";
        if (demo) replacedDemo.push(k);
        if (fromEarlier) { removedEarlier.push({ field: k, value: cur }); removedLedger.push({ field: k, value: cur }); }
      }
    }

    for (const k of ["services", "differentiators", "verifiedFacts", "unverifiedClaims", "prohibitedClaims"]) {
      const items = k === "prohibitedClaims" ? [] : (patch[k] || []);
      let have = lines(f[k].value);
      const demoLines = have.filter((x) => isDemoText(x));
      if (demoLines.length) { have = have.filter((x) => !isDemoText(x)); if (!replacedDemo.includes(k)) replacedDemo.push(k); }
      if (k !== "prohibitedClaims") {
        const keep = new Set(items.map(norm));
        // lines that came from a website earlier and that THIS analysis does not support are removed; every other line is the owner's and stays
        const stale = have.filter((x) => !keep.has(norm(x)) && (ledgerHas(k, x) || fromWebsite(x)));
        for (const x of stale) { removedEarlier.push({ field: k, value: x }); if (ledgerHas(k, x)) removedLedger.push({ field: k, value: x }); }
        have = have.filter((x) => !stale.includes(x));
        const present = new Set(have.map(norm));
        for (const x of items) if (present.has(norm(x)) && ledgerHas(k, x)) added.push({ field: k, value: x }); // already there from a website: this analysis now vouches for it
        const fresh = items.filter((x) => !present.has(norm(x)));
        have = [...have, ...fresh];
        for (const x of fresh) added.push({ field: k, value: x });
        if (items.length) filled.push(k);
      }
      f[k].value = have.join("\n");
    }
    // the records of where website statements came from are rebuilt each time, not piled up
    state.brainFacts = (state.brainFacts || []).filter((x) => !(x.status === "imported" && !x.approvedForMarketing && String(x.source || "").startsWith("website:")));
    const haveFacts = new Set((state.brainFacts || []).map((x) => x.text.toLowerCase()));
    state.brainFacts = [...(state.brainFacts || []), ...patch.facts.filter((x) => !haveFacts.has(x.text.toLowerCase()))].slice(0, 30);
    for (const x of removedEarlier) if (!replacedDemo.includes(x.field) && !filled.includes(x.field)) filled.push(x.field);
    return { filled, left, replacedDemo, removedEarlier, added, removedLedger };
  }

  const FIELD_LABEL = { businessName: "Business name", industry: "Industry", serviceArea: "Service area", targetCustomer: "Target customer", offer: "Offer", tone: "Tone", description: "Business description", approvedPricing: "Approved pricing statement", services: "Services", differentiators: "Approved differentiators", verifiedFacts: "Other verified facts", unverifiedClaims: "Claims not verified", prohibitedClaims: "Things ads must never say" };
  /** A permanent note under the button saying which finding went into which field, and what was left alone. */
  function showFillSummary(patch, result) {
    const box = $("site-fill-summary");
    const f = $("brain-form").elements;
    const rows = result.filled.map((k) => h("li", {}, h("strong", {}, `${FIELD_LABEL[k] || k}: `), String(f[k].value).split("\n").filter(Boolean).slice(0, 4).join("; ").slice(0, 160)));
    const notFound = OB_REQUIRED.filter(([k]) => !f[k].value.trim()).map(([, label]) => label);
    box.replaceChildren(
      h("strong", {}, "What went into your Business Brain form"),
      rows.length ? h("ul", { class: "plain" }, rows) : h("p", { class: "hint" }, "Nothing new was added."),
      result.left.length ? h("p", { class: "hint" }, `Left as you wrote it: ${result.left.map((k) => FIELD_LABEL[k] || k).join(", ")}.`) : null,
      result.removedEarlier && result.removedEarlier.length ? h("div", { class: "hint" }, "Removed because an earlier website analysis put it there and this analysis does not support it (the form is not saved yet, so you can still change your mind):", h("ul", { class: "plain" }, result.removedEarlier.slice(0, 8).map((x) => h("li", {}, `${FIELD_LABEL[x.field] || x.field}: ${String(x.value).slice(0, 120)}`)))) : null,
      result.replacedDemo && result.replacedDemo.length ? h("p", { class: "hint" }, `Demo data was replaced by your real findings in: ${result.replacedDemo.map((k) => FIELD_LABEL[k] || k).join(", ")}.`) : null,
      pendingClaimsNow() ? h("p", { class: "hint" }, `${pendingClaimsNow()} claim(s) on your site (licences, warranties, prices, strengths) are waiting for you: approve them one by one above, or press “Also approve the claims” if you confirm they are true. They then fill Approved differentiators, Other verified facts and Approved pricing.`) : null,
      notFound.length ? h("p", { class: "flag-note" }, `Not found on your site, please fill in: ${notFound.join(", ")}.`) : h("p", { class: "hint" }, "All the required fields have a value. Check them, then press Save."),
    );
    box.hidden = false;
  }

  function missingRequired() {
    const f = $("brain-form").elements;
    return OB_REQUIRED.filter(([k]) => !f[k].value.trim()).map(([, label]) => label);
  }

  function openDetails(msg) {
    $("brain-details").open = true;
    $("brain-version").textContent = msg;
    const el = $("brain-form");
    revealEl(el, "start");
  }

  const pendingClaimsNow = () => (state.analysis ? pendingClaims(state.analysis) : 0);

  async function useFindings() {
    if (!state.analysis) return;
    try {
      // what is clearly stated on the site (and carries no warning) is approved first; claims and suggestions wait for the owner
      const safe = await api(`/website-analyses/${state.analysis.id}/approve-safe`, { method: "POST", body: {}, quiet: true });
      state.analysis = safe.analysis;
      render();
      const patch = await api(`/website-analyses/${state.analysis.id}/brain-patch`, { quiet: true });
      if (!patch.approvedCount) { say("site-msg", "Nothing could be filled in automatically. Approve at least one finding (“Yes, this is right”), then try again."); return; }
      say("site-msg", "");
      const result = applyPatchToForm(patch);
      onFormChanged();
      lastFill = { patch, result };
      showFillSummary(patch, result);
      const missing = missingRequired();
      openDetails("Findings from your website were added to the form: review them, then press Save Business Brain.");
      showNotice(missing.length ? `Added to the form. Still needed before you can save: ${missing.join(", ")}.` : "Added to the form. Check it, then press Save Business Brain.");
      // tell the server what the fill added and removed, so the next analysis (of any website) can replace exactly that and nothing the owner wrote
      try { await api(`/website-analyses/${state.analysis.id}/applied`, { method: "POST", body: { added: result.added.slice(0, 80), removed: result.removedLedger.slice(0, 80) }, quiet: true }); } catch { /* the form still works; older text is then recognised from the findings instead */ }
    } catch (e) { say("site-msg", e.message); }
  }

  /* ----------------------------------------------------- no website: short questionnaire */
  function submitQuick(e) {
    e.preventDefault();
    const q = e.target.elements, f = $("brain-form").elements;
    const set = (k, v) => { if (v.trim()) f[k].value = v.trim(); };
    set("businessName", q.businessName.value);
    set("industry", q.industry.value);
    if (q.services.value.trim()) f.services.value = lines(q.services.value).join("\n");
    set("serviceArea", q.serviceArea.value);
    set("targetCustomer", q.targetCustomer.value);
    set("offer", q.offer.value);
    onFormChanged();
    const missing = missingRequired();
    openDetails("Your answers were added to the form: add anything else you like, then press Save Business Brain.");
    showNotice(missing.length ? `Thanks. Still needed before you can save: ${missing.join(", ")}.` : "Thanks. Check the details below, then press Save Business Brain.");
  }

  /* ----------------------------------------------------- wiring */
  $("site-has-yes").addEventListener("change", () => chooseSite("yes"));
  $("site-has-no").addEventListener("change", () => chooseSite("no"));
  $("site-form").addEventListener("submit", (e) => { e.preventDefault(); start(false); });
  $("site-retry-ai").addEventListener("click", retryAi);
  $("site-manual").addEventListener("click", () => { chooseSite("no"); say("site-msg", ""); });
  $("quick-form").addEventListener("submit", submitQuick);
  $("brain-skip").addEventListener("click", () => openDetails("Fill in the details yourself, then press Save Business Brain."));

  return { load, render, applyPatchToForm };
}
