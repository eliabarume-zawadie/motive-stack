// Creative: make the pictures for a campaign (still images only), check them, and send them for approval.
// Everything here is MOCK: the pictures are placeholders drawn on this computer, no image service is contacted, nothing is published and nothing costs money.
// Every rule is enforced by the server; this file only shows state and sends requests. Pictures are previewed by fetching them with the page's own
// credentials and drawing them on a canvas, so no image URL is needed. Built with textContent only (via h()).

const CREATIVE_RATIO = { "1:1": { label: "Square", use: "Feed", value: 1 }, "4:5": { label: "Portrait", use: "Feed (tall)", value: 0.8 }, "9:16": { label: "Vertical", use: "Stories and Reels", value: 0.5625 }, "1.91:1": { label: "Landscape", use: "Link ads", value: 1.91 } };
const CREATIVE_STATUS = { draft: ["DRAFT", ""], needs_review: ["WAITING FOR REVIEW", "warn"], approved: ["APPROVED", "ok"], rejected: ["REJECTED", "bad"], superseded: ["REPLACED BY A NEWER VERSION", ""] };
const CREATIVE_QA_STATUS = { pass: ["passed", "ok"], fail: ["fix this", "bad"], warn: ["check", "warn"], info: ["note", ""], not_checked: ["not checked", ""], not_performed: ["not performed", ""] };
const CREATIVE_QA_GROUP = { technical: "Technical", brand: "Brand", factual: "Claims", rights: "Rights", accessibility: "Accessibility", critique: "AI critique" };
const CREATIVE_STAGE = { queued: "Waiting to start", generating: "Making the picture", validating: "Checking the picture", storing: "Saving the picture", done: "Done" };
const CREATIVE_SEPARATION = { enforced: "A different person approved it.", not_enforceable_token_mode: "Approved with the shared local token: separation of duties could not be enforced.", policy_off: "Separation of duties was off when it was approved." };
const CREATIVE_CTA = { GET_QUOTE: "Get a quote", LEARN_MORE: "Learn more", SIGN_UP: "Sign up" };

