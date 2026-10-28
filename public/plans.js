// Plans: ask for a rule-based plan (one separate campaign per service you confirmed), choose which opportunities to keep, set one daily total and each campaign's
// share, make the drafts, and review the exact budget. A plan is never approved as a whole: every campaign has its own proposal and approval. The server enforces
// every rule; this file shows state and sends requests. Built with textContent only (via h()).

const PLAN_OPP_STATUS = { suggested: ["suggested", ""], selected: ["selected", "ok"], excluded: ["left out", ""], saved: ["saved for later", ""], generating: ["being made", "warn"], generated: ["draft made", "ok"], failed: ["failed", "bad"] };
const PLAN_SKIP_TEXT = { duplicate_not_acknowledged: "was skipped: it repeats an existing campaign (confirm it should differ first)", share_missing: "was skipped: give it a share of the daily total first", not_available: "was skipped: someone else is making it" };

export function initPlans({ $, h, api, state, can, once, pill, usd, showNotice, openCampaign, session, reloadCampaigns }) {
  const dollars = (cents) => (cents == null ? "" : (cents / 100).toFixed(2));
  const cents = (v) => { const n = Math.round(Number(String(v).replace(/[$,]/g, "")) * 100); return Number.isFinite(n) && n > 0 ? n : null; };

  async function act(label, path, method, body) {
    let ok = false;
    await once("plan-" + method + path, [], async () => {
      try { await api(path, { method, body }); ok = true; if (label) showNotice(label); } catch { /* shown */ }
    });
    await load();
    if (ok && reloadCampaigns) await reloadCampaigns();
    return ok;
  }

  function oppRow(p, o) {
    const [sl, sc] = PLAN_OPP_STATUS[o.status] || [o.status, ""];
    const editable = can("plans.write") && !p.archived && o.status !== "generating";
    const status = h("select", { "aria-label": `What to do with ${o.title}`, disabled: !editable || o.status === "generated" },
      ["selected", "excluded", "saved"].map((v) => h("option", { value: v, selected: o.status === v || (o.status === "suggested" && v === "excluded") || (o.status === "failed" && v === "selected") }, { selected: "Make this campaign", excluded: "Leave it out", saved: "Save for later" }[v])));
    status.addEventListener("change", () => act("Updated.", `/plans/${p.id}/opportunities/${o.id}`, "PATCH", { status: status.value }));
    const share = h("input", { type: "number", min: "0.01", step: "0.01", value: dollars(o.allocationCents), "aria-label": `Daily share for ${o.title}, in dollars`, disabled: !editable, class: "plan-share" });
    share.addEventListener("change", () => { const c = cents(share.value); if (c) act("Share updated.", `/plans/${p.id}/opportunities/${o.id}`, "PATCH", { allocationCents: c }); });
    const kids = [h("strong", {}, o.title), " ", pill(sl, sc), h("div", { class: "hint" }, o.rationale), h("div", { class: "muted" }, `Angle: ${o.angle}`)];
    if (o.unknowns.length) kids.push(h("details", {}, h("summary", {}, "What is not known"), h("ul", { class: "plain" }, o.unknowns.map((u) => h("li", {}, u)))));
    if (o.duplicate) {
      const ack = h("input", { type: "checkbox", checked: o.duplicate.acknowledged, disabled: !editable, "aria-label": "This campaign should be separate from the existing one" });
      ack.addEventListener("change", () => act("Noted.", `/plans/${p.id}/opportunities/${o.id}`, "PATCH", { acknowledgeDuplicate: ack.checked }));
      kids.push(h("div", { class: "flag-note" }, o.duplicate.note, " ", h("label", { class: "chk" }, ack, " It should be a separate campaign")));
    }
    if (o.similar) kids.push(h("div", { class: "flag-note" }, `Its copy is very close to another campaign in this plan (${Math.round(o.similar.score * 100)}% of the words match). In mock mode the draft follows the service, not the angle.`));
    if (o.error) kids.push(h("div", { class: "flag-note" }, `It could not be made (${o.error.code}): ${o.error.message}. Choose "Make this campaign" and make drafts again to retry.`));
    const campaign = o.campaign ? h("div", {},
      pill(o.campaign.lifecycleLabel, o.campaign.lifecycle === "draft" ? "" : "ok"), " ", h("strong", {}, o.campaign.name), " ", h("span", { class: "muted" }, `version ${o.campaign.version}, ${o.campaign.dailyBudgetCents == null ? "budget unknown" : usd(o.campaign.dailyBudgetCents) + " per day"}`),
      o.campaign.overShare ? h("div", { class: "flag-note" }, "Its budget is above its share.") : null,
      h("div", { class: "actions" },
        h("button", { type: "button", class: "secondary", onclick: () => openCampaign(o.campaign.id) }, "Open details"),
        can("plans.write") && !p.archived && ["draft", "needs_review", "ready_for_approval"].includes(o.campaign.lifecycle) ? h("button", { type: "button", class: "secondary", onclick: () => act("A new version was written.", `/plans/${p.id}/opportunities/${o.id}/regenerate`, "POST", {}) }, "Write it again (new version)") : null)) : h("span", { class: "muted" }, "No draft yet");
    return h("tr", {}, h("td", {}, ...kids), h("td", {}, status), h("td", {}, share), h("td", {}, campaign));
  }

  function planCard(p) {
    const b = p.budget;
    const total = h("input", { type: "number", min: "0.01", step: "0.01", value: dollars(b.totalDailyCents), "aria-label": "Daily total for the plan, in dollars", disabled: !can("plans.write") || p.archived, class: "plan-share" });
    total.addEventListener("change", () => { const c = cents(total.value); if (c) act("Total updated.", `/plans/${p.id}`, "PATCH", { totalDailyBudgetCents: c }); });
    const selected = p.opportunities.filter((o) => o.status === "selected" || o.status === "failed").length;
    const review = b.review.done
      ? [pill("BUDGET REVIEWED", "ok"), h("span", { class: "hint" }, b.review.separation === "enforced" ? " A different person reviewed these numbers." : b.review.separation === "not_enforceable_token_mode" ? " Reviewed with the shared local token: separation of duties could not be enforced." : "")]
      : [pill(b.review.stale ? "REVIEW OUT OF DATE" : "NOT REVIEWED", "warn")];
    const card = h("li", { class: "card plan" },
      h("div", {}, h("strong", {}, p.name), " ", p.archived ? pill("archived") : null),
      h("p", { class: "hint" }, p.basis), h("p", { class: "hint" }, p.notice),
      h("p", { class: "hint" }, "Campaigns in a plan are independent: no order, schedule or dependency between them is enforced."),
      h("div", {}, h("label", {}, "Daily total for all its campaigns ($) ", total), h("span", { class: "muted" }, b.ceilingCents == null ? "" : ` Never above your daily limit of ${usd(b.ceilingCents)}, which covers ALL your plans and campaigns together. It is shared, not multiplied.`)),
      h("div", { class: "muted" }, `Planned shares: ${usd(b.plannedSharesCents)}. The campaigns made so far add up to ${usd(b.campaignsAddUpToCents)} per day.`),
      h("div", {}, ...review),
      p.gaps.length ? h("ul", { class: "plain" }, p.gaps.map((g) => h("li", { class: "flag-note" }, g))) : null,
      h("table", {}, h("thead", {}, h("tr", {}, ...["Opportunity", "What to do", "Daily share ($)", "Campaign"].map((x) => h("th", {}, x)))), h("tbody", {}, p.opportunities.map((o) => oppRow(p, o)))),
      h("div", { class: "actions" },
        can("plans.write") && !p.archived ? h("button", { type: "button", disabled: !selected, onclick: async () => {
          await once("plan-generate-" + p.id, [], async () => {
            try {
              const r = await api(`/plans/${p.id}/generate`, { method: "POST", body: {} });
              const made = r.results.filter((x) => x.outcome === "generated").length, failed = r.results.filter((x) => x.outcome === "failed").length;
              const skipped = r.results.filter((x) => x.outcome === "skipped").map((x) => PLAN_SKIP_TEXT[x.reason] || "was skipped");
              showNotice(`${made} draft${made === 1 ? "" : "s"} made${failed ? `, ${failed} failed` : ""}${skipped.length ? `; ${skipped.length} ${skipped[0]}` : ""}. Nothing is approved or sent.`);
            } catch { /* shown */ }
          });
          await load(); if (reloadCampaigns) await reloadCampaigns();
        } }, "Make drafts for the selected opportunities") : null,
        can("plans.write") && !p.archived && p.opportunities.some((o) => o.campaign?.overShare) ? h("button", { type: "button", class: "secondary", onclick: () => act("Campaigns lowered to their shares (new versions).", `/plans/${p.id}/apply-allocations`, "POST") }, "Lower campaigns to their shares") : null,
        can("plans.review") && !p.archived && b.totalDailyCents != null && !b.review.done ? h("button", { type: "button", onclick: () => act("Budget reviewed.", `/plans/${p.id}/budget-review`, "POST", { fingerprint: b.fingerprint }) }, "I reviewed the total and each campaign's budget") : null,
        !can("plans.review") && !b.review.done ? h("span", { class: "muted" }, "An admin or owner has to review the budget before these campaigns can be proposed.") : null,
        can("plans.write") && !p.archived ? h("button", { type: "button", class: "secondary", onclick: () => act("Plan archived.", `/plans/${p.id}/archive`, "POST") }, "Archive plan") : null));
    return card;
  }

  async function load() {
    const box = $("plan-list");
    if (!session()) { box.replaceChildren(); return; }
    try {
      const r = await api("/plans", { quiet: true });
      box.replaceChildren(...(r.plans.length ? r.plans.map(planCard) : [h("p", { class: "hint" }, "No plans yet. Ask for one to see one separate campaign for each service you offer.")]));
    } catch { box.replaceChildren(h("p", { class: "hint" }, "Plans are not available to your role.")); }
    $("plan-ask").disabled = !can("plans.write");
  }

  $("plan-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("plan-error").textContent = "";
    const f = e.target.elements, body = {};
    if (f.name.value.trim()) body.name = f.name.value.trim();
    if (f.total.value.trim()) { const c = cents(f.total.value); if (!c) { $("plan-error").textContent = "Enter the daily total in dollars, for example 15.00."; return; } body.totalDailyBudgetCents = c; }
    if (f.days.value.trim()) body.durationDays = Number(f.days.value);
    await once("plan-ask", [$("plan-ask")], async () => {
      try { await api("/plans/recommend", { method: "POST", body }); showNotice("Plan ready to review. Nothing was made yet."); f.name.value = ""; } catch (err) { $("plan-error").textContent = err.message; }
    });
    await load();
  });

  return { load };
}
