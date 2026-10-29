// Data, privacy and usage (admins and owners): what this workspace uses against its limits and what its AI cost per provider, and a download of everything it holds.
// The export has every secret removed. Erasing a lead is done from that lead's own page. Built with textContent only (via h()).

export function initPrivacy({ $, h, api, can, once, pill, showNotice, session, fetchFile }) {
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
  const usd = (micros) => `$${(micros / 1_000_000).toFixed(4)}`;

  async function download() {
    await once("privacy-export", [$("pv-export")], async () => {
      try {
        const blob = await fetchFile("/export");
        const url = URL.createObjectURL(blob);
        const a = h("a", { href: url, download: "motivestack-export.json" });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        showNotice("The export was downloaded. It contains personal data (your leads): keep it safe. Secrets are not in it.");
      } catch { showNotice("The export could not be made. Only admins and owners can export."); }
    });
  }

  async function load() {
    const box = $("pv-view");
    if (!session()) { box.replaceChildren(); return; }
    let u;
    try { u = await api("/usage", { quiet: true }); } catch { box.replaceChildren(h("p", { class: "hint" }, "Usage and data export are for admins and owners.")); return; }
    box.replaceChildren(
      h("h4", {}, "Usage against your limits"),
      h("table", {}, h("thead", {}, h("tr", {}, ...["What", "Used", "Limit"].map((x) => h("th", {}, x)))), h("tbody", {},
        ...u.quotas.map((q) => h("tr", {}, h("td", {}, q.label), h("td", {}, String(q.used)), h("td", {}, String(q.limit)))),
        h("tr", {}, h("td", {}, "Stored files"), h("td", {}, `${mb(u.storage.bytes)} in ${u.storage.assets} assets`), h("td", {}, `${mb(u.storage.maxBytes)}, ${u.storage.maxAssets} assets`)),
        h("tr", {}, h("td", {}, "Pictures today"), h("td", {}, String(u.pictures.today)), h("td", {}, String(u.pictures.dailyLimit))))),
      h("h4", {}, "AI use and cost, by provider and model"),
      u.ai.byProvider.length ? h("table", {}, h("thead", {}, h("tr", {}, ...["Provider", "Model", "Mode", "Requests", "Known cost", "Cost unknown"].map((x) => h("th", {}, x)))), h("tbody", {}, u.ai.byProvider.map((r) => h("tr", {}, h("td", {}, r.provider), h("td", {}, r.model), h("td", {}, pill(r.mode === "mock" ? "SIMULATED" : r.mode.toUpperCase(), r.mode === "mock" ? "sim" : "warn")), h("td", {}, String(r.attempts)), h("td", {}, r.mode === "mock" ? "none: simulated" : usd(r.knownCostMicros)), h("td", {}, String(r.requestsWithUnknownCost)))))) : h("p", { class: "hint" }, "No AI use yet."),
      h("p", { class: "hint" }, u.ai.note + " " + u.notes.join(" ")),
      h("h4", {}, "Your data"),
      h("p", { class: "hint" }, "Download everything this workspace holds as one JSON file. Every secret (the workspace token, stored credentials, file storage keys) is removed. Image files are not included, only their records. The file contains your leads' personal details, so keep it safe."),
      h("div", { class: "actions" }, h("button", { type: "button", id: "pv-export", class: "secondary", disabled: !can("data.export"), onclick: download }, "Download my workspace data")),
      h("p", { class: "hint" }, "To erase one person's details, open their lead under Leads and use “Erase this person's personal data”."));
  }
  return { load };
}
