// Inbox & calendar: what needs a person, dated work, who owns and reviews what, and in-app notifications.
// Everything shown comes from the server's records. Owner and reviewer are coordination only: they grant nothing. Dates are plain calendar dates.
// Nothing here is sent outside the app (no e-mail, SMS or push) and nothing is scheduled on any ad platform. Built with textContent only (via h()).

import { revealEl } from "./pages.js";

const TEAM_KINDS = { draft: "Finish the draft", review: "Review a creative version", approval: "Approve or reject a proposal", run: "Run an approved proposal (simulated)", schedule_proposal: "Proposed date (not a platform schedule)", other: "Other" };
const TEAM_GO = { review: "s-launch", creative: "s-creative", brand: "s-brand", ops: "s-ops", brain: "s-brain", campaigns: "s-campaigns" };

export function initTeam({ $, h, api, state, can, once, pill, showNotice, session }) {
  let inboxData = null, assignees = [], rangeFrom = "", notif = null;
  const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const fail = (m) => { $("tm-error").textContent = m || ""; };
  const nameOpts = (value) => [h("option", { value: "" }, "Nobody"), ...assignees.map((a) => h("option", { value: a.userId, ...(a.userId === value ? { selected: true } : {}) }, `${a.name} (${a.role})`))];

  async function act(key, label, fn) {
    await once("tm-" + key, [], async () => {
      fail("");
      try { await fn(); if (label) showNotice(label); } catch (e) { fail(e && e.message ? e.message : "That did not work."); }
      await loadAll({ quiet: true });
    });
  }

  function open(go, item) {
    const id = TEAM_GO[go];
    if (go === "creative" && item.campaignId && $("cr-campaign")) { $("cr-campaign").value = item.campaignId; $("cr-campaign").dispatchEvent(new Event("change", { bubbles: true })); }
    const el = id ? $(id) : null;
    revealEl(el, "start");
  }

  /* ---------------------------------------------------------------- tasks */
  function taskLine(w) {
    const bits = [h("strong", {}, w.title), " ", pill(w.kindLabel), w.proposedOnly ? [" ", pill("PROPOSED ONLY", "sim")] : null,
      w.dueDate ? [" ", w.overdue ? pill(`overdue since ${w.dueDate}`, "bad") : pill(`due ${w.dueDate}`, "warn")] : null,
      w.status !== "open" ? [" ", pill(w.status === "done" ? (w.closedReason && w.closedReason.startsWith("closed_by") ? "done (closed by the decision)" : "done") : "cancelled", w.status === "done" ? "ok" : "")] : null];
    const meta = [h("div", { class: "muted" }, w.requiredAction),
      h("div", { class: "muted" }, `Campaign “${w.campaign.name}” version ${w.campaign.version}`, w.creative ? `; creative “${w.creative.name}” version ${w.creative.version}` : "", w.owner ? `; owner ${w.owner.name}` : "", w.reviewer ? `; reviewer ${w.reviewer.name}` : ""),
      ...w.notes.map((n) => h("div", { class: "flag-note" }, n))];
    const acts = [];
    if (can("tasks.write")) {
      if (w.status === "open") acts.push(h("button", { type: "button", class: "secondary", onclick: () => act("done-" + w.id, "Marked done.", () => api(`/work-items/${w.id}`, { method: "PATCH", body: { status: "done" } })) }, "Mark done"),
        h("button", { type: "button", class: "secondary", onclick: () => act("cancel-" + w.id, "Cancelled.", () => api(`/work-items/${w.id}`, { method: "PATCH", body: { status: "cancelled" } })) }, "Cancel"));
      else acts.push(h("button", { type: "button", class: "secondary", onclick: () => act("reopen-" + w.id, "Reopened.", () => api(`/work-items/${w.id}`, { method: "PATCH", body: { status: "open" } })) }, "Reopen"));
    }
    return h("li", { class: "card" }, ...bits.flat(Infinity), ...meta, acts.length ? h("div", { class: "actions" }, acts) : null);
  }

  function itemLine(it) {
    const acts = [h("button", { type: "button", class: "secondary", onclick: () => open(it.go, it) }, "Open")];
    return h("li", { class: "card" }, h("strong", {}, it.title), " ", it.assignedToYou ? pill("assigned to you", "ok") : null, " ", it.canAct ? null : pill("you cannot act on this", ""),
      h("div", {}, it.action), h("div", { class: "muted" }, it.why), it.reviewer ? h("div", { class: "muted" }, `Expected reviewer: ${it.reviewer}`) : null,
      !it.canAct && it.actionPermission ? h("div", { class: "hint" }, `Needs someone with the “${it.actionPermission}” permission.`) : null, h("div", { class: "actions" }, acts));
  }

  function section(title, list, empty, make) {
    return h("div", {}, h("h4", {}, `${title} (${list.length})`), list.length ? h("ul", { class: "plain" }, list.map(make)) : h("p", { class: "hint" }, empty));
  }

  function renderInbox() {
    const box = $("tm-inbox");
    if (!inboxData) { box.replaceChildren(); return; }
    const d = inboxData;
    box.replaceChildren(
      d.viewer.note ? h("p", { class: "flag-note" }, d.viewer.note) : null,
      section("Assigned to you", d.assignedToYou, d.viewer.isPerson ? "Nothing is assigned to you." : "Not available with the shared token.", taskLine),
      section("Waiting for a decision", d.waiting, "Nothing is waiting for review or approval.", itemLine),
      section("Problems", d.problems, "No failed or blocked work.", itemLine),
      section("Due soon or overdue (everyone's, next 14 days)", d.dates, "Nothing is due in the next two weeks.", taskLine));
  }

  /* ---------------------------------------------------------------- notifications */
  function renderNotifications() {
    const box = $("tm-notes");
    if (!notif) { box.replaceChildren(); return; }
    if (!notif.available) { box.replaceChildren(h("p", { class: "hint" }, notif.reason)); return; }
    box.replaceChildren(h("p", {}, h("strong", {}, `${notif.unread} unread`), " ", h("span", { class: "hint" }, "In-app only: nothing is sent by e-mail, text message or push."), " ",
      notif.unread ? h("button", { type: "button", class: "secondary", onclick: () => act("readall", "", () => api("/notifications/read-all", { method: "POST" })) }, "Mark all read") : null),
      notif.notifications.length ? h("ul", { class: "plain" }, notif.notifications.map((n) => h("li", {}, n.read ? pill("read") : pill("new", "warn"), " ", n.text, " ", h("span", { class: "muted" }, n.createdAt.replace("T", " ").slice(0, 16) + " UTC"), " ",
        n.read ? null : h("button", { type: "button", class: "linklike", onclick: () => act("read-" + n.id, "", () => api(`/notifications/${n.id}/read`, { method: "POST" })) }, "mark read")))) : h("p", { class: "hint" }, "No notifications."));
  }

  /* ---------------------------------------------------------------- calendar */
  async function loadCalendar() {
    const box = $("tm-cal");
    try {
      const cal = await api(`/calendar?from=${rangeFrom}&to=${addDays(rangeFrom, 27)}`, { quiet: true });
      const byDay = new Map();
      for (const e of cal.entries) { if (!byDay.has(e.date)) byDay.set(e.date, []); byDay.get(e.date).push(e); }
      $("tm-range").textContent = `${cal.from} to ${cal.to}`;
      box.replaceChildren(h("p", { class: "hint" }, cal.notes.join(" ")),
        ...(byDay.size ? [...byDay.entries()].map(([day, list]) => h("div", {}, h("h4", {}, day + (day === cal.today ? " (today)" : "")), h("ul", { class: "plain" }, list.map((e) => h("li", { class: "card" },
          pill(e.label, e.type === "schedule_proposal" ? "sim" : ""), " ", h("strong", {}, e.title), e.overdue ? [" ", pill("overdue", "bad")] : null, e.status === "done" ? [" ", pill("done", "ok")] : null,
          h("div", { class: "muted" }, e.requiredAction), h("div", { class: "muted" }, `Campaign “${e.campaign.name}” version ${e.campaign.version}`, e.creative ? `; creative “${e.creative.name}” version ${e.creative.version}` : "", e.owner ? `; owner ${e.owner.name}` : "", e.reviewer ? `; reviewer ${e.reviewer.name}` : "", e.job ? `; run job ${e.job.status}` : ""),
          ...e.notes.map((n) => h("div", { class: "flag-note" }, n))))))) : [h("p", { class: "hint" }, "Nothing is dated in this range.")]));
    } catch { box.replaceChildren(h("p", { class: "hint" }, "The calendar is not available to your role.")); }
  }

  /* ---------------------------------------------------------------- forms */
  const campaignOpts = () => (state.campaigns || []).map((c) => h("option", { value: c.id }, c.name));
  async function fillCreatives() {
    const sel = $("tm-creative"), camp = $("tm-campaign").value;
    sel.replaceChildren(h("option", { value: "" }, "None"));
    if (!camp) return;
    try { const r = await api(`/campaigns/${camp}/creatives`, { quiet: true }); sel.replaceChildren(h("option", { value: "" }, "None"), ...r.creatives.map((cr) => h("option", { value: cr.id }, `${cr.name} (version ${cr.currentVersion})`))); } catch { /* not allowed to see creatives */ }
  }
  async function fillOwnership() {
    const camp = $("tm-own-campaign").value;
    $("tm-owner").replaceChildren(...nameOpts(null)); $("tm-reviewer").replaceChildren(...nameOpts(null));
    if (!camp) return;
    try { const o = await api(`/ownerships/campaign/${camp}`, { quiet: true }); $("tm-owner").replaceChildren(...nameOpts(o.ownerUserId)); $("tm-reviewer").replaceChildren(...nameOpts(o.reviewerUserId)); } catch { /* shown empty */ }
  }

  function wire() {
    $("tm-work-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = $("tm-work-form").elements;
      if (!f.campaignId.value) { fail("Choose a campaign first."); return; }
      const body = { campaignId: f.campaignId.value, kind: f.kind.value, title: f.title.value.trim() };
      if (f.creativeId.value) body.creativeId = f.creativeId.value;
      if (f.proposalId.value.trim()) body.proposalId = f.proposalId.value.trim();
      if (f.dueDate.value) body.dueDate = f.dueDate.value;
      if (f.ownerUserId.value) body.ownerUserId = f.ownerUserId.value;
      if (f.reviewerUserId.value) body.reviewerUserId = f.reviewerUserId.value;
      act("create", "Saved.", async () => { await api("/work-items", { method: "POST", body }); $("tm-work-form").elements.title.value = ""; });
    });
    $("tm-campaign").addEventListener("change", fillCreatives);
    $("tm-own-campaign").addEventListener("change", fillOwnership);
    $("tm-own-save").addEventListener("click", () => {
      const camp = $("tm-own-campaign").value;
      if (!camp) { fail("Choose a campaign first."); return; }
      act("own", "Saved. Owner and reviewer are for coordination: they do not change who may approve.", () => api("/ownerships", { method: "PUT", body: { subjectType: "campaign", subjectId: camp, ownerUserId: $("tm-owner").value || null, reviewerUserId: $("tm-reviewer").value || null } }));
    });
    $("tm-prev").addEventListener("click", () => { rangeFrom = addDays(rangeFrom, -28); loadCalendar(); });
    $("tm-next").addEventListener("click", () => { rangeFrom = addDays(rangeFrom, 28); loadCalendar(); });
    $("tm-today").addEventListener("click", () => { rangeFrom = inboxData ? inboxData.today : rangeFrom; loadCalendar(); });
    const nav = document.querySelector('#main-nav a[href="#s-inbox"]');
    if (nav) nav.addEventListener("click", () => { if (session()) loadAll({ quiet: true }); });
  }

  async function loadAll() {
    if (!session()) { inboxData = null; notif = null; renderInbox(); renderNotifications(); $("tm-cal").replaceChildren(); return; }
    try { assignees = (await api("/assignees", { quiet: true })).assignees; } catch { assignees = []; }
    const keepC = $("tm-campaign").value, keepO = $("tm-own-campaign").value;
    for (const id of ["tm-campaign", "tm-own-campaign"]) $(id).replaceChildren(...(state.campaigns && state.campaigns.length ? campaignOpts() : [h("option", { value: "" }, "No campaigns yet")]));
    if (keepC && (state.campaigns || []).some((c) => c.id === keepC)) $("tm-campaign").value = keepC;
    if (keepO && (state.campaigns || []).some((c) => c.id === keepO)) $("tm-own-campaign").value = keepO;
    for (const id of ["tm-w-owner", "tm-w-reviewer"]) $(id).replaceChildren(...nameOpts(null));
    try { inboxData = await api("/inbox", { quiet: true }); } catch { inboxData = null; }
    if (!rangeFrom) rangeFrom = inboxData ? inboxData.today : new Date().toISOString().slice(0, 10);
    try { notif = await api("/notifications", { quiet: true }); } catch { notif = null; }
    renderInbox(); renderNotifications();
    $("tm-badge").textContent = inboxData ? `${inboxData.counts.waitingYouCanAct} waiting for you to decide, ${inboxData.counts.problems} problem${inboxData.counts.problems === 1 ? "" : "s"}, ${inboxData.counts.overdue} overdue` : "";
    await Promise.all([fillCreatives(), fillOwnership(), loadCalendar()]);
  }

  wire();
  return { load: loadAll };
}
