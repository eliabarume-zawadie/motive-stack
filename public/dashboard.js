// Dashboard, campaign list, operations and integrations views. Everything shown comes from GET /dashboard (and the config the server
// already publishes); nothing is computed from guesses. Uses textContent only (via h()): no HTML is ever built from data.

const STATUS_LABEL = { proposed: "waiting for approval", approved: "approved, queued", executing: "running", executed: "done", rejected: "rejected", failed: "failed", stale: "out of date", needs_review: "needs review" };
const STATUS_CLASS = { executed: "ok", approved: "info", proposed: "warn", rejected: "bad", failed: "bad", stale: "warn", needs_review: "bad", executing: "info" };

/** What each state means and what a person can actually do about it. Only actions that exist are listed. */
const EXPLAIN = {
  failed: "The platform did not create the draft, even after retries. Nothing was created. If the campaign is still a draft you can propose it again from its page.",
  needs_review: "The platform's answer could not be confirmed (for example it did not come back paused). Check the ad platform before doing anything else: this app will not retry on its own.",
  stale: "The campaign changed after this proposal was made, so it can no longer be approved. Propose it again from the campaign page.",
};
const REFUSED = {
  budget_exceeds_cap: "The proposed budget was above your daily ceiling.",
  special_ad_category_unsupported: "The business may fall under a Meta special ad category, which this integration cannot declare.",
  blocking_questions: "There were open questions that must be answered before launch.",
  budget_exhausted: "An AI budget or request limit was reached.",
  budget_unverifiable: "A cost limit could not be checked for that model.",
};
const JOB_TYPE = { execute_proposal: "Create the approved draft", process_lead: "Sync a lead to the CRM" };

