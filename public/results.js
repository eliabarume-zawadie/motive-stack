// Results: what this workspace can and cannot measure. Every count is labelled with where it comes from, and synthetic, imported and real data are never added together.
// A metric that cannot be measured is shown as "not measured" with the reason, never as zero. The only charts are of lead counts held here, one per kind of data, never added together;
// there are no charts of performance because no verified performance data exists. Until leads exist, each chart has a labelled empty slot showing where it will appear.
// Built with textContent only (via h()).
import { donut, stackedBars } from "./charts.js";

const RESULTS_SOURCE = { actual: ["ACTUAL", "ok"], imported: ["IMPORTED", "warn"], user_entered: ["ENTERED BY YOUR TEAM", ""], simulated: ["SYNTHETIC", "sim"], estimated: ["PLANNED / ESTIMATE", ""], unknown: ["NOT KNOWN", "bad"] };
const RESULTS_STATUSES = [["new", "New"], ["contacted", "Contacted"], ["qualified", "Qualified"], ["won", "Won"], ["lost", "Lost"]];

export function initResults({ $, h, api, pill, session }) {
  const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

  function originCard(o) {
    const [lab, cls] = RESULTS_SOURCE[o.source] || [o.source, ""];
    return h("div", { class: "dash-card" }, h("h3", {}, o.label), h("div", {}, pill(lab, cls)),
      h("div", { class: "stat" }, h("strong", {}, String(o.leads)), h("span", { class: "muted" }, o.leads === 1 ? "lead" : "leads")),
      o.leads ? h("div", { class: "muted" }, RESULTS_STATUSES.map(([k, l]) => `${l}: ${o.byStatus[k]}`).join(" | ")) : null,
      o.leads ? h("div", { class: "muted" }, `Campaign link: ${o.attribution.observed} observed, ${o.attribution.inferred} inferred, ${o.attribution.unknown} unknown`) : null,
      h("p", { class: "hint" }, o.note));
  }

  function metricRow(m) {
    const [lab, cls] = RESULTS_SOURCE[m.sourceType] || [m.sourceType, ""];
    const value = !m.available ? h("strong", {}, "Not measured") : m.id === "planned_daily_commitment" ? h("strong", {}, `${usd(m.value)} per day`) : m.value !== null ? h("strong", {}, String(m.value)) : h("strong", {}, "See above");
    return h("tr", {}, h("td", {}, m.label), h("td", {}, value), h("td", {}, pill(lab, cls)), h("td", { class: "muted" }, m.why));
  }

  /** Where a chart will appear once there is data to draw. It draws nothing, so no number is invented. */
  const slot = (title, why) => h("div", { class: "dash-card chart-slot" }, h("h3", {}, title), h("p", { class: "hint" }, why));

  /** One status donut per kind of data that has leads, and one stacked-bar chart of leads by campaign per kind. */
  function chartsRow(a) {
    const withLeads = a.origins.filter((o) => o.leads > 0);
    const cards = [];
    for (const o of withLeads) {
      const [lab, cls] = RESULTS_SOURCE[o.source] || [o.source, ""];
      cards.push(h("div", { class: "dash-card" }, h("h3", {}, `Lead status: ${o.label}`), h("div", {}, pill(lab, cls)),
        donut({ label: `Lead status, ${o.label}`, parts: RESULTS_STATUSES.map(([k, l]) => ({ label: l, value: o.byStatus[k] })), caption: o.leads === 1 ? "lead" : "leads" })));
      const rows = a.campaigns.map((c) => ({ name: c.campaignName, o: c.byOrigin.find((x) => x.origin === o.origin) })).filter((r) => r.o && r.o.leads > 0);
      if (rows.length) cards.push(h("div", { class: "dash-card" }, h("h3", {}, `Leads by campaign: ${o.label}`), h("div", {}, pill(lab, cls)),
        stackedBars({ label: `Leads by campaign, ${o.label}`, names: RESULTS_STATUSES.map(([, l]) => l), categories: rows.map((r, i) => ({ label: String(i + 1), values: RESULTS_STATUSES.map(([k]) => r.o[k]) })) }),
        h("p", { class: "hint" }, rows.map((r, i) => `${i + 1} = ${r.name}`).join("; "))));
    }
    if (!withLeads.length) cards.push(
      slot("Lead status", "A chart of where your leads are (new, contacted, qualified, won, lost) will appear here once the first lead is recorded in Leads."),
      slot("Leads by campaign", "A chart of leads for each campaign will appear here once leads are linked to a campaign."));
    return h("div", { class: "dash-grid" }, ...cards);
  }

  async function load() {
    const box = $("rs-view");
    if (!session()) { box.replaceChildren(); return; }
    try {
      const a = await api("/analytics", { quiet: true });
      box.replaceChildren(
        h("p", { class: "hint" }, a.principle),
        h("div", { class: "dash-grid" }, a.origins.filter((o) => o.leads > 0 || o.origin === "real" || o.origin === "synthetic" || o.origin === "imported").map(originCard)),
        h("p", { class: "flag-note" }, a.attributionNote),
        h("h3", {}, "Leads at a glance"),
        chartsRow(a),
        h("h3", {}, "Campaign to lead to outcome"),
        a.campaigns.length ? h("table", {}, h("thead", {}, h("tr", {}, ...["Campaign", "Data", "Leads", "New", "Contacted", "Qualified", "Won", "Lost"].map((x) => h("th", {}, x)))),
          h("tbody", {}, a.campaigns.flatMap((c) => c.byOrigin.map((o, i) => h("tr", {}, h("td", {}, i === 0 ? c.campaignName : ""), h("td", {}, pill((RESULTS_SOURCE[a.origins.find((x) => x.origin === o.origin).source] || [o.origin])[0], (RESULTS_SOURCE[a.origins.find((x) => x.origin === o.origin).source] || [0, ""])[1])),
            h("td", {}, String(o.leads)), h("td", {}, String(o.new)), h("td", {}, String(o.contacted)), h("td", {}, String(o.qualified)), h("td", {}, String(o.won)), h("td", {}, String(o.lost))))))) : h("p", { class: "hint" }, "No leads yet."),
        h("p", { class: "hint" }, "Each row is one kind of data, counted on its own. These are the statuses your team set by hand; they do not show that a campaign caused any outcome."),
        h("h3", {}, "Follow-ups and consent"),
        h("p", {}, `${a.followUps.open} open follow-up reminder${a.followUps.open === 1 ? "" : "s"} (${a.followUps.overdue} overdue), ${a.followUps.done} done. `, a.followUps.note),
        h("p", {}, `Imported leads with consent: ${Object.entries(a.consent.imported).map(([k, v]) => `${v} ${k === "given" ? "stated as given" : "not recorded"}`).join(", ") || "none"}. `, a.consent.note),
        h("h3", {}, "What is and is not measured"),
        h("table", {}, h("thead", {}, h("tr", {}, ...["Measure", "Value", "Data", "Why"].map((x) => h("th", {}, x)))), h("tbody", {}, a.metrics.map(metricRow))),
        h("div", { class: "grid" }, h("div", {}, h("strong", {}, "Can be measured"), h("ul", {}, a.measurability.measurable.map((x) => h("li", {}, x)))), h("div", {}, h("strong", {}, "Cannot be measured yet"), h("ul", {}, a.measurability.notMeasurable.map((x) => h("li", {}, x))))));
    } catch { box.replaceChildren(h("p", { class: "hint" }, "Reporting is not available to your role.")); }
  }
  const nav = document.querySelector('#main-nav a[href="#s-results"]');
  if (nav) nav.addEventListener("click", () => { if (session()) load(); });
  return { load };
}