export function initCreative({ $, h, api, state, can, once, pill, showNotice, session, fetchFile }) {
  const stamp = (iso) => (iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "-");
  let creatives = [];
  let approvedImages = [];
  let providerNote = "";
  const picked = new Map(); // creative id -> version being looked at
  const checked = new Map(); // "id:version" -> result of "Check now"
  let pollTimer = null;
  let pollCount = 0;
  let loadSeq = 0;

  const campaignId = () => $("cr-campaign").value || "";
  const fail = (msg) => { $("cr-error").textContent = msg || ""; };

  async function preview(canvas, id, version, ratio) {
    try {
      if (typeof createImageBitmap !== "function") throw new Error("no preview");
      const bmp = await createImageBitmap(await fetchFile(`/creatives/${id}/versions/${version}/pictures/${encodeURIComponent(ratio)}/file`));
      const s = Math.min(1, 200 / Math.max(bmp.width, bmp.height));
      canvas.width = Math.max(1, Math.round(bmp.width * s)); canvas.height = Math.max(1, Math.round(bmp.height * s));
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    } catch { canvas.replaceWith(h("span", { class: "muted" }, "Preview not available")); }
  }

  async function act(key, label, fn) {
    await once("cr-" + key, [], async () => {
      fail("");
      try { await fn(); if (label) showNotice(label); } catch (e) { fail(e && e.message ? e.message : "That did not work."); }
      await loadCreatives({ quiet: true });
    });
  }

  /* ---------------------------------------------------------------- the checks */
  function qaBlock(qa, heading) {
    if (!qa) return h("p", { class: "hint" }, "The automatic checks have not been run on this version yet. Press Check now.");
    const groups = Object.keys(CREATIVE_QA_GROUP).map((g) => [g, qa.checks.filter((c) => c.group === g)]).filter(([, list]) => list.length);
    return h("div", { class: "qa" },
      h("p", {}, h("strong", {}, heading || "Automatic checks"), " ", qa.passed ? pill("no blocking problems", "ok") : pill("problems to fix", "bad"), " ",
        h("span", { class: "muted" }, qa.score.percent === null ? "" : `${qa.score.percent}% of ${qa.score.of} automatic checks passed. `), h("span", { class: "hint" }, qa.score.note)),
      groups.map(([g, list]) => h("div", {}, h("div", { class: "muted" }, CREATIVE_QA_GROUP[g]), h("ul", { class: "plain" }, list.map((c) => {
        const [lab, cls] = CREATIVE_QA_STATUS[c.status] || [c.status, ""];
        return h("li", {}, pill(lab, cls), " ", h("strong", {}, c.label), ": ", c.message, c.repair ? h("div", { class: "hint" }, `What to do: ${c.repair}`) : null);
      })))),
      h("p", { class: "hint" }, "These are automatic rules. They are not an AI review and not a prediction of results; a person still decides."));
  }

  /* ---------------------------------------------------------------- one picture slot */
  function slot(cr, v, ratio, editable) {
    const variant = v.variants.find((x) => x.ratio === ratio) || null;
    const renders = v.renders.filter((r) => r.ratio === ratio);
    const last = renders[renders.length - 1] || null;
    const spec = CREATIVE_RATIO[ratio];
    const kids = [h("div", {}, h("strong", {}, ratio), " ", h("span", { class: "muted" }, `${spec.label}, ${spec.use}`))];
    if (variant) {
      const canvas = h("canvas", { width: 1, height: 1, "aria-label": `Preview of the ${ratio} picture`, class: "asset-preview" });
      kids.push(canvas);
      preview(canvas, cr.id, v.version, ratio);
      const mock = variant.source === "generated" && String(variant.provider || "").startsWith("mock");
      kids.push(h("div", { class: "muted" }, variant.source === "imported" ? "An approved image you attached" : mock ? "Placeholder from the offline mock: not real artwork" : "Made in this studio", ` (${variant.width} x ${variant.height})`));
      if (mock) kids.push(h("div", {}, pill("PLACEHOLDER", "sim")));
    } else kids.push(h("div", { class: "muted" }, "No picture yet"));
    if (last && (last.status === "queued" || last.status === "running")) {
      kids.push(h("div", { role: "status" }, pill(CREATIVE_STAGE[last.stage] || last.stage, "warn"), last.attempts > 1 ? h("span", { class: "muted" }, ` attempt ${last.attempts}`) : null));
      if (can("creatives.write")) kids.push(h("button", { type: "button", class: "secondary", onclick: () => act("cancel-" + last.id, "Cancelled.", () => api(`/renders/${last.id}/cancel`, { method: "POST" })) }, "Cancel"));
    } else if (last && last.status === "failed") {
      kids.push(h("div", { class: "flag-note", role: "status" }, `The picture could not be made: ${last.error ? last.error.message || last.error.code : "it failed"}.`, last.error ? h("div", { class: "hint" }, `What to do: ${last.error.repair}`) : null));
      if (editable && can("creatives.write") && last.canRetry) kids.push(h("button", { type: "button", class: "secondary", onclick: () => act("retry-" + last.id, "Trying again.", () => api(`/renders/${last.id}/retry`, { method: "POST" })) }, "Try again"));
    } else if (last && last.status === "cancelled" && !variant) kids.push(h("div", { class: "muted" }, "Cancelled."));
    if (editable && can("creatives.write")) {
      const eligible = approvedImages.filter((a) => Math.abs(a.width / a.height - spec.value) / spec.value <= 0.01);
      if (eligible.length) {
        const pick = h("select", { "aria-label": `Attach an approved image for ${ratio}` }, h("option", { value: "" }, "Attach an approved image..."), eligible.map((a) => h("option", { value: `${a.assetId}:${a.version}` }, `${a.name} (v${a.version})`)));
        kids.push(h("div", { class: "actions" }, pick, h("button", { type: "button", class: "secondary", onclick: () => {
          if (!pick.value) { fail("Choose an image to attach."); return; }
          const [assetId, ver] = pick.value.split(":");
          act("attach-" + cr.id + ratio, "Attached.", () => api(`/creatives/${cr.id}/versions/${v.version}/images`, { method: "POST", body: { ratio, assetId, assetVersion: Number(ver) } }));
        } }, "Attach")));
      }
    }
    return h("li", { class: "card cr-slot" }, kids);
  }

  /* ---------------------------------------------------------------- the editable copy */
  function versionForm(cr, v) {
    const k = v.concept, b = v.brief;
    const f = (name, label, value, attrs = {}) => h("label", { class: attrs.wide ? "wide" : "" }, label, " ", h("input", { name, value: value ?? "", maxlength: attrs.max || "200", ...(attrs.type ? { type: attrs.type } : {}) }));
    const area = (name, label, value, max) => h("label", { class: "wide" }, label, " ", h("textarea", { name, rows: "2", maxlength: String(max) }, value ?? ""));
    const ratioBoxes = Object.keys(CREATIVE_RATIO).map((r) => h("label", { class: "chk" }, h("input", { type: "checkbox", name: "ratio", value: r, ...(v.ratios.includes(r) ? { checked: true } : {}) }), ` ${r} ${CREATIVE_RATIO[r].label}`));
    const sel = h("select", { name: "callToAction" }, Object.entries(CREATIVE_CTA).map(([val, lab]) => h("option", { value: val, ...(val === k.callToAction ? { selected: true } : {}) }, lab)));
    const form = h("form", { class: "grid" },
      f("objective", "What this ad is for", b.objective), f("keyMessage", "The main message", b.keyMessage), f("audienceNote", "Who it is for (optional)", b.audienceNote), f("visualDirection", "Look and feel (optional)", b.visualDirection, { max: "400" }),
      f("headline", "Headline (up to 40 characters)", k.headline, { max: "40" }), f("subline", "Supporting line (up to 125)", k.subline, { max: "125" }),
      h("label", {}, "Call to action ", sel),
      area("visualDescription", "What the picture should show", k.visualDescription, 400),
      f("background", "Background colour", k.palette.background, { max: "7" }), f("foreground", "Text colour", k.palette.foreground, { max: "7" }), f("accent", "Accent colour", k.palette.accent, { max: "7" }),
      area("altText", "Alt text: describe the picture for someone who cannot see it", v.altText, 300),
      h("fieldset", { class: "wide" }, h("legend", {}, "Formats"), ratioBoxes),
      h("div", { class: "wide" }, h("button", { type: "submit", "data-needs": "creatives.write", "data-busy-label": "Saving..." }, "Save as a new version"), " ", h("span", { class: "hint" }, "Saving never changes a version that exists: it makes a new one. Pictures are kept when the look has not changed.")));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const el = form.elements;
      const ratios = [...form.querySelectorAll("input[name=ratio]")].filter((c) => c.checked).map((c) => c.value);
      if (!ratios.length) { fail("Choose at least one format."); return; }
      act("save-" + cr.id, "Saved as a new version.", async () => {
        const r = await api(`/creatives/${cr.id}/versions`, { method: "POST", body: {
          brief: { objective: el.objective.value.trim(), keyMessage: el.keyMessage.value.trim(), audienceNote: el.audienceNote.value.trim(), visualDirection: el.visualDirection.value.trim() },
          concept: { headline: el.headline.value.trim(), subline: el.subline.value.trim(), callToAction: el.callToAction.value, visualDescription: el.visualDescription.value.trim(), palette: { background: el.background.value.trim(), foreground: el.foreground.value.trim(), accent: el.accent.value.trim() } },
          altText: el.altText.value.trim(), ratios } });
        picked.set(cr.id, r.currentVersion);
      });
    });
    return form;
  }

  /* ---------------------------------------------------------------- one creative */
  function creativeCard(cr) {
    const v = cr.versions.find((x) => x.version === (picked.get(cr.id) ?? cr.currentVersion)) || cr.versions[cr.versions.length - 1];
    const editable = v.status === "draft" || v.status === "rejected";
    const [sl, sc] = CREATIVE_STATUS[v.status] || [v.status, ""];
    const key = `${cr.id}:${v.version}`;
    const busyRender = v.renders.some((r) => r.status === "queued" || r.status === "running");
    const missing = v.ratios.filter((r) => !v.variants.some((x) => x.ratio === r) && !v.renders.some((x) => x.ratio === r && (x.status === "queued" || x.status === "running")));
    const why = h("input", { placeholder: "Reason (needed to reject)", maxlength: "300", "aria-label": "Rejection reason" });
    const buttons = [];
    if (editable && can("creatives.write")) {
      buttons.push(h("button", { type: "button", disabled: busyRender, onclick: () => act("make-" + key, "Making the pictures. This is a placeholder mock; nothing is sent anywhere.", () => api(`/creatives/${cr.id}/versions/${v.version}/renders`, { method: "POST", body: missing.length && missing.length < v.ratios.length ? { ratios: missing } : {} })) }, v.variants.length ? (missing.length ? "Make the missing pictures" : "Make the pictures again") : "Make the pictures"));
      buttons.push(h("button", { type: "button", class: "secondary", onclick: () => act("submit-" + key, "Sent for review.", () => api(`/creatives/${cr.id}/versions/${v.version}/submit`, { method: "POST" })) }, "Send for review"));
    }
    buttons.push(h("button", { type: "button", class: "secondary", onclick: () => act("check-" + key, "", async () => { checked.set(key, await api(`/creatives/${cr.id}/versions/${v.version}/check`, { method: "POST" })); }) }, "Check now"));
    if (v.status === "needs_review") {
      if (can("creatives.review")) buttons.push(h("button", { type: "button", onclick: () => act("approve-" + key, "Approved.", () => api(`/creatives/${cr.id}/versions/${v.version}/approve`, { method: "POST", body: {} })) }, "Approve this version"), why,
        h("button", { type: "button", class: "danger", onclick: () => (why.value.trim() ? act("reject-" + key, "Rejected.", () => api(`/creatives/${cr.id}/versions/${v.version}/reject`, { method: "POST", body: { reason: why.value.trim() } })) : fail("Say why it is being rejected so it can be corrected.")) }, "Reject"));
      else buttons.push(h("span", { class: "muted" }, "Waiting for an admin or owner."));
    }
    if (can("creatives.write")) buttons.push(h("button", { type: "button", class: "secondary", onclick: () => act("archive-" + cr.id, "Archived.", () => api(`/creatives/${cr.id}/archive`, { method: "POST" })) }, "Archive"));

    const history = h("div", { class: "actions" }, h("span", { class: "muted" }, "Versions: "), cr.versions.map((x) => {
      const [lab] = CREATIVE_STATUS[x.status] || [x.status];
      return h("button", { type: "button", class: x.version === v.version ? "" : "secondary", "aria-pressed": x.version === v.version ? "true" : "false", onclick: () => { picked.set(cr.id, x.version); renderList(); } }, `v${x.version} ${lab.toLowerCase()}`);
    }));

    return h("li", { class: "card creative" },
      h("div", {}, h("strong", {}, cr.name), " ", pill(sl, sc), " ", cr.approvedVersion ? pill(`version ${cr.approvedVersion} is the approved one`, "ok") : pill("nothing approved yet", "warn")),
      v.campaignMovedOn ? h("div", { class: "flag-note" }, "The campaign has changed since this version was made. The copy here is checked again before it can be approved.") : null,
      history,
      h("ul", { class: "plain cr-slots" }, v.ratios.map((r) => slot(cr, v, r, editable))),
      h("div", { class: "actions" }, buttons),
      v.review ? h("p", { class: "hint" }, `${v.status === "rejected" ? "Rejected" : "Decided"} ${stamp(v.review.at)}${v.review.note ? ": " + v.review.note : ""}. ${CREATIVE_SEPARATION[v.review.separation] || ""}`) : null,
      qaBlock(checked.get(key) || v.qa, checked.get(key) ? "Automatic checks (just now)" : v.qa ? "Automatic checks (as last run)" : undefined),
      h("details", {}, h("summary", {}, editable ? "Edit the words, colours and formats" : "See or change the words, colours and formats (saves a new version)"), versionForm(cr, v)));
  }

  function renderList() {
    $("cr-list").replaceChildren(...(creatives.length ? creatives.map(creativeCard) : [h("p", { class: "hint" }, campaignId() ? "No creative for this campaign yet. Start from an idea below." : "Create a campaign first (Campaigns), then come back here.")]));
  }

  function renderConcepts(r) {
    const box = $("cr-concepts");
    if (!r || !can("creatives.write")) { box.replaceChildren(); return; }
    box.replaceChildren(h("p", { class: "hint" }, r.note, r.brandKitApproved ? "" : " Your Brand Kit is not approved, so default colours are used."), h("ul", { class: "plain" }, r.concepts.map((c) => h("li", { class: "card" },
      h("strong", {}, c.title), ": ", c.concept.headline, c.concept.subline ? h("div", { class: "muted" }, c.concept.subline) : null,
      h("div", { class: "actions" }, h("button", { type: "button", onclick: () => act("concept-" + c.title, "Saved as a draft. Make its pictures next.", async () => {
        const camp = (state.campaigns || []).find((x) => x.id === campaignId());
        const made = await api(`/campaigns/${campaignId()}/creatives`, { method: "POST", body: { name: `${camp ? camp.name : "Campaign"} - ${c.title}`.slice(0, 80), brief: c.brief, concept: c.concept, altText: c.altText, ratios: c.ratios } });
        picked.set(made.id, made.currentVersion);
      }) }, "Use this idea"))))));
  }

  /* ---------------------------------------------------------------- loading */
  async function loadCreatives({ quiet = false } = {}) {
    const seq = ++loadSeq;
    clearTimeout(pollTimer);
    const id = campaignId();
    if (!session() || !id) { creatives = []; renderList(); renderConcepts(null); return; }
    try {
      const [list, concepts, assets] = await Promise.all([
        api(`/campaigns/${id}/creatives`, { quiet: true }),
        can("creatives.write") ? api(`/campaigns/${id}/creative-concepts`, { quiet: true }).catch(() => null) : Promise.resolve(null),
        can("assets.read") ? api("/assets", { quiet: true }).catch(() => ({ assets: [] })) : Promise.resolve({ assets: [] }),
      ]);
      if (seq !== loadSeq) return; // a newer load replaced this one
      creatives = list.creatives;
      approvedImages = assets.assets.filter((a) => !a.archived && a.approvedVersion).map((a) => { const ver = a.versions.find((x) => x.version === a.approvedVersion); return { assetId: a.id, name: a.name, version: a.approvedVersion, width: ver.width, height: ver.height }; });
      renderConcepts(concepts); renderList();
      // Poll only while a picture is actually being made, and only for a bounded time.
      const working = creatives.some((c) => c.versions.some((v) => v.renders.some((r) => r.status === "queued" || r.status === "running")));
      if (working && pollCount < 60) { pollCount++; pollTimer = setTimeout(() => loadCreatives({ quiet: true }), 1200); } else pollCount = 0;
    } catch { if (!quiet) { creatives = []; $("cr-list").replaceChildren(h("p", { class: "hint" }, "Creatives are not available to your role.")); renderConcepts(null); } }
  }

  async function load() {
    const sel = $("cr-campaign");
    if (!session()) { creatives = []; sel.replaceChildren(); renderList(); renderConcepts(null); $("cr-provider").textContent = ""; return; }
    const keep = sel.value;
    const list = state.campaigns || [];
    sel.replaceChildren(...(list.length ? list.map((c) => h("option", { value: c.id }, c.name)) : [h("option", { value: "" }, "No campaigns yet")]));
    if (keep && list.some((c) => c.id === keep)) sel.value = keep;
    try {
      const p = await api("/creative/providers", { quiet: true });
      const img = p.image[0];
      providerNote = `${img.label}: ${img.note} ${p.video.note} Up to ${p.limits.maxRendersPerDay} pictures a day.`;
    } catch { providerNote = ""; }
    $("cr-provider").textContent = providerNote;
    await loadCreatives();
  }

  // Campaigns created elsewhere appear when this section is opened (no timer is used just to look live).
  const navLink = document.querySelector('#main-nav a[href="#s-creative"]');
  if (navLink) navLink.addEventListener("click", () => { if (session()) load(); });
  $("cr-campaign").addEventListener("change", () => { pollCount = 0; fail(""); loadCreatives(); });
  return { load };
}