export function initDashboard({ $, h, pill, simBadge, usd, state, openCampaign, goProposal }) {
  const go = (el) => { if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ behavior: "smooth" }); };
  const ago = (iso) => {
    const t = Date.parse(iso);
    if (!t) return "unknown";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  };
  const stamp = (iso) => (iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "-");
  const statusPill = (st) => pill(STATUS_LABEL[st] || st, STATUS_CLASS[st] || "");
  const modeBadge = (mode) => (mode === "mock" ? simBadge() : pill("LIVE", "warn"));
  const link = (text, onclick) => h("button", { type: "button", class: "linklike", onclick }, text);
  const card = (title, ...kids) => h("div", { class: "dash-card" }, h("h3", {}, title), ...kids);
  const big = (n, label) => h("div", { class: "stat" }, h("strong", {}, String(n)), h("span", { class: "muted" }, label));

  /* ---------------------------------------------------------------- campaign state, in words */
  function campaignStatus(c) {
    if (c.status === "launched_paused") {
      return c.simulated === false
        ? [pill("PAUSED DRAFT ON META (LIVE)", "warn"), "A paused draft exists on the real ad platform. It is not running."]
        : [simBadge(), "A paused draft exists in the SIMULATED ad platform. Nothing is running on Meta."];
    }
    const p = c.latestProposal;
    if (p && p.status === "proposed") return [pill("DRAFT", ""), "Draft. A proposal is waiting for your approval; nothing external exists yet."];
    if (p && ["failed", "needs_review", "stale"].includes(p.status)) return [pill("DRAFT", ""), `Draft. The last proposal ${STATUS_LABEL[p.status]}; nothing external was confirmed.`];
    return [pill("DRAFT", ""), "Draft. Nothing external exists."];
  }

  /* ---------------------------------------------------------------- the five-step path */
  function renderPath(st) {
    const root = $("path-view");
    if (!st.current) { root.replaceChildren(h("p", { class: "hint" }, "Create a new workspace, or open an existing one, to begin.")); return; }
    const d = st.dash;
    const saved = (st.brainVersion || 0) > 0;
    const analysed = !!st.analysis && st.analysis.status === "ready";
    const total = d ? d.campaigns.total : 0;
    const proposed = d ? d.campaigns.list.some((c) => c.latestProposal) : false;
    const launched = d ? d.campaigns.byStatus.launched_paused > 0 : false;
    const waiting = d ? d.pendingApprovals.length : 0;
    const steps = [
      { title: "Understand my business", done: analysed || saved, to: "s-brain", cta: "Start with my business",
        text: analysed ? "Your website was analyzed." : saved ? "Your business is described." : "Tell MotiveStack about your business, from your website or with a few questions." },
      { title: "Review my Business Brain", done: saved, to: "s-brain", cta: "Review and save",
        text: saved ? `Saved (version ${st.brainVersion}). Ads only use what you approved.` : "Check the details and press Save. Ads only use what you approve." },
      { title: "Choose a marketing goal", done: total > 0, to: "s-campaigns", cta: "Choose a goal",
        text: total > 0 ? `${total} campaign draft${total === 1 ? "" : "s"} created.` : "Pick what you want (more leads) and create a draft campaign." },
      { title: "Review my proposed campaign", done: proposed, to: "s-campaigns", cta: "Review my campaign",
        text: proposed ? "A campaign was proposed for approval." : total > 0 ? "Read your draft, then propose it for approval." : "Your draft campaign appears here for you to read." },
      { title: "Approve and track results", done: launched, to: "s-launch", cta: waiting ? "Approve or reject" : "Go to approvals",
        text: launched ? "A paused draft exists in the SIMULATED ad platform. Nothing is running or spending." : waiting ? `${waiting} waiting for your decision. Nothing is created until you approve.` : "Nothing is created on an ad platform until you approve. Then watch your leads below." },
    ];
    const current = steps.findIndex((s) => !s.done);
    root.replaceChildren(h("ol", { class: "path" }, steps.map((s, i) => h("li", { class: `path-step${s.done ? " done" : ""}${i === current ? " current" : ""}`, "aria-current": i === current ? "step" : false },
      h("span", { class: "path-n", "aria-hidden": "true" }, s.done ? "\u2713" : String(i + 1)),
      h("div", {}, h("strong", {}, s.title, s.done ? h("span", { class: "sr" }, " (done)") : null), h("div", { class: "muted" }, s.text)),
      i === current ? h("button", { type: "button", onclick: () => go($(s.to)) }, s.cta) : link(s.done ? "Open" : "Go", () => go($(s.to))),
    ))));
  }

  /* ---------------------------------------------------------------- dashboard */
  function renderDashboard(d) {
    const root = $("dash-view");
    if (!d) {
      root.replaceChildren(h("p", { class: "hint" }, "Create or open a workspace below to see your dashboard."));
      return;
    }
    const c = d.campaigns;
    const cards = [];

    cards.push(card("Campaigns",
      h("div", { class: "stats" }, big(c.total, "total"), big(c.byStatus.draft, "drafts"), big(c.byStatus.launched_paused, "paused drafts created")),
      c.byStatus.launched_paused
        ? h("p", { class: "hint" }, `${c.launchedSimulated} in the simulated platform${c.launchedLive ? `, ${c.launchedLive} on the real platform` : ""}. None of them is running or spending.`)
        : h("p", { class: "hint" }, c.total ? "No campaign has been sent to the ad platform yet." : "No campaigns yet. Generate one under AI & Campaigns."),
      link("View campaigns", () => go($("s-campaigns"))),
    ));

    cards.push(card(`Waiting for your approval (${d.pendingApprovals.length})`,
      d.pendingApprovals.length
        ? h("ul", { class: "plain" }, d.pendingApprovals.map((p) => h("li", { class: "item" },
          h("strong", {}, p.campaignName), " ", modeBadge(p.mode), p.reviewFlags ? [" ", pill("needs review", "warn")] : null,
          h("div", { class: "muted" }, `${usd(p.plannedDailyBudgetCents)} per day proposed, ${ago(p.createdAt)}`),
          link("Review and decide", () => goProposal(p.campaignId)))))
        : h("p", { class: "hint" }, "Nothing is waiting. Approvals are always explicit: nothing is created on an ad platform without one."),
    ));

    const attn = d.needsAttention.length + (d.jobs ? d.jobs.attention.length : 0);
    cards.push(card(`Needs attention (${attn + d.recentBlocked.length})`,
      attn === 0 && d.recentBlocked.length === 0 ? h("p", { class: "hint" }, "No failed work and nothing was refused recently.") : null,
      d.needsAttention.length
        ? h("ul", { class: "plain" }, d.needsAttention.map((n) => h("li", { class: "item" }, h("strong", {}, n.campaignName), " ", statusPill(n.status), " ", modeBadge(n.mode),
          h("div", { class: "muted" }, EXPLAIN[n.status] || ""), link("Open campaign", () => goProposal(n.campaignId)))))
        : null,
      d.jobs && d.jobs.attention.length ? h("p", { class: "hint" }, `${d.jobs.attention.length} background job(s) failed or are retrying. `) : null,
      d.recentBlocked.length
        ? h("ul", { class: "plain" }, d.recentBlocked.map((b) => h("li", { class: "muted" }, `${stamp(b.at)}: refused. ${REFUSED[b.reason] || b.reason}`)))
        : null,
      link("Open operations", () => go($("s-ops"))),
    ));

    const u = d.usage, t = u.today, mo = u.thisMonth;
    const real = mo.liveRequests + (mo.localRequests || 0);
    cards.push(card("AI usage",
      h("div", { class: "stats" }, big(t.simulatedRequests, "simulated today"), big(t.liveRequests, "real (billed) today"), big(mo.simulatedRequests, "simulated this month")),
      real === 0
        ? h("p", { class: "hint" }, "No real AI usage yet, so there is no cost to show. Simulated requests are free and do not use a provider.")
        : h("p", { class: "hint" }, `This month: ${mo.liveRequests} live and ${mo.localRequests || 0} local request(s). ${mo.requestsWithUnknownCost ? `${mo.requestsWithUnknownCost} have unknown cost, so any total is incomplete.` : `Estimated spend: ${(mo.knownCostMicros / 1e6).toFixed(4)} ${u.currency}.`}`),
    ));

    const l = d.leads;
    cards.push(card("Leads",
      h("div", { class: "stats" }, big(l.total, "total"), big(l.crmSynced, "synced to CRM"), big(l.crmFailed, "CRM failed")),
      h("p", { class: "hint" }, l.total ? `${l.simulated} simulated. CRM syncing is simulated: no real GoHighLevel account is connected.` : "No leads yet."),
      link("View leads", () => go($("s-leads"))),
    ));

    cards.push(card("Recent activity",
      d.recentActivity.length
        ? h("ul", { class: "plain" }, d.recentActivity.map((a) => h("li", { class: "muted" }, `${stamp(a.at)}  `, h("strong", {}, a.type))))
        : h("p", { class: "hint" }, "No activity yet."),
      link("Full history", () => go($("s-activity"))),
    ));

    root.replaceChildren(
      h("p", { class: "hint" }, d.mode === "mock" ? "All data below is from this local workspace. Anything marked SIMULATED comes from the built-in simulators: it is not real advertising performance." : "Items marked LIVE involve a real platform."),
      h("div", { class: "dash-grid" }, cards),
    );
  }

  /* ---------------------------------------------------------------- campaign list */
  function renderCampaignList(d) {
    const root = $("campaign-list");
    if (!d) { root.replaceChildren(h("p", { class: "hint" }, "Create or open a workspace first.")); return; }
    const list = d.campaigns.list;
    if (!list.length) { root.replaceChildren(h("p", { class: "hint" }, "No campaigns yet. Use “Generate brief” above.")); return; }
    root.replaceChildren(h("ul", { class: "plain camp-list" }, list.map((c) => {
      const [badge, text] = campaignStatus(c);
      const selected = c.id === state.campaignId;
      return h("li", { class: `camp${selected ? " selected" : ""}`, "aria-current": selected ? "true" : null },
        h("div", { class: "camp-main" },
          h("strong", {}, c.name), " ", badge, " ", h("span", { class: "pill" }, `version ${c.currentVersion}`), " ", h("span", { class: "muted", title: c.id }, `#${c.id.slice(-6)}`),
          h("div", { class: "muted" }, text)),
        h("div", { class: "camp-meta muted" },
          c.budgetCents == null ? "budget unknown" : `${usd(c.budgetCents)} per day`, c.overCeiling ? [" ", pill("over your ceiling", "bad")] : null,
          " · updated ", h("span", { title: stamp(c.updatedAt) }, ago(c.updatedAt)),
          c.latestProposal ? [" · proposal: ", statusPill(c.latestProposal.status)] : null),
        h("div", { class: "actions" },
          h("button", { type: "button", class: "secondary", onclick: () => openCampaign(c.id) }, selected ? "Showing below" : "Open details"),
          c.latestProposal ? h("button", { type: "button", class: "secondary", onclick: () => goProposal(c.id) }, c.latestProposal.status === "proposed" ? "Review proposal" : "View proposal") : null));
    })));
  }

  /* ---------------------------------------------------------------- operations */
  function renderOps(d) {
    const root = $("ops-view");
    if (!d) { root.replaceChildren(h("p", { class: "hint" }, "Create or open a workspace first.")); return; }
    const kids = [];
    kids.push(h("p", { class: "hint" }, "Work runs in the background: an approved draft is created by a job, and each lead is synced to the CRM by a job. This page shows what those jobs and proposals are doing, and what you can do about problems."));
    if (!d.jobs) {
      kids.push(h("p", { class: "hint" }, "Background jobs are visible to operators and above. Your role can see proposals but not the job queue."));
    } else {
      const j = d.jobs;
      kids.push(h("div", { class: "stats" }, big(j.counts.queued, "queued"), big(j.counts.running, "running"), big(j.counts.done, "done"), big(j.counts.dead, "gave up")));
      const explain = (x) =>
        x.status === "dead" ? `Gave up after ${x.attempts} of ${x.maxAttempts} attempts. The work was not completed; check the related proposal or lead.`
          : x.status === "queued" && x.lastError ? `Failed, will retry (attempt ${x.attempts} of ${x.maxAttempts}) at ${stamp(x.runAt)}.`
            : x.status === "queued" ? "Waiting for the worker."
              : x.status === "running" ? "Running now." : "Completed.";
      const rows = (items) => items.map((x) => h("tr", {},
        h("td", {}, JOB_TYPE[x.type] || x.type),
        h("td", {}, pill(x.status === "dead" ? "gave up" : x.status, x.status === "done" ? "ok" : x.status === "dead" ? "bad" : x.status === "running" ? "info" : "warn")),
        h("td", {}, `${x.attempts} / ${x.maxAttempts}`),
        h("td", {}, explain(x), x.lastError ? h("div", { class: "muted" }, `Last error: ${x.lastError}`) : null),
        h("td", {}, ago(x.updatedAt))));
      const table = (items) => h("table", {}, h("thead", {}, h("tr", {}, ...["Job", "Status", "Attempts", "What it means", "Updated"].map((x) => h("th", {}, x)))), h("tbody", {}, rows(items)));
      if (j.attention.length) kids.push(h("h3", {}, "Failed or retrying"), table(j.attention));
      kids.push(h("h3", {}, "Recent jobs"), j.recent.length ? table(j.recent) : h("p", { class: "hint" }, "No jobs yet. They appear when you approve a proposal or add a lead."));
    }
    kids.push(h("h3", {}, "Proposals that need attention"));
    kids.push(d.needsAttention.length
      ? h("ul", { class: "plain" }, d.needsAttention.map((n) => h("li", { class: "item" },
        h("strong", {}, n.campaignName), " ", statusPill(n.status), " ", modeBadge(n.mode), h("span", { class: "muted" }, ` updated ${ago(n.updatedAt)}`),
        h("div", {}, EXPLAIN[n.status] || ""),
        n.lastError ? h("div", { class: "muted" }, `Last error: ${n.lastError}`) : null,
        h("div", { class: "actions" }, h("button", { type: "button", class: "secondary", onclick: () => goProposal(n.campaignId) }, "Open campaign and proposal")))))
      : h("p", { class: "hint" }, "None. Every proposal is waiting, done, or was rejected."));
    kids.push(h("p", { class: "hint" }, "Supported recovery: open the campaign and, if it is still a draft, propose it again. There is no automatic retry for an unconfirmed result, and no button here that bypasses an approval."));
    root.replaceChildren(...kids);
  }

  /* ---------------------------------------------------------------- settings: integrations */
  function renderIntegrations(d, workspace) {
    const root = $("integrations-view");
    const cfg = state.config;
    if (!cfg) { root.replaceChildren(); return; }
    // a NEW element per row: a DOM node can only be in one place, so a shared pill would show on the last row only
    const KIND_CLASS = { SIMULATED: "sim", LIVE: "warn", LOCAL: "ok", UNAVAILABLE: "", CONFIGURED: "ok" };
    const row = (name, kind, note) => h("tr", {}, h("td", {}, h("strong", {}, name)), h("td", {}, pill(kind, KIND_CLASS[kind] ?? "")), h("td", {}, note));
    const rows = [];
    rows.push(row("Run mode", cfg.mode === "mock" ? "SIMULATED" : "LIVE",
      cfg.mode === "mock" ? "Mock mode: nothing leaves this computer and nothing real is spent. This is the default." : "Live mode is on for the integrations below that say LIVE."));
    const meta = d?.integrations.meta;
    if (meta) {
      rows.push(row("Meta Ads", meta.simulated ? "SIMULATED" : "LIVE",
        meta.simulated
          ? `A built-in simulator stands in for Meta. No real ad account is connected${meta.accountId ? ` (${meta.accountId} is a simulator fixture, not a real account)` : ""}. Writes create paused drafts in the simulator only.`
          : `Real Meta account ${meta.accountId || "(none selected)"}: ${meta.accountAuthorized ? "authorized for this workspace" : "NOT authorized for this workspace, so writes are refused"}. Writes stay approval-gated and paused-only.`));
    }
    rows.push(row("GoHighLevel CRM", "SIMULATED", "Simulated only. There is no real GoHighLevel connector in this release, so no real contacts are created."));
    const ai = d?.integrations.ai;
    if (ai) {
      rows.push(row("AI generation", ai.live ? "LIVE" : ai.local ? "LOCAL" : "SIMULATED",
        ai.live ? "Real provider calls are enabled on the server and may be billed. Keys stay on the server." : ai.local ? "A model on this computer answers: real output, no charge, nothing leaves the machine." : "A deterministic offline model answers. Results are simulated and no provider is contacted."));
      for (const p of ai.providers) {
        const kind = p.simulated ? "SIMULATED" : p.local ? (p.available ? "LOCAL" : "UNAVAILABLE") : p.available ? "LIVE" : "UNAVAILABLE";
        const note = p.available ? (p.simulated ? "Available (no real provider)." : p.local ? "Available on this machine." : "Available: real calls enabled on the server.")
          : cfg.mode === "mock" || cfg.ai?.mode === "mock" ? "Not available in mock mode. See “AI settings” below for the exact reason per model." : "Not available: no key or not enabled on the server. See “AI settings” below.";
        rows.push(row(`  ${p.label}`, kind, note));
      }
    }
    rows.push(row("Sign-in", "SIMULATED", cfg.auth?.mode === "oidc" ? "The server expects identity-provider sign-in, which this page does not offer yet." : "Local development: a per-workspace access token (you saved it when you created the workspace). There are no user accounts or roles in this mode."));
    rows.push(row("Provider credentials", "UNAVAILABLE", "Not part of this release. Provider keys are read by the server from its own environment and are never shown or stored here."));
    root.replaceChildren(
      h("table", {}, h("thead", {}, h("tr", {}, ...["Integration", "Status", "What it means"].map((x) => h("th", {}, x)))), h("tbody", {}, rows)),
      h("p", { class: "hint" }, "SIMULATED: a built-in stand-in; no real service. LIVE: a real service. LOCAL: runs on this computer. UNAVAILABLE: cannot be used right now. Nothing on this page connects an account or enters a key."),
      workspace ? h("p", { class: "hint" }, `This workspace: ${workspace.name} (id ${workspace.id}), created ${stamp(workspace.createdAt || workspace.created_at)}.`) : null,
    );
  }

  return {
    renderPath, renderDashboard, renderCampaignList, renderOps, renderIntegrations };
}
