// "Where this came from": the SAVED Business Brain, labelled by the server as from a website (and which), entered by the owner, demo text, or a default.
// The server decides the labels (from what it recorded, reconciled on every save); this file only shows them. Built with textContent only (via h()).

const PV_LABEL = { website: "From", owner: "You entered this", demo: "Demo data", default: "Default (not set by you)" };
const PV_CLASS = { website: "ok", owner: "", demo: "warn", default: "warn" };

/** The saved facts as cards: each card is a group of Business Brain fields, in the order a person reads them. */
const PF_CARDS = [
  { title: "About the business", fields: ["businessName", "industry", "description"] },
  { title: "Services", fields: ["services"] },
  { title: "Where and who", fields: ["serviceArea", "targetCustomer"] },
  { title: "Offer and tone", fields: ["offer", "tone"] },
  { title: "Strengths ads may use", fields: ["differentiators"] },
  { title: "Credentials, facts and prices", fields: ["verifiedFacts", "approvedPricing"] },
  { title: "Kept out of ads", fields: ["unverifiedClaims", "prohibitedClaims"] },
];
const PF_CORE = ["businessName", "industry", "services", "serviceArea", "targetCustomer", "offer"];

export function initProvenance({ $, h, api, pill }) {
  const label = (it) => pill(it.source === "website" ? `${PV_LABEL.website} ${it.site || "your website"}` : PV_LABEL[it.source], PV_CLASS[it.source]);

  function edit(field) {
    $("brain-details").open = true;
    $("brain-form").elements[field]?.focus();
  }

  function renderFacts(p) {
    const root = $("brain-facts");
    if (!p || !p.saved) {
      root.replaceChildren(h("div", { class: "card chart-slot" }, h("h3", {}, "Nothing saved yet"), h("p", { class: "hint" }, "Your saved business facts will appear here as cards, each showing where it came from, once you press Save Business Brain.")));
      return;
    }
    const entries = [...p.scalars.map((s) => ({ field: s.field, label: s.label, items: [s] })), ...p.lists.map((l) => ({ field: l.field, label: l.label, items: l.items }))];
    const cards = PF_CARDS.map((c) => ({ ...c, entries: entries.filter((e) => c.fields.includes(e.field)) })).filter((c) => c.entries.length);
    const sources = (c) => [...new Map(c.entries.flatMap((e) => e.items).map((it) => { const l = label(it); return [l.textContent, l]; })).values()];
    const core = PF_CORE.filter((f) => entries.some((e) => e.field === f)).length;
    root.replaceChildren(
      h("div", { class: "facts-grid" }, cards.map((c) => h("article", { class: "card fact" },
        h("div", { class: "fact-src" }, ...sources(c).flatMap((x) => [x, " "])),
        h("h4", {}, c.title),
        ...c.entries.map((e) => h("div", { class: "fact-row" },
          h("span", { class: "muted" }, e.label),
          e.items.length === 1 && !p.lists.some((l) => l.field === e.field) ? h("div", {}, e.items[0].value.length > 160 ? `${e.items[0].value.slice(0, 160)}...` : e.items[0].value)
            : h("ul", { class: "chips" }, e.items.map((it) => h("li", {}, it.value))))),
        h("div", { class: "fact-foot" }, h("button", { type: "button", class: "linklike", onclick: () => edit(c.entries[0].field) }, "Edit"))))),
      h("div", { class: "facts-bar" },
        h("span", {}, h("strong", {}, `${core} of ${PF_CORE.length} core facts filled in. `), core < PF_CORE.length ? "Add the rest under “Edit all business details”." : "Ads can use what you have approved above."),
        h("a", { href: "#s-brand", class: "btn-link" }, "Continue to Brand")));
  }

  function render(p) {
    renderFacts(p);
    const box = $("provenance-review");
    if (!p || !p.saved) { box.hidden = true; box.replaceChildren(); return; }
    box.hidden = false;
    const rows = [];
    for (const s of p.scalars) rows.push(h("li", {}, [h("strong", {}, `${s.label}: `), s.value.length > 90 ? `${s.value.slice(0, 90)}...` : s.value, " ", label(s)]));
    for (const l of p.lists) {
      rows.push(h("li", {}, [h("strong", {}, `${l.label}:`), h("ul", {}, l.items.map((it) => h("li", {}, [it.value, " ", label(it)])))]));
    }
    const c = p.counts;
    const summary = c.website
      ? `${c.website} saved item${c.website === 1 ? "" : "s"} came from your website, ${c.owner} you entered yourself${c.demo ? `, ${c.demo} demo` : ""}.`
      : `Nothing saved here came from a website: ${c.owner} item${c.owner === 1 ? "" : "s"} you entered yourself${c.demo ? `, ${c.demo} demo` : ""}${c.default ? `, ${c.default} default` : ""}.`;
    const recs = p.records.length
      ? [h("p", { class: "hint" }, "Records kept as evidence of where a website statement came from. They are not approved for ads unless marked so."), h("ul", {}, p.records.map((r) => h("li", {}, [r.text, " ", pill(r.approvedForMarketing ? "Approved for ads" : "Not approved for ads", r.approvedForMarketing ? "ok" : "warn"), " ", pill(r.status)])))]
      : [];
    box.replaceChildren(...[h("strong", {}, "Where the saved Business Brain came from"), h("p", { class: "hint" }, summary), h("ul", { class: "prov-list" }, rows), ...recs]);
  }

  async function load() {
    try { render(await api("/brain/provenance", { quiet: true })); } catch { $("provenance-review").hidden = true; renderFacts(null); }
  }
  $("facts-add").addEventListener("click", () => edit("businessName"));
  renderFacts(null);
  return { load, render };
}
