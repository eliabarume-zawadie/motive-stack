// Leads: the list (with a status the owner sets), and one lead's detail (where it came from, how its event was handled, CRM state, status history).
// Every lead here is labelled by the server as simulated or not; the CRM is a stand-in in this release. Built with textContent only (via h()).

const LEAD_STATUS_LABEL = { new: "New", contacted: "Contacted", qualified: "Qualified", won: "Won", lost: "Lost" };
const LEAD_STATUSES = Object.keys(LEAD_STATUS_LABEL);
const LEAD_ORIGIN = { synthetic: ["SYNTHETIC", "sim", "A test lead made by this app. Not a real person."], imported: ["IMPORTED", "warn", "Brought in by a person from somewhere else. Its source is their word, not a verified integration."], real: ["REAL", "ok", "Captured by a verified integration."], unknown: ["UNCLASSIFIED", "", "An older record that cannot be classified."] };
const LEAD_ATTRIBUTION = { observed: "attribution observed", inferred: "attribution inferred", unknown: "attribution unknown" };
const LEAD_NOT_SYNCED = "not_synced";

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

  function eraseControl(d) {
    if (!can("leads.erase")) return null;
    const why = h("input", { placeholder: "Why (kept in the audit trail, without any personal detail)", maxlength: "300", "aria-label": "Reason for erasing" });
    const sure = h("input", { type: "checkbox", "aria-label": "I understand this cannot be undone" });
    return h("div", { class: "card" }, h("strong", {}, "Erase this person's personal data"),
      h("p", { class: "hint" }, "Removes the name, e-mail address and phone number from this app, including the simulated CRM copy and the lead's status history. It cannot be undone. The audit trail keeps only that an erasure happened. A backup taken earlier still holds the data until it is retired."),
      h("div", { class: "actions" }, why, h("label", { class: "chk" }, sure, " I understand this cannot be undone"),
        h("button", { type: "button", class: "danger", onclick: () => {
          if (!why.value.trim()) { showNotice("Say why, so the reason is kept."); return; }
          if (!sure.checked) { showNotice("Tick the box to confirm."); return; }
          once("lead-erase-" + d.id, [], async () => {
            try { await api(`/leads/${d.id}/erase`, { method: "POST", body: { reason: why.value.trim() } }); showNotice("The person's personal data was erased."); openId = null; $("lead-detail").hidden = true; } catch { /* shown */ }
            await reload();
          });
        } }, "Erase personal data")));
  }

  function followUpEditor(d) {
    const date = h("input", { type: "date", value: d.followUp.dueDate || "", "aria-label": "Follow-up date", disabled: !can("leads.update") });
    const note = h("input", { value: d.followUp.note || "", maxlength: "300", placeholder: "What to do", "aria-label": "Follow-up note", disabled: !can("leads.update") });
    const save = (body, msg) => once("lead-fu-" + d.id, [], async () => { try { await api(`/leads/${d.id}/follow-up`, { method: "PUT", body }); showNotice(msg); } catch { /* shown */ } await reload(); });
    return h("div", {}, h("div", { class: "actions" }, date, note,
      h("button", { type: "button", class: "secondary", disabled: !can("leads.update"), onclick: () => (date.value ? save({ dueDate: date.value, note: note.value.trim() }, "Reminder saved.") : showNotice("Choose a date first.")) }, "Save reminder"),
      d.followUp.dueDate && !d.followUp.done ? h("button", { type: "button", class: "secondary", disabled: !can("leads.update"), onclick: () => save({ done: true }, "Marked done.") }, "Mark done") : null),
      h("p", { class: "hint" }, d.followUp.done ? "Done. " : "", "A reminder for your team only: this app does not send any message to a lead."));
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
        h("h3", {}, d.fullName, " ", pill(...(LEAD_ORIGIN[d.origin] || LEAD_ORIGIN.unknown).slice(0, 2)), " ", pill(LEAD_STATUS_LABEL[d.status] || d.status)),
        row("Contact", [d.email, d.phone].filter(Boolean).join(" / ") || "none given"),
        row("What it is", (LEAD_ORIGIN[d.origin] || LEAD_ORIGIN.unknown)[2]),
        row("Campaign", d.campaignName ? `${d.campaignName}, ${d.campaignVersion ? "version " + d.campaignVersion : "version not recorded"}` : "unknown"),
        row("How sure the campaign link is", [pill(LEAD_ATTRIBUTION[d.attribution.status] || d.attribution.status, d.attribution.status === "unknown" ? "bad" : ""), " ", d.attribution.basisText || "No basis recorded"]),
        h("p", { class: "hint" }, "Arriving after a campaign is not proof the campaign caused it. Only a verified integration can observe attribution, and none exists yet."),
        d.creative ? row("Creative", `${d.creative.id} version ${d.creative.version}${d.creative.ratio ? ", " + d.creative.ratio : ""}`) : null,
        d.form ? row("Form", `${d.form.id} version ${d.form.version}`) : null,
        row("UTM tags", ["source", "medium", "campaign", "content", "term"].filter((k) => d.utm[k]).map((k) => `${k}=${d.utm[k]}`).join(", ") || "none recorded"),
        row("Consent", `${d.consent.status === "given" ? "recorded as given" : "not recorded"}${d.consent.note ? ". " + d.consent.note : ""}`),
        row("Captured at its source", d.capturedAt ? stamp(d.capturedAt) : "not recorded"),
        row("Stored here", stamp(d.storedAt)),
        d.sameContact.length ? h("div", { class: "flag-note" }, "The same email or phone appears on another lead: ", d.sameContact.map((x) => `${x.name} (${(LEAD_ORIGIN[x.origin] || LEAD_ORIGIN.unknown)[0].toLowerCase()})`).join(", "), ". They are kept as separate records, never merged.") : null,
        row("Event id", h("span", { class: "muted" }, d.eventId)),
        row("Repeated events ignored", d.duplicateEventsIgnored ? `${d.duplicateEventsIgnored} (the same event id was sent again and not stored twice)` : "none"),
        row("CRM", [pill(d.crm.status, d.crm.status === "synced" ? "ok" : d.crm.status === "failed" ? "bad" : "warn"), " ", simBadge(), d.crm.contactId ? ` contact ${d.crm.contactId} (${d.crm.contactCreated ? "created" : "matched existing"})` : "", d.crm.error ? ` ${d.crm.error}` : ""]),
        h("p", { class: "hint" }, "The CRM is a built-in stand-in: no real contact was created and no email or text was sent."),
        h("h4", {}, "Follow-up reminder"),
        followUpEditor(d),
        h("h4", {}, "Status history"),
        d.history.length
          ? h("ul", { class: "plain" }, d.history.map((x) => h("li", {}, `${stamp(x.at)}: ${LEAD_STATUS_LABEL[x.from] || x.from} → ${LEAD_STATUS_LABEL[x.to] || x.to} by ${x.by}`, x.note ? h("div", { class: "muted" }, x.note) : null)))
          : h("p", { class: "hint" }, "No changes yet. The lead arrived as New."),
        eraseControl(d),
        h("button", { type: "button", class: "secondary", onclick: () => { openId = null; box.hidden = true; } }, "Close"),
      );
    } catch { box.hidden = true; }
  }

  // The page re-reads the leads every 1.5 seconds. Rebuilding an unchanged list would replace its buttons and selects (a click can be lost, an open menu closes) and reload the
  // open lead, wiping what was typed in it. The list is redrawn only when it, the open lead or the person's permission has changed.
  // Opening a lead changes openId, which redraws the list once (its button now says "Showing below"); that must NOT reload the lead that was just opened, or its Erase button is
  // replaced under the pointer and a reason typed into it is lost. The open lead is reloaded only when the lead data changed or its panel is empty.
  let lastKey = null, lastData = null;
  function render(leads) {
    const v = $("leads-view");
    const dataKey = JSON.stringify([leads, can("leads.erase")]);
    const key = `${dataKey}|${openId}`;
    if (key === lastKey && v.childNodes.length) return;
    lastKey = key;
    const dataChanged = dataKey !== lastData;
    lastData = dataKey;
    if (!leads.length) { v.replaceChildren(h("p", { class: "hint" }, "No leads yet.")); $("lead-detail").hidden = true; return; }
    v.replaceChildren(h("table", {}, h("thead", {}, h("tr", {}, ...["Lead", "Contact", "Status", "CRM sync", ""].map((x) => h("th", {}, x)))),
      h("tbody", {}, leads.map((l) => h("tr", {},
        h("td", {}, l.fullName, " ", pill(...(LEAD_ORIGIN[l.origin] || LEAD_ORIGIN.unknown).slice(0, 2)), h("div", { class: "muted" }, stamp(l.createdAt), " ", LEAD_ATTRIBUTION[l.attributionStatus] || "", l.campaignVersion ? `, campaign v${l.campaignVersion}` : ", version not recorded", l.sameContact ? `, same contact on ${l.sameContact} other lead${l.sameContact === 1 ? "" : "s"}` : ""), l.followUpDue && !l.followUpDone ? h("div", { class: "muted" }, "Follow up by " + l.followUpDue) : null),
        h("td", {}, [l.email, l.phone].filter(Boolean).join(" / ")),
        h("td", {}, statusSelect(l)),
        h("td", {}, pill(l.crmStatus, l.crmStatus === "synced" ? "ok" : l.crmStatus === "failed" ? "bad" : "warn"), l.crmError ? ` ${l.crmError}` : ""),
        h("td", {}, h("button", { type: "button", class: "secondary", onclick: () => showDetail(l.id) }, openId === l.id ? "Showing below" : "Details")))))));
    if (openId && leads.some((l) => l.id === openId)) { const box = $("lead-detail"); if (dataChanged || box.hidden || !box.childNodes.length) showDetail(openId); } else if (!leads.some((l) => l.id === openId)) $("lead-detail").hidden = true;
  }

  return { render, showDetail };
}
