// Learning: experiments, the Marketing Brain (learnings) and recommendations. Records and decisions only: nothing here changes spend, edits a campaign or publishes.
// Results are entered or imported by people and labelled by source; this app measures no performance. Synthetic data is labelled and never supports a decision.
// The server enforces every rule; this file shows state and sends requests. Built with textContent only (via h()).

const LEARN_STATUS = { draft: ["DRAFT", ""], running: ["RUNNING", "warn"], concluded: ["CONCLUDED", "ok"], abandoned: ["ABANDONED", ""] };
const LEARN_OUTCOME = { variant_better: "The variant was judged better", control_better: "The control was judged better", inconclusive: "No clear difference", abandoned: "Abandoned" };
const LEARN_VARIABLES = [["headline", "Headline"], ["primary_text", "Primary text"], ["call_to_action", "Call to action"], ["creative_image", "Creative image"], ["audience", "Audience"], ["placement", "Placement"], ["offer", "Offer"], ["other", "Something else"]];
const LEARN_METRICS = [["qualified_rate", "Share of leads qualified or won"], ["won_rate", "Share of leads won"], ["lead_count", "Number of leads"], ["click_through_rate", "Click-through rate (you enter it)"], ["conversion_rate", "Conversion rate (you enter it)"], ["cost_per_lead", "Cost per lead (you enter it)"], ["other", "Other (you enter it)"]];
const LEARN_KINDS = [["message", "Message"], ["creative", "Creative"], ["audience", "Audience"], ["timing", "Timing"], ["constraint", "Constraint"], ["unknown", "Known unknown"], ["other", "Other"]];
const LEARN_SOURCE = { actual: "ACTUAL", imported: "IMPORTED", user_entered: "ENTERED BY YOUR TEAM", synthetic: "SYNTHETIC" };

