// Lead intake: bring in leads from elsewhere (labelled IMPORTED, never sent to a CRM) and define lead forms (definitions only, with clearly labelled test submissions).
// Nothing here publishes a form, contacts a lead, or sends data anywhere. The server enforces every rule; this file reads a pasted list and shows what came back.
// Built with textContent only (via h()).

const INTAKE_COLUMNS = { fullname: "fullName", name: "fullName", email: "email", phone: "phone", externalid: "externalId", capturedat: "capturedAt", utm_source: "source", utm_medium: "medium", utm_campaign: "campaign", utm_content: "content", utm_term: "term" };
const INTAKE_MODES = [["required", "Required"], ["optional", "Optional"], ["off", "Not asked"]];

/** Reads a pasted list: JSON (an array of lead objects) or CSV with a header row. A line that cannot be understood is reported by number, never guessed. */
export function parseIntakeRows(raw) {
  const t = String(raw || "").trim();
  if (!t) throw new Error("Paste your leads first.");
  if (t.startsWith("[")) { let a; try { a = JSON.parse(t); } catch { throw new Error("That is not valid JSON."); } if (!Array.isArray(a)) throw new Error("Expected a list of leads."); return a; }
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  const split = (line) => { const out = []; let cur = "", q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ",") { out.push(cur.trim()); cur = ""; } else cur += ch; } out.push(cur.trim()); return out; };
  const head = split(lines[0]).map((x) => x.toLowerCase());
  const keys = head.map((x) => INTAKE_COLUMNS[x]);
  if (!keys.includes("fullName")) throw new Error("The first line must be a header with a fullName (or name) column, then email, phone, externalId, capturedAt, utm_source, utm_medium, utm_campaign, utm_content, utm_term as needed.");
  return lines.slice(1).map((line) => {
    const cells = split(line), row = {}, utm = {};
    keys.forEach((k, i) => { const v = cells[i]; if (!k || !v) return; if (["source", "medium", "campaign", "content", "term"].includes(k)) utm[k] = v; else row[k] = v; });
    if (Object.keys(utm).length) row.utm = utm;
    return row;
  });
}

