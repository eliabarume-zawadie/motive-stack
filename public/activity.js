// Activity: the audit trail in plain sentences, with a filter. The raw record stays available under "Details". Built with textContent only (via h()).

const AC_LABEL = {
  "brain.saved": "Business Brain saved",
  "website.analysis_started": "Website analysis started",
  "website.analysis_ready": "Website analysis finished",
  "website.analysis_failed": "Website analysis could not finish",
  "website.analysis_reused": "Website unchanged: earlier findings reused",
  "website.insight_decided": "A website finding was reviewed",
  "website.insights_approved_bulk": "Website findings approved together",
  "website.fill_applied": "Website findings were added to the Business Brain form",
  "campaign.generated": "Campaign draft created",
  "campaign.edited": "Campaign edited (new version)",
  "proposal.created": "Campaign proposed for approval",
  "proposal.approved": "Proposal approved",
  "proposal.rejected": "Proposal rejected",
  "proposal.blocked": "Proposal refused by a safety check",
  "proposal.stale": "Proposal went out of date (the campaign changed)",
  "execution.succeeded": "Paused draft created",
  "execution.failed": "Creating the draft failed",
  "execution.needs_review": "Result could not be confirmed: needs a person",
  "execution.reconciled": "An unconfirmed result was checked",
  "execution.refused": "Execution refused by a safety check",
  "execution.resumed": "Execution resumed",
  "execution.retry_scheduled": "Execution will be retried",
  "execution.verification_failed": "The platform's answer did not match what was asked",
  "lead.event_received": "Lead received",
  "lead.duplicate_event": "Duplicate lead event ignored",
  "lead.crm_synced": "Lead synced to the CRM",
  "lead.crm_failed": "Lead could not be synced to the CRM",
  "lead.status_changed": "Lead status changed",
  "job.retried": "A failed background job was put back in the queue",
  "ai.task_succeeded": "AI task completed",
  "ai.task_failed": "AI task failed",
  "ai.blocked": "A paid AI request was blocked by a limit",
  "ai.settings_saved": "AI settings changed",
  "ai.connection_test": "AI connection test",
  "ai.test_request": "AI test request",
  "membership.added": "A member was added",
  "membership.revoked": "A member was removed",
  "membership.role_changed": "A member's role changed",
  "meta_account.authorized": "An ad account was authorized for this workspace",
  "workspace.created": "Workspace created",
  "workspace.claimed": "Workspace claimed by a signed-in person",
  "workspace.meta_account_set": "Ad account selected",
  "workspace.legacy_token_disabled": "The workspace token was turned off",
  "credential.denied": "A credential change was refused",
  "credential.rate_limited": "Too many credential attempts: slowed down",
};

const AC_GROUPS = [
  ["all", "Everything"],
  ["brain", "Business Brain and website"],
  ["campaign", "Campaigns"],
  ["approval", "Approvals"],
  ["execution", "Running and jobs"],
  ["lead", "Leads"],
  ["ai", "AI use"],
  ["access", "People and access"],
];
const acGroupOf = (type) =>
  /^(brain|website)\./.test(type) ? "brain" : /^campaign\./.test(type) ? "campaign" : /^proposal\./.test(type) ? "approval" : /^execution\./.test(type) ? "execution"
    : /^lead\./.test(type) ? "lead" : /^ai\./.test(type) ? "ai" : "access";

const acHuman = (type) => AC_LABEL[type] || type.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Who did it, in words. Identifiers are never needed to read the trail. */
const acActor = (a) => (a === "system" ? "the system" : /^workspace-token:/.test(a) ? "someone with the workspace token" : /^user:/.test(a) ? "a signed-in person" : a === "owner" ? "the owner" : String(a).slice(0, 40));

export function initActivity({ $, h, pill, simBadge, state }) {
  let items = [];

  /** Simulated actions are marked: synthetic leads always, and anything that ran while Meta and the CRM are simulated. */
  const simulated = (e) => /^lead\./.test(e.type) || e.detail?.simulated === true || e.detail?.mode === "mock" || (/^execution\./.test(e.type) && state.config && !state.config.live.meta);

  function render(next) {
    if (next) items = next;
    const root = $("activity-view");
    const group = $("activity-filter").value || "all";
    const shown = items.filter((e) => group === "all" || acGroupOf(e.type) === group);
    if (!items.length) { root.replaceChildren(h("p", { class: "hint" }, "Nothing has happened in this workspace yet. Saving your Business Brain, analyzing a website or creating a campaign will appear here.")); return; }
    if (!shown.length) { root.replaceChildren(h("p", { class: "hint" }, "No activity of that kind. Choose “Everything” to see all of it.")); return; }
    root.replaceChildren(...shown.map((e) => h("div", { class: "log" },
      h("time", {}, e.at.replace("T", " ").slice(0, 19)),
      h("span", {}, h("strong", {}, acHuman(e.type)), " ", simulated(e) ? simBadge() : null, h("span", { class: "muted" }, ` by ${acActor(e.actor)}`),
        h("details", { class: "what" }, h("summary", {}, "Details"), h("pre", { class: "answer" }, JSON.stringify({ event: e.type, about: `${e.entityType} ${e.entityId}`, ...(e.detail && typeof e.detail === "object" ? e.detail : {}) }, null, 2).slice(0, 900)))))));
  }

  const sel = $("activity-filter");
  sel.replaceChildren(...AC_GROUPS.map(([v, label]) => h("option", { value: v }, label)));
  sel.addEventListener("change", () => render());
  return { render };
}