export function initLearning({ $, h, api, state, can, once, pill, showNotice, session }) {
  const fail = (m) => { $("ln-error").textContent = m || ""; };
  let experiments = [], campaignInfo = new Map();
  const openAnalysis = new Set();

  async function act(key, label, fn) {
    await once("ln-" + key, [], async () => {
      fail("");
      try { await fn(); if (label) showNotice(label); } catch (e) { fail(e && e.message ? e.message : "That did not work."); }
      await loadAll(false); // keep what you are typing in the plan form
    });
  }
  const opt = (v, l, sel) => h("option", { value: v, ...(sel ? { selected: true } : {}) }, l);
  const field = (label, el, wide) => h("label", { class: wide ? "wide" : "" }, label + " ", el);

  /* ---------------------------------------------------------------- experiments */
  async function analysisBlock(e) {
    const box = h("div", { class: "card" }, h("p", { class: "hint" }, "Loading the analysis..."));
    api(`/experiments/${e.id}/analysis`, { quiet: true }).then((a) => {
      const sig = a.significance;
      box.replaceChildren(
        h("p", {}, h("strong", {}, "Where the data stands: "), pill(a.readiness === "enough_data_to_consider" ? "planned time and data met" : a.readiness === "collecting" ? "still collecting" : a.status, a.readiness === "enough_data_to_consider" ? "ok" : "warn"), " ", h("span", { class: "hint" }, a.note)),
        a.warnings.length ? h("ul", { class: "plain" }, a.warnings.map((w) => h("li", {}, pill(w.severity === "blocking" ? "blocks a conclusion" : "keep in mind", w.severity === "blocking" ? "bad" : ""), " ", w.message))) : null,
        h("table", {}, h("thead", {}, h("tr", {}, ...["Variant", "Leads (by kind, exact campaign version)", "Counted toward the sample", "Entered or imported results", "Recorded as used"].map((x) => h("th", {}, x)))),
          h("tbody", {}, a.variants.map((v) => h("tr", {},
            h("td", {}, v.label, " ", pill(v.role)),
            h("td", {}, ["synthetic", "imported", "real", "unknown"].filter((k) => v.leads.byOrigin[k]).map((k) => `${k}: ${v.leads.byOrigin[k]}`).join(", ") || "none", v.leads.notCountedNoVersion ? h("div", { class: "muted" }, `${v.leads.notCountedNoVersion} with no recorded version, not counted`) : null),
            h("td", {}, String(v.sample), h("div", { class: "muted" }, "synthetic data adds nothing here")),
            h("td", {}, v.observations.length ? v.observations.map((o) => h("div", {}, pill(LEARN_SOURCE[o.sourceType] || o.sourceType, o.sourceType === "synthetic" ? "sim" : ""), ` ${o.successes !== null ? `${o.successes} of ${o.trials}` : o.value} (${o.metric.replace(/_/g, " ")}, ${o.observedOn}). ${o.sourceNote}`)) : "none"),
            h("td", {}, v.usage.length ? v.usage.map((u) => h("div", {}, `${u.usedFrom}${u.usedTo ? " to " + u.usedTo : " onward"}: ${u.note}`)) : h("span", { class: "muted" }, "no record")))))),
        sig.assessed
          ? h("div", { class: "flag-note" }, h("strong", {}, "Indicative test: "), `${sig.method} on ${sig.dataset}. Control ${sig.control.successes}/${sig.control.trials} (${(sig.control.rate * 100).toFixed(1)}%), other ${sig.variant.successes}/${sig.variant.trials} (${(sig.variant.rate * 100).toFixed(1)}%), p = ${sig.pValue}. `, sig.interpretation)
          : h("p", { class: "hint" }, "No statistical test was run: " + sig.reason));
    }).catch(() => box.replaceChildren(h("p", { class: "hint" }, "The analysis is not available to your role.")));
    return box;
  }

  function recordForms(e) {
    const vsel = (name) => h("select", { name, "aria-label": "Variant" }, e.variants.map((v) => opt(v.id, `${v.label} (${v.role})`)));
    const use = h("form", { class: "grid", onsubmit: (ev) => {
      ev.preventDefault(); const f = ev.target.elements;
      act("use-" + e.id, "Recorded.", () => api(`/experiments/${e.id}/usage`, { method: "POST", body: { variantId: f.variantId.value, usedFrom: f.usedFrom.value, ...(f.usedTo.value ? { usedTo: f.usedTo.value } : {}), note: f.note.value.trim() } }));
    } }, field("Which variant", vsel("variantId")), field("Used from", h("input", { type: "date", name: "usedFrom", required: true })), field("Until (optional)", h("input", { type: "date", name: "usedTo" })), field("What actually ran", h("input", { name: "note", maxlength: "300", required: true }), true),
      h("div", { class: "wide" }, h("button", { type: "submit", class: "secondary", "data-needs": "experiments.write" }, "Record what was used")));
    const mets = LEARN_METRICS.map(([v, l]) => opt(v, l, v === e.successMetric));
    const res = h("form", { class: "grid", onsubmit: (ev) => {
      ev.preventDefault(); const f = ev.target.elements;
      const body = { variantId: f.variantId.value, metric: f.metric.value, sourceType: f.sourceType.value, sourceNote: f.sourceNote.value.trim(), observedOn: f.observedOn.value };
      if (f.value.value.trim() !== "") body.value = Number(f.value.value); else { body.successes = Number(f.successes.value); body.trials = Number(f.trials.value); }
      act("obs-" + e.id, "Result recorded.", () => api(`/experiments/${e.id}/observations`, { method: "POST", body }));
    } }, field("Which variant", vsel("variantId")), field("Measure", h("select", { name: "metric" }, mets)),
      field("Successes", h("input", { name: "successes", type: "number", min: "0" })), field("Out of (trials)", h("input", { name: "trials", type: "number", min: "1" })), field("Or a plain value", h("input", { name: "value", type: "number", step: "any" })),
      field("Where it came from", h("select", { name: "sourceType" }, opt("user_entered", "Entered by me from my own records"), opt("imported", "Imported from the ad platform or another system"), opt("synthetic", "Synthetic (test data)"))),
      field("Date it covers", h("input", { type: "date", name: "observedOn", required: true })), field("Source note (required)", h("input", { name: "sourceNote", maxlength: "300", required: true }), true),
      h("div", { class: "wide" }, h("button", { type: "submit", class: "secondary", "data-needs": "experiments.write" }, "Record a result"), " ", h("span", { class: "hint" }, "This app measures no performance. You enter or import it, and it is labelled with that source.")));
    return h("div", {}, h("h4", {}, "Record what was actually used"), use, h("h4", {}, "Record a result"), res);
  }

  function concludeForm(e) {
    const f = h("form", { class: "grid", onsubmit: (ev) => {
      ev.preventDefault(); const el = ev.target.elements;
      act("concl-" + e.id, "Experiment concluded. Nothing else was changed.", () => api(`/experiments/${e.id}/conclude`, { method: "POST", body: { outcome: el.outcome.value, rationale: el.rationale.value.trim(), acknowledgeWarnings: el.ack.checked } }));
    } }, field("Your decision", h("select", { name: "outcome" }, opt("inconclusive", "No clear difference"), opt("variant_better", "The variant is better"), opt("control_better", "The control is better"))),
      field("Why (against the decision rule above)", h("textarea", { name: "rationale", rows: "2", maxlength: "600", required: true }), true),
      h("label", { class: "chk wide" }, h("input", { type: "checkbox", name: "ack" }), " I know the data warnings above, and I am recording my own judgement anyway (needed to pick a winner while warnings block)."),
      h("div", { class: "wide" }, h("button", { type: "submit", "data-needs": "experiments.decide" }, "Conclude"), " ", h("span", { class: "hint" }, e.neverAutomatic)));
    const ab = h("form", { class: "actions", onsubmit: (ev) => { ev.preventDefault(); act("aband-" + e.id, "Abandoned.", () => api(`/experiments/${e.id}/abandon`, { method: "POST", body: { reason: ev.target.elements.reason.value.trim() } })); } },
      h("input", { name: "reason", placeholder: "Why abandon it", maxlength: "300", required: true, "aria-label": "Reason to abandon" }), h("button", { type: "submit", class: "danger", "data-needs": "experiments.decide" }, "Abandon"));
    return h("div", {}, h("h4", {}, "Conclude"), f, ab);
  }

  function experimentCard(e) {
    const [lab, cls] = LEARN_STATUS[e.status] || [e.status, ""];
    const card = h("li", { class: "card" },
      h("div", {}, h("strong", {}, e.name), " ", pill(lab, cls), " ", e.planLocked ? pill("PLAN FROZEN") : pill("plan can still change", "warn")),
      h("div", {}, h("strong", {}, "Hypothesis: "), e.hypothesis),
      h("div", { class: "muted" }, `Changing one thing: ${LEARN_VARIABLES.find((x) => x[0] === e.principalVariable)[1].toLowerCase()} (${e.variableNote}). Audience: ${e.audienceNote}. Placement: ${e.placementNote}.`),
      h("div", { class: "muted" }, `Success measure: ${e.successMetricLabel}. Planned ${e.durationDays} days, at least ${e.minSample} data points per variant.`),
      h("div", {}, h("strong", {}, "Decision rule, written before the data: "), e.decisionRule),
      h("ul", { class: "plain" }, e.variants.map((v) => h("li", {}, pill(v.role), " ", h("strong", {}, v.label), `: ${v.description} `, h("span", { class: "muted" }, [v.campaign ? `campaign “${v.campaign.name}” version ${v.campaign.version ?? "?"}` : null, v.creative ? `creative “${v.creative.name}” version ${v.creative.version}` : null].filter(Boolean).join("; "))))),
      ...e.designWarnings.map((w) => h("div", { class: "flag-note" }, w)),
      e.outcome ? h("div", { class: "card" }, h("strong", {}, LEARN_OUTCOME[e.outcome] || e.outcome), `: ${e.outcomeRationale}`, e.warningsAtConclusion && e.warningsAtConclusion.length ? h("div", { class: "muted" }, "Warnings standing at the time: " + e.warningsAtConclusion.map((w) => w.message.split(".")[0]).join("; ")) : null) : null);
    const acts = [];
    if (e.status === "draft" && can("experiments.write")) acts.push(h("button", { type: "button", onclick: () => act("start-" + e.id, "Started. The plan is now frozen.", () => api(`/experiments/${e.id}/start`, { method: "POST" })) }, "Start (freezes the plan)"));
    if (e.status !== "draft") acts.push(h("button", { type: "button", class: "secondary", onclick: async () => { if (openAnalysis.has(e.id)) openAnalysis.delete(e.id); else openAnalysis.add(e.id); await renderExperiments(); } }, openAnalysis.has(e.id) ? "Hide the analysis" : "Show the analysis"));
    if (acts.length) card.append(h("div", { class: "actions" }, acts));
    if (openAnalysis.has(e.id)) analysisBlock(e).then((b) => card.append(b));
    if (e.status === "running") { card.append(h("details", {}, h("summary", {}, "Record use and results"), recordForms(e))); card.append(h("details", {}, h("summary", {}, "Conclude or abandon"), concludeForm(e))); }
    return card;
  }
  async function renderExperiments() {
    $("ln-experiments").replaceChildren(experiments.length ? h("ul", { class: "plain" }, experiments.map(experimentCard)) : h("p", { class: "hint" }, "No experiments yet."));
  }

  /* ---------------------------------------------------------------- creating an experiment */
  async function campaignData(id) {
    if (!id) return { versions: [], creatives: [] };
    if (!campaignInfo.has(id)) {
      const [c, cr] = await Promise.all([api(`/campaigns/${id}`, { quiet: true }).catch(() => null), api(`/campaigns/${id}/creatives`, { quiet: true }).catch(() => ({ creatives: [] }))]);
      campaignInfo.set(id, { versions: c ? c.versions.map((v) => v.version) : [], current: c ? c.currentVersion : 1, creatives: cr.creatives });
    }
    return campaignInfo.get(id);
  }
  function variantPicker(prefix, role) {
    const camp = h("select", { name: prefix + "Campaign", "aria-label": `${role} campaign` }, (state.campaigns || []).map((c) => opt(c.id, c.name)));
    const ver = h("select", { name: prefix + "Version", "aria-label": `${role} campaign version` });
    const cre = h("select", { name: prefix + "Creative", "aria-label": `${role} creative` });
    const fill = async () => {
      const d = await campaignData(camp.value);
      ver.replaceChildren(...d.versions.map((v) => opt(String(v), `version ${v}`, v === d.current)));
      cre.replaceChildren(opt("", "No creative"), ...d.creatives.map((x) => opt(x.id, `${x.name} (version ${x.currentVersion})`)));
    };
    camp.addEventListener("change", fill); fill();
    return { camp, ver, cre, el: h("div", { class: "card wide" }, h("strong", {}, role === "control" ? "Control: the version you compare against" : "Variant: the one change"),
      h("div", { class: "grid" }, field("Label", h("input", { name: prefix + "Label", maxlength: "40", value: role === "control" ? "Control" : "Variant" })), field("Campaign", camp), field("Campaign version", ver), field("Creative (optional)", cre), field("What it is", h("input", { name: prefix + "Desc", maxlength: "300", value: role === "control" ? "The current version" : "" }), true))) };
  }
  function buildCreateForm() {
    const ctl = variantPicker("c", "control"), vr = variantPicker("v", "variant");
    const form = h("form", { class: "grid", id: "ln-exp-form", onsubmit: (ev) => {
      ev.preventDefault(); const f = ev.target.elements;
      const ref = (p) => ({ campaignId: f[p + "Campaign"].value, campaignVersion: Number(f[p + "Version"].value), ...(f[p + "Creative"].value ? { creativeId: f[p + "Creative"].value } : {}) });
      const body = { name: f.name.value.trim(), hypothesis: f.hypothesis.value.trim(), principalVariable: f.principalVariable.value, variableNote: f.variableNote.value.trim(), audienceNote: f.audienceNote.value.trim(), placementNote: f.placementNote.value.trim(),
        successMetric: f.successMetric.value, durationDays: Number(f.durationDays.value), minSample: Number(f.minSample.value), decisionRule: f.decisionRule.value.trim(),
        variants: [{ label: f.cLabel.value.trim(), role: "control", description: f.cDesc.value.trim(), ...ref("c") }, { label: f.vLabel.value.trim(), role: "variant", description: f.vDesc.value.trim(), ...ref("v") }] };
      act("create", "Saved as a draft. Start it when the plan is right: starting freezes it.", async () => { await api("/experiments", { method: "POST", body }); ev.target.reset(); });
    } },
      field("Name", h("input", { name: "name", maxlength: "100", required: true })), field("Principal variable (the ONE thing that differs)", h("select", { name: "principalVariable" }, LEARN_VARIABLES.map(([v, l]) => opt(v, l)))),
      field("Hypothesis", h("textarea", { name: "hypothesis", rows: "2", maxlength: "400", required: true }), true), field("Exactly how the variants differ", h("input", { name: "variableNote", maxlength: "300", required: true }), true),
      field("Audience", h("input", { name: "audienceNote", maxlength: "300", required: true })), field("Placement", h("input", { name: "placementNote", maxlength: "300", required: true })),
      field("Success measure", h("select", { name: "successMetric" }, LEARN_METRICS.map(([v, l]) => opt(v, l)))), field("Planned days", h("input", { name: "durationDays", type: "number", min: "1", max: "365", value: "14" })),
      field("Least data per variant", h("input", { name: "minSample", type: "number", min: "1", value: "30" })),
      field("Decision rule (write it BEFORE you see data)", h("textarea", { name: "decisionRule", rows: "2", maxlength: "400", required: true }), true),
      ctl.el, vr.el,
      h("div", { class: "wide" }, h("button", { type: "submit", "data-needs": "experiments.write", "data-busy-label": "Saving..." }, "Save the plan as a draft"), " ", h("span", { class: "hint" }, "A plan compares two exact versions. Nothing runs, spends or publishes from here.")));
    $("ln-exp-form-box").replaceChildren(form);
  }

  /* ---------------------------------------------------------------- learnings */
  function learningCard(l) {
    const note = h("input", { placeholder: "Reason (needed to reject or retire)", maxlength: "300", "aria-label": "Reason" });
    const decide = (d, msg) => act(`l-${d}-${l.id}`, msg, () => api(`/learnings/${l.id}/${d}`, { method: "POST", body: note.value.trim() ? { note: note.value.trim() } : {} }));
    const acts = [];
    if (can("learnings.confirm")) {
      if (l.status === "suggested") acts.push(h("button", { type: "button", onclick: () => decide("confirm", "Confirmed.") }, "Confirm"), note, h("button", { type: "button", class: "danger", onclick: () => (note.value.trim() ? decide("reject", "Rejected.") : fail("Say why it is being rejected.")) }, "Reject"));
      if (l.status === "confirmed") acts.push(note, h("button", { type: "button", class: "secondary", onclick: () => (note.value.trim() ? decide("retire", "Retired.") : fail("Say why it is being retired.")) }, "Retire"));
    }
    return h("li", { class: "card" }, h("div", {}, pill(l.status === "confirmed" ? "HUMAN-CONFIRMED" : l.status.toUpperCase(), l.status === "confirmed" ? "ok" : l.status === "suggested" ? "warn" : ""), " ", pill(l.originLabel), " ", pill(`confidence: ${l.confidence}`), " ", pill(l.kind)),
      h("p", {}, l.statement), h("div", { class: "muted" }, `Source: ${l.sourceType.replace(/_/g, " ")}${l.sourceRef ? " (" + l.sourceRef + ")" : ""}. Observed ${l.observedOn}.`), h("div", { class: "flag-note" }, "Does not show: " + l.limitations),
      l.decisionNote ? h("div", { class: "muted" }, `Decision note: ${l.decisionNote}`) : null, acts.length ? h("div", { class: "actions" }, acts) : null);
  }
  async function loadLearnings() {
    const box = $("ln-learnings");
    try {
      const r = await api("/learnings", { quiet: true });
      box.replaceChildren(h("p", { class: "hint" }, r.note), r.learnings.length ? h("ul", { class: "plain" }, r.learnings.map(learningCard)) : h("p", { class: "hint" }, "No learnings yet. Write one, or generate suggestions from concluded experiments and creative reviews."));
    } catch { box.replaceChildren(h("p", { class: "hint" }, "Learnings are not available to your role.")); }
  }

  /* ---------------------------------------------------------------- recommendations */
  function recCard(r) {
    const note = h("input", { placeholder: "Note (needed to dismiss)", maxlength: "300", "aria-label": "Note" });
    const decide = (d) => act(`r-${d}-${r.key}`, d === "accept" ? "Recorded. Nothing was changed." : "Dismissed.", () => api("/recommendations/decide", { method: "POST", body: { key: r.key, decision: d, ...(note.value.trim() ? { note: note.value.trim() } : {}) } }));
    return h("li", { class: "card" }, h("div", {}, h("strong", {}, r.title), " ", pill(r.status === "open" ? "NEEDS A PERSON'S DECISION" : r.status.toUpperCase(), r.status === "open" ? "warn" : "ok"), " ", pill(r.evidenceKind === "records" ? "from records" : "from records, plus inference")),
      h("p", {}, r.text), h("div", { class: "muted" }, "Evidence: " + r.evidence.map((e) => `${e.type} “${e.label}”`).join("; ")), h("div", { class: "flag-note" }, "Uncertainty: " + r.uncertainty), h("div", { class: "hint" }, r.neverAutomatic),
      r.status === "open" && can("recommendations.decide") ? h("div", { class: "actions" }, h("button", { type: "button", onclick: () => decide("accept") }, "Accept the recommendation"), note, h("button", { type: "button", class: "secondary", onclick: () => (note.value.trim() ? decide("dismiss") : fail("Say why it is being dismissed.")) }, "Dismiss")) : r.decisionNote ? h("div", { class: "muted" }, "Note: " + r.decisionNote) : null);
  }
  async function loadRecs() {
    const box = $("ln-recs");
    try { const r = await api("/recommendations", { quiet: true }); box.replaceChildren(h("p", { class: "hint" }, r.note), r.recommendations.length ? h("ul", { class: "plain" }, r.recommendations.map(recCard)) : h("p", { class: "hint" }, "No recommendations right now.")); }
    catch { box.replaceChildren(h("p", { class: "hint" }, "Recommendations are not available to your role.")); }
  }

  function wireLearning() {
    $("ln-learn-form").addEventListener("submit", (ev) => {
      ev.preventDefault(); const f = ev.target.elements;
      const body = { statement: f.statement.value.trim(), kind: f.kind.value, sourceType: "human_note", observedOn: f.observedOn.value, confidence: f.confidence.value, limitations: f.limitations.value.trim() };
      act("learn", "Saved as a suggestion. A different person confirms it.", async () => { await api("/learnings", { method: "POST", body }); ev.target.reset(); });
    });
    $("ln-suggest").addEventListener("click", () => act("suggest", "Suggestions generated (each only once). Nothing is confirmed until a person confirms it.", () => api("/learnings/suggest", { method: "POST" })));
    const nav = document.querySelector('#main-nav a[href="#s-learning"]');
    if (nav) nav.addEventListener("click", () => { if (session()) loadAll(true); });
    $("ln-kind").replaceChildren(...LEARN_KINDS.map(([v, l]) => opt(v, l)));
  }

  async function loadAll(rebuild = true) {
    if (!session()) { for (const id of ["ln-experiments", "ln-learnings", "ln-recs", "ln-exp-form-box"]) $(id).replaceChildren(); return; }
    campaignInfo = new Map();
    try { experiments = (await api("/experiments", { quiet: true })).experiments; } catch { experiments = []; }
    await renderExperiments();
    if (rebuild) buildCreateForm();
    await Promise.all([loadLearnings(), loadRecs()]);
  }
  wireLearning();
  return { load: loadAll };
}
