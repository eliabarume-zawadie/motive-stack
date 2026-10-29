// Integrations: what each connection really is, exactly what it can do, what could ever affect the outside world, and why nothing can right now.
// This screen DESCRIBES. It has no control that switches an integration on: going live is a server setting that needs separate authorization.
// The only actions are a SIMULATED self-test of a built-in stand-in and read-only previews. Built with textContent only (via h()).

const INTEG_STATE_CLASS = { mock: "sim", configured_unverified: "warn", verified: "ok", limited: "", disabled: "", unavailable: "bad", not_built: "" };
const INTEG_CAP_STATE = { simulated: ["SIMULATED", "sim"], available: ["AVAILABLE", "warn"], disabled: ["DISABLED", ""], not_built: ["NOT BUILT", ""] };
const INTEG_EFFECT = { read: "reads", internal_write: "changes this app only", external_effect: "could affect the outside world" };

export function initIntegrations({ $, h, api, state, can, once, pill, showNotice, session }) {
  let data = null;

  function capRow(c) {
    const [lab, cls] = INTEG_CAP_STATE[c.state] || [c.state, ""];
    return h("li", {}, pill(lab, cls), " ", h("strong", {}, c.label), " ", h("span", { class: "muted" }, `(${INTEG_EFFECT[c.effect] || c.effect}${c.approvalRequired ? ", needs approval" : ""})`), c.note ? h("div", { class: "muted" }, c.note) : null);
  }

  function adapterCard(a) {
    const test = a.testable === "simulated" && can("integrations.test")
      ? h("button", { type: "button", class: "secondary", onclick: () => once("integ-test-" + a.id, [], async () => {
        try { const r = await api(`/integrations/${a.id}/test`, { method: "POST" }); showNotice(r.ok ? "Simulated test passed. Nothing was contacted." : "Simulated test failed: " + r.detail); } catch { /* shown */ }
        await load();
      }) }, "Run a simulated self-test") : null;
    return h("li", { class: "card" },
      h("div", {}, h("strong", {}, a.label), " ", pill(a.stateLabel, INTEG_STATE_CLASS[a.state] || ""), " ", pill(a.mode === "simulated" ? "no real service" : a.mode === "local" ? "on this computer" : a.mode === "live" ? "LIVE" : "none")),
      h("p", {}, a.reason),
      h("details", {}, h("summary", {}, "What it can do, its limits and what happens when it fails"),
        h("ul", { class: "plain" }, a.capabilities.map(capRow)),
        h("div", {}, h("strong", {}, "Limits: "), a.limits.join(" ")), h("div", {}, h("strong", {}, "Where its data comes from: "), a.dataProvenance), h("div", {}, h("strong", {}, "When it fails: "), a.failureBehavior),
        h("div", {}, h("strong", {}, "Setup: "), a.setupGuidance.join(" ")), h("div", {}, h("strong", {}, "Who may change it: "), a.permissionLimits)),
      a.lastTest ? h("div", { class: "muted" }, `Last test (SIMULATED): ${a.lastTest.ok ? "passed" : "failed"}, ${a.lastTest.at.replace("T", " ").slice(0, 16)} UTC. ${a.lastTest.detail}`) : a.testable === "ai_route" ? h("div", { class: "muted" }, "The AI connection test is in AI settings.") : h("div", { class: "muted" }, a.testable === "simulated" ? "No test has been run." : "Nothing to test here."),
      test ? h("div", { class: "actions" }, test) : null);
  }

  function futureCard(a) {
    return h("li", { class: "card" }, h("strong", {}, a.label), " ", pill("NOT BUILT"), h("div", { class: "muted" }, a.capabilities.map((c) => `${c.label}${c.approvalRequired ? " (would need approval)" : ""}`).join("; ")),
      h("div", { class: "muted" }, `Limits: ${a.limits.join(" ")} Data: ${a.dataProvenance} If it fails: ${a.failureBehavior}`));
  }

  function contractCard(x) {
    return h("li", { class: "card" }, h("div", {}, h("strong", {}, x.label), " ", pill(x.status === "simulated" ? "SIMULATED" : x.status === "gated" ? "GATED" : "NOT BUILT", x.status === "simulated" ? "sim" : "")),
      h("div", {}, h("strong", {}, "What it would do: "), x.effect, " ", h("span", { class: "muted" }, "Reversible? " + x.reversible)),
      h("details", {}, h("summary", {}, "What it would take, what would be sent, and indicative permission scopes"),
        h("div", {}, h("strong", {}, "Needs: ")), h("ul", {}, x.requires.map((r) => h("li", {}, r))),
        h("div", {}, h("strong", {}, "Data it would send: "), x.dataSent.join(", ")), h("div", {}, h("strong", {}, "Indicative scopes: "), x.indicativeScopes.join(", "), h("div", { class: "hint" }, x.scopesNote)),
        h("div", {}, h("strong", {}, "To enable: "), x.enablementRequires)));
  }

  /* ---------------------------------------------------------------- read-only previews */
  function gateList(gates) { return h("ul", { class: "plain" }, gates.map((g) => h("li", {}, pill(g.met ? "met" : "NOT met", g.met ? "ok" : "bad"), " ", h("strong", {}, g.label), h("div", { class: "muted" }, g.detail)))); }
  function previewPanel() {
    const out = h("div", { id: "integ-preview-out", role: "status" });
    const camp = h("select", { "aria-label": "Campaign" }, (state.campaigns || []).map((c) => h("option", { value: c.id }, c.name)));
    const prop = h("select", { "aria-label": "Proposal" });
    const fillProposals = async () => {
      prop.replaceChildren();
      if (!camp.value) return;
      try { const c = await api(`/campaigns/${camp.value}`, { quiet: true }); prop.replaceChildren(...(c.proposals.length ? c.proposals.map((p) => h("option", { value: p.id }, `${p.status}, campaign version ${p.campaignVersion || p.campaign_version || "?"}`)) : [h("option", { value: "" }, "No proposal for this campaign")])); } catch { prop.replaceChildren(h("option", { value: "" }, "Not available")); }
    };
    camp.addEventListener("change", fillProposals); fillProposals();
    const lead = h("select", { "aria-label": "Lead" });
    api("/leads", { quiet: true }).then((ls) => lead.replaceChildren(...(ls.length ? ls.map((l) => h("option", { value: l.id }, `${l.fullName} (${l.origin})`)) : [h("option", { value: "" }, "No leads yet")]))).catch(() => {});
    const show = (node) => out.replaceChildren(node);
    return h("div", {},
      h("h4", {}, "Preview what a run would do (read-only)"), h("p", { class: "hint" }, "Shows exactly what would be sent and checks every precondition as of now. It changes nothing, queues nothing and sends nothing."),
      h("div", { class: "actions" }, camp, prop, h("button", { type: "button", class: "secondary", onclick: async () => {
        if (!prop.value) { show(h("p", { class: "hint" }, "Choose a proposal.")); return; }
        try {
          const d = await api(`/proposals/${prop.value}/dry-run`, { quiet: true });
          show(h("div", { class: "card" }, h("p", {}, h("strong", {}, d.whatWouldHappen)), d.wouldSend ? h("p", { class: "muted" }, `Would send: account ${d.wouldSend.accountId}, “${d.wouldSend.name}”, status ${d.wouldSend.status}, budget sent: ${d.wouldSend.budgetSent ? "yes" : "no"}. ${d.wouldSend.note}`) : null,
            h("p", {}, d.allGatesMet ? pill("every precondition is met", "ok") : pill("not everything is met", "bad")), gateList(d.gates), h("p", { class: "hint" }, d.note)));
        } catch (e) { show(h("p", { class: "flag-note" }, e && e.message ? e.message : "Not available.")); }
      } }, "Preview this proposal's run")),
      h("div", { class: "actions" }, lead, h("button", { type: "button", class: "secondary", onclick: async () => {
        if (!lead.value) { show(h("p", { class: "hint" }, "Choose a lead.")); return; }
        try {
          const d = await api(`/leads/${lead.value}/crm-dry-run`, { quiet: true });
          show(h("div", { class: "card" }, h("p", {}, h("strong", {}, d.whatWouldHappen)), h("p", {}, d.eligibility), d.wouldSend ? h("p", { class: "muted" }, `Would record: ${d.wouldSend.fullName}, ${d.wouldSend.email || "no email"}, ${d.wouldSend.phone || "no phone"} in ${d.wouldSend.destination}.`) : null, h("p", { class: "hint" }, d.note)));
        } catch (e) { show(h("p", { class: "flag-note" }, e && e.message ? e.message : "Not available.")); }
      } }, "Preview this lead's CRM sync")), out);
  }

  async function load() {
    const box = $("integ-registry");
    if (!session()) { box.replaceChildren(); return; }
    try { data = await api("/integrations", { quiet: true }); }
    catch { box.replaceChildren(h("p", { class: "hint" }, "The integration registry is for admins and owners.")); return; }
    const lock = data.executionLock;
    box.replaceChildren(
      h("div", { class: lock.externalEffectsPossibleNow ? "flag-note" : "panel" }, h("strong", {}, lock.externalEffectsPossibleNow ? "An integration is configured to reach an outside service. " : "Nothing here can reach the outside world. "), lock.summary,
        h("ul", {}, lock.reasons.map((r) => h("li", {}, r))), h("p", { class: "hint" }, data.note)),
      h("h4", {}, "Integrations"), h("ul", { class: "plain" }, data.adapters.map(adapterCard)),
      h("h4", {}, "Actions that could ever affect the outside world"), h("p", { class: "hint" }, "Each one needs, at minimum, what is listed here. Scopes are indicative and are checked against the vendor's documentation in a future review; nothing is requested today."), h("ul", { class: "plain" }, data.actionContracts.map(contractCard)),
      h("h4", {}, "Future channels (declared, not built)"), h("ul", { class: "plain" }, data.futureChannels.map(futureCard)),
      h("p", { class: "hint" }, "States: " + data.states.map((s) => s.label).join(", ") + "."),
      previewPanel());
  }
  return { load };
}
