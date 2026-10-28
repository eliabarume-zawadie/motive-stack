// Leads: the list (with a status the owner sets), and one lead's detail (where it came from, how its event was handled, CRM state, status history).
// Every lead here is labelled by the server as simulated or not; the CRM is a stand-in in this release. Built with textContent only (via h()).

const LEAD_STATUS_LABEL = { new: "New", contacted: "Contacted", qualified: "Qualified", won: "Won", lost: "Lost" };
const LEAD_STATUSES = Object.keys(LEAD_STATUS_LABEL);

export function initLeads({ $, h, api, pill, simBadge, can, once, showNotice, state, reload }) {
  const stamp = (iso) => (iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "-");
  let openId = null;

  async function setStatus(id, status, select) {
    await once("lead-status-" + id, [select], async () => {
      try {
        const d = await api(`/leads/${id}/status`, { method: "PUT", body: { status } });
        showNotice(`Lead marked ${LEAD_STATUS_LABEL[d.status]}.`);
        openId = id;
        await reload();
      } catch { await reload(); /* the error is shown by api(); redraw to show the real status again */ }
    });
  }

  function statusSelect(l) {
    const allowed = can("leads.update");
    const sel = h("select", { "aria-label": `Status of ${l.fullName}`, disabled: !allowed, title: allowed ? null : "Your role does not allow changing a lead's status." },
      LEAD_STATUSES.map((s) => h("option", { value: s, selected: s === l.status }, LEAD_STATUS_LABEL[s])));
    sel.addEventListener("change", () => setStatus(l.id, sel.value, sel));
    return sel;
  }

  async function showDetail(id) {
    openId = id;
    const box = $("lead-detail");
    box.hidden = false;
    box.replaceChildren(h("p", { class: "hint" }, "Loading..."));
    try {
      const d = await api(`/leads/${id}`, { quiet: true });
      const row = (k, v) => h("div", {}, h("strong", {}, k + ": "), v);
      box.replaceChildren(
        h("h3", {}, d.fullName, " ", d.simulated ? simBadge() : null, " ", pill(LEAD_STATUS_LABEL[d.status] || d.status)),
        row("Contact", [d.email, d.phone].filter(Boolean).join(" / ") || "none given"),
        row("Campaign", d.campaignName || "unknown"),
        row("Source", d.source === "simulated" ? "Synthetic test lead (not a real person)" : d.source),
        row("Captured", stamp(d.capturedAt)),
        row("Event id", h("span", { class: "muted" }, d.eventId)),
        row("Repeated events ignored", d.duplicateEventsIgnored ? `${d.duplicateEventsIgnored} (the same event id was sent again and not stored twice)` : "none"),
        row("CRM", [pill(d.crm.status, d.crm.status === "synced" ? "ok" : d.crm.status === "failed" ? "bad" : "warn"), " ", simBadge(), d.crm.contactId ? ` contact ${d.crm.contactId} (${d.crm.contactCreated ? "created" : "matched existing"})` : "", d.crm.error ? ` ${d.crm.error}` : ""]),
        h("p", { class: "hint" }, "The CRM is a built-in stand-in: no real contact was created and no email or text was sent."),
        h("h4", {}, "Status history"),
        d.history.length
          ? h("ul", { class: "plain" }, d.history.map((x) => h("li", {}, `${stamp(x.at)}: ${LEAD_STATUS_LABEL[x.from] || x.from} → ${LEAD_STATUS_LABEL[x.to] || x.to} by ${x.by}`, x.note ? h("div", { class: "muted" }, x.note) : null)))
          : h("p", { class: "hint" }, "No changes yet. The lead arrived as New."),
        h("button", { type: "button", class: "secondary", onclick: () => { openId = null; box.hidden = true; } }, "Close"),
      );
    } catch { box.hidden = true; }
  }

  function render(leads) {
    const v = $("leads-view");
    if (!leads.length) { v.replaceChildren(h("p", { class: "hint" }, "No leads yet.")); $("lead-detail").hidden = true; return; }
    v.replaceChildren(h("table", {}, h("thead", {}, h("tr", {}, ...["Lead", "Contact", "Status", "CRM sync", ""].map((x) => h("th", {}, x)))),
      h("tbody", {}, leads.map((l) => h("tr", {},
        h("td", {}, l.fullName, " ", l.simulated ? simBadge() : null, h("div", { class: "muted" }, stamp(l.createdAt))),
        h("td", {}, [l.email, l.phone].filter(Boolean).join(" / ")),
        h("td", {}, statusSelect(l)),
        h("td", {}, pill(l.crmStatus, l.crmStatus === "synced" ? "ok" : l.crmStatus === "failed" ? "bad" : "warn"), l.crmError ? ` ${l.crmError}` : ""),
        h("td", {}, h("button", { type: "button", class: "secondary", onclick: () => showDetail(l.id) }, openId === l.id ? "Showing below" : "Details")))))));
    if (openId && leads.some((l) => l.id === openId)) showDetail(openId); else if (!leads.some((l) => l.id === openId)) $("lead-detail").hidden = true;
  }

  return { render, showDetail };
}
