// Brand: the Brand Kit (how the business wants to sound and look: preferences only) and the asset library (logos and images with rights and review).
// Every rule is enforced by the server; this file only shows state and sends requests. Files are previewed by fetching them with the page's own credentials and
// drawing them on a canvas, so no image URL or blob URL is needed. Built with textContent only (via h()).

const brandLines = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);
const BRAND_COLOR_RE = /^(.+?)\s+(#[0-9a-fA-F]{6})\s+(primary|secondary|accent|neutral|background|text)$/;
const BRAND_KIT_STATUS = { draft: ["DRAFT", ""], needs_review: ["WAITING FOR REVIEW", "warn"], approved: ["APPROVED", "ok"], rejected: ["REJECTED", "bad"] };
const BRAND_ASSET_STATUS = { draft: ["draft", ""], needs_review: ["waiting for review", "warn"], approved: ["approved", "ok"], rejected: ["rejected", "bad"], superseded: ["replaced by a newer approved version", ""] };
const BRAND_RIGHTS_TEXT = { owned: "We own it", licensed: "Licensed", stock: "Stock image", client_supplied: "Supplied by the client", unknown: "Rights not stated" };
const BRAND_SEPARATION_TEXT = { enforced: "A different person approved it.", not_enforceable_token_mode: "Approved with the shared local token: separation of duties could not be enforced.", policy_off: "Separation of duties is off for this workspace." };

export function initBrand({ $, h, api, state, can, once, pill, simBadge, showNotice, session, fetchFile }) {
  const stamp = (iso) => (iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "-");
  const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  let kit = null;

  /* ---------------------------------------------------------------- Brand Kit */
  function kitToForm(k) {
    const f = $("kit-form").elements;
    f.descriptors.value = k.voice.descriptors.join("\n");
    f.preferredTerms.value = k.voice.preferredTerms.join("\n");
    f.avoidTerms.value = k.voice.avoidTerms.join("\n");
    f.ctaStyle.value = k.voice.ctaStyle;
    f.colors.value = k.visual.colors.map((c) => `${c.name} ${c.hex} ${c.role}`).join("\n");
    f.typography.value = k.visual.typography;
    f.imageStyle.value = k.visual.imageStyle;
    f.logoRules.value = k.visual.logoRules;
    f.audiences.value = k.audiences.map((a) => (a.description ? `${a.name}: ${a.description}` : a.name)).join("\n");
    f.channels.value = k.channels.map((c) => (c.notes ? `${c.channel}: ${c.notes}` : c.channel)).join("\n");
    f.disclaimers.value = k.disclaimers.map((d) => (d.appliesTo ? `${d.text} | ${d.appliesTo}` : d.text)).join("\n");
    f.notes.value = k.notes;
  }

  /** Reads the form. A line that cannot be understood is reported by line, never guessed. */
  function formToKit() {
    const f = $("kit-form").elements;
    const colors = brandLines(f.colors.value).map((l, i) => {
      const m = BRAND_COLOR_RE.exec(l);
      if (!m) throw new Error(`Colour line ${i + 1} is not understood. Write it as: Name #1A4D8F primary (roles: primary, secondary, accent, neutral, background, text).`);
      return { name: m[1], hex: m[2], role: m[3] };
    });
    const pair = (l) => { const i = l.indexOf(":"); return i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]; };
    return {
      voice: { descriptors: brandLines(f.descriptors.value), preferredTerms: brandLines(f.preferredTerms.value), avoidTerms: brandLines(f.avoidTerms.value), ctaStyle: f.ctaStyle.value.trim() },
      visual: { colors, typography: f.typography.value.trim(), imageStyle: f.imageStyle.value.trim(), logoRules: f.logoRules.value.trim(), referenceAssetIds: kit?.kit.visual.referenceAssetIds || [] },
      audiences: brandLines(f.audiences.value).map((l) => { const [name, description] = pair(l); return { name, description }; }),
      channels: brandLines(f.channels.value).map((l) => { const [channel, notes] = pair(l); return { channel, notes }; }),
      disclaimers: brandLines(f.disclaimers.value).map((l) => { const [text, appliesTo] = l.includes("|") ? [l.slice(0, l.lastIndexOf("|")).trim(), l.slice(l.lastIndexOf("|") + 1).trim()] : [l, ""]; return { text, appliesTo }; }),
      notes: f.notes.value.trim(),
    };
  }

  function renderKitStatus() {
    const box = $("kit-status");
    if (!kit) { box.replaceChildren(); return; }
    const [label, cls] = BRAND_KIT_STATUS[kit.status] || [kit.status, ""];
    const kids = [pill(label, cls), " ", h("span", { class: "muted" }, kit.exists ? `version ${kit.version}` : "not saved yet")];
    if (kit.approvedVersion && kit.approvedVersion !== kit.version) kids.push(h("div", { class: "hint" }, `Version ${kit.approvedVersion} is the approved one. This newer version needs its own review before anything may rely on it.`));
    if (kit.decision && (kit.status === "approved" || kit.status === "rejected")) kids.push(h("div", { class: "hint" }, `${kit.status === "rejected" ? "Rejected" : "Decided"} ${stamp(kit.decision.at)}${kit.decision.reason ? `: ${kit.decision.reason}` : ""}${kit.decision.separation && kit.status === "approved" ? ". " + (BRAND_SEPARATION_TEXT[kit.decision.separation] || "") : ""}`));
    box.replaceChildren(...kids);
    const mayWrite = can("brandkit.write"), mayApprove = can("brandkit.approve");
    $("kit-save").disabled = !mayWrite;
    $("kit-submit").disabled = !mayWrite || !kit.exists || kit.status === "needs_review" || kit.status === "approved";
    $("kit-review").hidden = !(kit.status === "needs_review");
    $("kit-approve").disabled = !mayApprove; $("kit-reject").disabled = !mayApprove;
    $("kit-review-note").textContent = mayApprove ? `Review version ${kit.version}. Approving covers exactly this version.` : "Waiting for someone allowed to approve the Brand Kit (an admin or owner).";
  }

  async function kitAction(path, body, ok) {
    await once("kit-" + path, [$("kit-save"), $("kit-submit"), $("kit-approve"), $("kit-reject")], async () => {
      try { kit = await api(path, { method: "POST", body }); showNotice(ok); } catch { /* shown */ }
      if (kit) { kitToForm(kit.kit); renderKitStatus(); }
    });
  }

  function wireKit() {
    $("kit-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      let body;
      try { body = formToKit(); } catch (err) { $("kit-error").textContent = err.message; return; }
      $("kit-error").textContent = "";
      await once("kit-save", [$("kit-save")], async () => {
        try { kit = await api("/brand-kit", { method: "PUT", body }); showNotice(`Brand Kit saved (version ${kit.version}).`); } catch { /* shown */ }
        if (kit) { kitToForm(kit.kit); renderKitStatus(); }
      });
    });
    $("kit-submit").addEventListener("click", () => kitAction("/brand-kit/submit", undefined, "Submitted for review."));
    $("kit-approve").addEventListener("click", () => kitAction("/brand-kit/approve", { version: kit.version }, "Brand Kit approved."));
    $("kit-reject").addEventListener("click", () => {
      const reason = $("kit-reject-reason").value.trim();
      if (!reason) { $("kit-error").textContent = "Say why it is being rejected so it can be corrected."; return; }
      $("kit-error").textContent = "";
      kitAction("/brand-kit/reject", { version: kit.version, reason }, "Brand Kit rejected.");
    });
  }

  /* ---------------------------------------------------------------- assets */
  const readB64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("The file could not be read"));
    r.readAsDataURL(file);
  });

  async function preview(canvas, assetId, version) {
    try {
      if (typeof createImageBitmap !== "function") throw new Error("no preview");
      const bmp = await createImageBitmap(await fetchFile(`/assets/${assetId}/versions/${version}/file`));
      const s = Math.min(1, 160 / Math.max(bmp.width, bmp.height));
      canvas.width = Math.max(1, Math.round(bmp.width * s)); canvas.height = Math.max(1, Math.round(bmp.height * s));
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    } catch { canvas.replaceWith(h("span", { class: "muted" }, "Preview not available")); }
  }

  async function assetAction(label, path, body) {
    await once("asset-" + path, [], async () => {
      try { await api(path, { method: "POST", body }); showNotice(label); } catch { /* shown */ }
      await loadAssets();
    });
  }

  function assetCard(a) {
    const latest = a.versions[a.versions.length - 1];
    const canvas = h("canvas", { width: 1, height: 1, "aria-label": `Preview of ${a.name}`, class: "asset-preview" });
    const card = h("li", { class: "card asset" },
      h("div", { class: "asset-main" }, canvas, h("div", {},
        h("strong", {}, a.name), " ", pill(a.kind), " ", a.archived ? pill("archived") : null,
        h("div", { class: "muted" }, `${latest.width} x ${latest.height}, ${kb(latest.sizeBytes)}, ${latest.mime.replace("image/", "").toUpperCase()}`),
        a.approvedVersion ? h("div", {}, pill(`version ${a.approvedVersion} approved`, "ok")) : h("div", {}, pill("nothing approved yet", "warn"), h("span", { class: "hint" }, " Nothing may rely on this asset until a version is approved.")),
        a.duplicateOf.length ? h("div", { class: "flag-note" }, `The same file is already in the library (${a.duplicateOf.length} other asset${a.duplicateOf.length === 1 ? "" : "s"}).`) : null)),
      h("table", {}, h("thead", {}, h("tr", {}, ...["Version", "Status", "Source and rights", "Review", ""].map((x) => h("th", {}, x)))),
        h("tbody", {}, a.versions.map((v) => {
          const [sl, sc] = BRAND_ASSET_STATUS[v.status] || [v.status, ""];
          const acts = [];
          if (!a.archived) {
            if ((v.status === "draft" || v.status === "rejected") && can("assets.write")) acts.push(h("button", { type: "button", class: "secondary", onclick: () => assetAction("Submitted for review.", `/assets/${a.id}/versions/${v.version}/submit`) }, "Submit for review"));
            if (v.status === "needs_review") {
              if (can("assets.review")) {
                const why = h("input", { placeholder: "Reason (needed to reject)", maxlength: "300", "aria-label": "Rejection reason" });
                acts.push(h("button", { type: "button", onclick: () => assetAction("Approved.", `/assets/${a.id}/versions/${v.version}/approve`, {}) }, "Approve"), why,
                  h("button", { type: "button", class: "danger", onclick: () => (why.value.trim() ? assetAction("Rejected.", `/assets/${a.id}/versions/${v.version}/reject`, { reason: why.value.trim() }) : $("asset-error").replaceChildren("Say why it is being rejected so it can be corrected.")) }, "Reject"));
              } else acts.push(h("span", { class: "muted" }, "Waiting for an admin or owner."));
            }
          }
          return h("tr", {},
            h("td", {}, `v${v.version}`, v.parentVersion ? h("div", { class: "muted" }, `replaces v${v.parentVersion}`) : null),
            h("td", {}, pill(sl, sc)),
            h("td", {}, `${v.source === "imported" ? "Imported" : "Uploaded"}; ${BRAND_RIGHTS_TEXT[v.rights.basis] || v.rights.basis}`,
              v.rights.sourceNote ? h("div", { class: "muted" }, `Source: ${v.rights.sourceNote}`) : null, v.rights.licenseNote ? h("div", { class: "muted" }, `Licence: ${v.rights.licenseNote}`) : null,
              v.rights.usageRestrictions ? h("div", { class: "muted" }, `Restrictions: ${v.rights.usageRestrictions}`) : null, v.rights.expiresAt ? h("div", { class: "muted" }, `Rights expire ${v.rights.expiresAt}`) : null),
            h("td", {}, v.review ? [stamp(v.review.at), v.review.note ? h("div", { class: "muted" }, v.review.note) : null, v.review.separation ? h("div", { class: "hint" }, BRAND_SEPARATION_TEXT[v.review.separation] || "") : null] : "-"),
            h("td", {}, ...acts));
        }))),
      h("div", { class: "actions" },
        !a.archived && can("assets.write") ? h("label", { class: "inline-file" }, "Add a new version ", (() => {
          const inp = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", "aria-label": `New version of ${a.name}` });
          inp.addEventListener("change", async () => {
            const file = inp.files && inp.files[0]; if (!file) return;
            await once("asset-ver-" + a.id, [inp], async () => {
              try { await api(`/assets/${a.id}/versions`, { method: "POST", body: { source: "uploaded", rightsBasis: latest.rights.basis === "unknown" ? "unknown" : latest.rights.basis, data: await readB64(file) } }); showNotice("New version added as a draft. The approved version is unchanged until this one is approved."); } catch { /* shown */ }
              await loadAssets();
            });
          });
          return inp;
        })()) : null,
        !a.archived && can("assets.archive") ? h("button", { type: "button", class: "secondary", onclick: () => assetAction("Archived.", `/assets/${a.id}/archive`) }, "Archive") : null));
    preview(canvas, a.id, a.approvedVersion || a.currentVersion);
    return card;
  }

  async function loadAssets() {
    const box = $("asset-list");
    if (!session()) { box.replaceChildren(); return; }
    try {
      const r = await api("/assets", { quiet: true });
      $("asset-usage").textContent = `${r.usage.assets} asset${r.usage.assets === 1 ? "" : "s"}, ${kb(r.usage.bytes)} stored in the local development folder (no backup or retention is provided).`;
      box.replaceChildren(...(r.assets.length ? r.assets.map(assetCard) : [h("p", { class: "hint" }, "No assets yet. Upload a logo or an image you have the right to use.")]));
    } catch { box.replaceChildren(h("p", { class: "hint" }, "Assets are not available to your role.")); }
  }

  function wireUpload() {
    const form = $("asset-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = form.elements, file = f.file.files && f.file.files[0];
      $("asset-error").textContent = "";
      if (!file) { $("asset-error").textContent = "Choose a PNG, JPEG or WebP file."; return; }
      if (f.source.value === "imported" && !f.sourceNote.value.trim()) { $("asset-error").textContent = "Say where an imported file came from."; return; }
      await once("asset-upload", [$("asset-upload")], async () => {
        try {
          const body = { name: f.name.value.trim() || file.name, kind: f.kind.value, source: f.source.value, rightsBasis: f.rightsBasis.value, data: await readB64(file) };
          for (const k of ["licenseNote", "usageRestrictions", "sourceNote", "rightsExpiresAt"]) if (f[k].value.trim()) body[k] = f[k].value.trim();
          const a = await api("/assets", { method: "POST", body });
          showNotice(a.duplicateOf.length ? "Uploaded as a draft. The same file is already in the library." : "Uploaded as a draft. Submit it for review when its source and rights are stated.");
          form.reset();
        } catch { /* shown */ }
        await loadAssets();
      });
    });
  }

  async function load() {
    if (!session()) { kit = null; renderKitStatus(); $("asset-list").replaceChildren(); return; }
    try { kit = await api("/brand-kit", { quiet: true }); kitToForm(kit.kit); } catch { kit = null; }
    renderKitStatus();
    await loadAssets();
  }

  wireKit(); wireUpload();
  return { load, renderKitStatus };
}