export function initIntake({ $, h, api, state, can, once, pill, showNotice, session, reloadLeads }) {
  const fail = (m) => { $("in-error").textContent = m || ""; };
  const campaignId = () => $("in-campaign").value || "";
  let forms = [];

  /* ---------------------------------------------------------------- import */
  function wireImport() {
    $("in-import-form").addEventListener("submit", (e) => {
      e.preventDefault();
      fail(""); $("in-result").replaceChildren();
      const f = $("in-import-form").elements;
      if (!campaignId()) { fail("Choose a campaign first."); return; }
      let rows;
      try { rows = parseIntakeRows(f.rows.value); } catch (err) { fail(err.message); return; }
      if (rows.length > 200) { fail("A batch can hold at most 200 leads. Split the list."); return; }
      if (!f.sourceNote.value.trim()) { fail("Say where these leads came from."); return; }
      once("in-import", [$("in-import-btn")], async () => {
        try {
          const r = await api("/leads/import", { method: "POST", body: { campaignId: campaignId(), sourceNote: f.sourceNote.value.trim(), consent: f.consent.value, rows } });
          showNotice(`${r.imported} lead${r.imported === 1 ? "" : "s"} imported.`);
          $("in-result").replaceChildren(h("p", {}, `${r.received} row${r.received === 1 ? "" : "s"} read: ${r.imported} imported, ${r.duplicates} already here (skipped), ${r.rejected.length} rejected.`),
            r.rejected.length ? h("ul", { class: "plain" }, r.rejected.map((x) => h("li", {}, `Row ${x.row}: ${x.reason}`))) : null, h("p", { class: "hint" }, r.note));
          f.rows.value = "";
          await reloadLeads();
          await loadBatches();
        } catch (err) { fail(err && err.message ? err.message : "The import did not work."); }
      });
    });
  }
  async function loadBatches() {
    const box = $("in-batches");
    if (!session()) { box.replaceChildren(); return; }
    try {
      const r = await api("/lead-imports", { quiet: true });
      box.replaceChildren(r.batches.length ? h("ul", { class: "plain" }, r.batches.map((b) => h("li", {}, `${b.at.replace("T", " ").slice(0, 16)} UTC: ${b.imported} of ${b.received} imported into “${b.campaignName || "a campaign"}” (${b.duplicates} duplicates, ${b.rejected} rejected). Source: ${b.sourceNote}. Consent ${b.consent === "given" ? "stated as given" : "not recorded"}.`))) : h("p", { class: "hint" }, "No imports yet."));
    } catch { box.replaceChildren(); }
  }

  /* ---------------------------------------------------------------- forms */
  function formCard(f) {
    const v = f.versions[f.versions.length - 1];
    const sub = (e) => {
      e.preventDefault();
      const el = e.target.elements;
      fail("");
      once("in-test-" + f.id, [], async () => {
        try {
          const body = { fullName: el.fullName.value.trim(), consent: el.consent.checked };
          if (el.email.value.trim()) body.email = el.email.value.trim();
          if (el.phone.value.trim()) body.phone = el.phone.value.trim();
          if (el.utm_campaign.value.trim()) body.utm = { campaign: el.utm_campaign.value.trim() };
          await api(`/forms/${f.id}/test-submission`, { method: "POST", body });
          showNotice("Test lead recorded. It is labelled SYNTHETIC and was sent nowhere.");
          await reloadLeads();
        } catch (err) { fail(err && err.message ? err.message : "That did not work."); }
      });
    };
    const field = (name, label, mode, attrs = {}) => mode === "off" ? null : h("label", {}, `${label}${mode === "required" ? " (required)" : ""} `, h("input", { name, ...attrs }));
    return h("li", { class: "card" },
      h("div", {}, h("strong", {}, f.name), " ", pill(`version ${f.currentVersion}`), " ", pill("NOT PUBLISHED", "sim")),
      h("p", { class: "hint" }, f.publishNote),
      h("div", { class: "muted" }, `Made for campaign version ${v.campaignVersion}. Purpose: ${v.purpose}. Kept: ${v.retentionNote}.`),
      h("div", { class: "card" }, h("strong", {}, "Preview"), h("p", {}, v.privacyNotice),
        h("form", { class: "grid", onsubmit: sub }, h("label", {}, "Name (required) ", h("input", { name: "fullName", required: true, maxlength: "100" })),
          field("email", "Email", v.fields.email, { type: "email" }) || h("input", { name: "email", type: "hidden" }), field("phone", "Phone", v.fields.phone) || h("input", { name: "phone", type: "hidden" }),
          h("label", {}, "utm_campaign (optional) ", h("input", { name: "utm_campaign", maxlength: "100" })),
          h("label", { class: "chk wide" }, h("input", { type: "checkbox", name: "consent" }), ` ${v.consentText}`),
          h("div", { class: "wide" }, h("button", { type: "submit", class: "secondary", "data-needs": "leads.simulate", disabled: !can("leads.simulate") }, "Submit as a test"), " ", h("span", { class: "hint" }, "Records one SYNTHETIC test lead. Nothing is sent.")))));
  }
  async function loadForms() {
    const box = $("in-forms");
    if (!session() || !campaignId()) { forms = []; box.replaceChildren(); return; }
    try { forms = (await api(`/campaigns/${campaignId()}/forms`, { quiet: true })).forms; box.replaceChildren(forms.length ? h("ul", { class: "plain" }, forms.map(formCard)) : h("p", { class: "hint" }, "No form for this campaign yet.")); }
    catch { box.replaceChildren(h("p", { class: "hint" }, "Forms are not available to your role.")); }
  }
  function wireForm() {
    const modes = (name) => INTAKE_MODES.map(([v, l]) => h("option", { value: v }, l));
    $("in-form-email").replaceChildren(...modes()); $("in-form-phone").replaceChildren(...modes());
    $("in-form-email").value = "required"; $("in-form-phone").value = "optional";
    $("in-form-define").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = $("in-form-define").elements;
      fail("");
      if (!campaignId()) { fail("Choose a campaign first."); return; }
      once("in-form-create", [$("in-form-btn")], async () => {
        try {
          await api(`/campaigns/${campaignId()}/forms`, { method: "POST", body: { name: f.name.value.trim(), fields: { email: f.email.value, phone: f.phone.value }, privacyNotice: f.privacyNotice.value.trim(), consentText: f.consentText.value.trim(), purpose: f.purpose.value.trim(), retentionNote: f.retentionNote.value.trim() } });
          showNotice("Form saved. It is a definition only: it is not published anywhere.");
          await loadForms();
        } catch (err) { fail(err && err.message ? err.message : "That did not work."); }
      });
    });
  }

  async function load() {
    const sel = $("in-campaign");
    if (!session()) { sel.replaceChildren(); $("in-forms").replaceChildren(); $("in-batches").replaceChildren(); return; }
    const keep = sel.value, list = state.campaigns || [];
    sel.replaceChildren(...(list.length ? list.map((c) => h("option", { value: c.id }, c.name)) : [h("option", { value: "" }, "No campaigns yet")]));
    if (keep && list.some((c) => c.id === keep)) sel.value = keep;
    await Promise.all([loadForms(), loadBatches()]);
  }
  sel_wire();
  function sel_wire() { $("in-campaign").addEventListener("change", loadForms); }
  wireImport(); wireForm();
  // Campaigns created elsewhere appear when this section is opened (no timer is used just to look live).
  const navLink = document.querySelector('#main-nav a[href="#s-leads"]');
  if (navLink) navLink.addEventListener("click", () => { if (session()) load(); });
  return { load };
}
