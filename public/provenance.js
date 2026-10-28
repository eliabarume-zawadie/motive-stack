// "Where this came from": the SAVED Business Brain, labelled by the server as from a website (and which), entered by the owner, demo text, or a default.
// The server decides the labels (from what it recorded, reconciled on every save); this file only shows them. Built with textContent only (via h()).

const PV_LABEL = { website: "From", owner: "You entered this", demo: "Demo data", default: "Default (not set by you)" };
const PV_CLASS = { website: "ok", owner: "", demo: "warn", default: "warn" };

export function initProvenance({ $, h, api, pill }) {
  const label = (it) => pill(it.source === "website" ? `${PV_LABEL.website} ${it.site || "your website"}` : PV_LABEL[it.source], PV_CLASS[it.source]);

  function render(p) {
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
    try { render(await api("/brain/provenance", { quiet: true })); } catch { $("provenance-review").hidden = true; }
  }
  return { load, render };
}
