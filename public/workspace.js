// Settings: this workspace and who may do what, the Meta ad accounts it may use, and what AI has been used and (roughly) cost. Everything is read from the
// server; what a role may change is decided by the server and only shown here. Built with textContent only (via h()).

const ROLE_TEXT = {
  viewer: "Can look at everything except people, accounts and background jobs.",
  operator: "Can create and edit campaign drafts, propose them and add test leads.",
  admin: "Can also approve proposals, edit the Business Brain and AI settings.",
  owner: "Can also manage people, ad accounts and credentials.",
};
const ROLES = ["viewer", "operator", "admin", "owner"];

export function initWorkspaceSettings({ $, h, api, state, can, once, pill, simBadge, showNotice, session }) {
  const stamp = (iso) => (iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "-");
  const money = (micros, cur) => (micros == null ? "unknown" : `${(micros / 1e6).toFixed(micros < 1e4 ? 4 : 2)} ${cur || "USD"}`);

  /* ---------------------------------------------------------------- workspace and people */
  function workspaceCard() {
    const w = state.workspace, mode = state.config?.mode;
    if (!w) return h("p", { class: "hint" }, "Create or open a workspace first.");
    return h("div", { class: "card" },
      h("strong", {}, w.name), " ", mode === "mock" ? simBadge() : pill("LIVE", "warn"),
      h("div", { class: "muted" }, `Created ${stamp(w.createdAt || w.created_at)}. Workspace id ${w.id}.`),
      h("div", {}, h("strong", {}, "Your role: "), state.role || "unknown", h("div", { class: "hint" }, ROLE_TEXT[state.role] || "")),
      w.organizationId ? h("div", {}, h("strong", {}, "Organization: "), w.organizationKind === "agency" ? `${w.organizationName} (an agency organization that owns this client workspace)` : "personal (created automatically; you never need to manage it)") : null,
      h("div", { class: "hint" }, "Everything in a workspace (Business Brain, campaigns, leads, activity) belongs to that workspace alone. Belonging to an organization never gives anyone access to a workspace's data."));
  }

  async function changeRole(m, role, select) {
    await once("member-" + m.userId, [select], async () => {
      try { await api(`/members/${encodeURIComponent(m.userId)}`, { method: "PATCH", body: { role } }); showNotice("Role changed."); } catch { /* shown */ }
      await load();
    });
  }
  async function removeMember(m, button) {
    if (button.dataset.armed !== "1") { button.dataset.armed = "1"; button.textContent = "Click again to remove"; setTimeout(() => { button.dataset.armed = ""; button.textContent = "Remove"; }, 5000); return; }
    await once("member-" + m.userId, [button], async () => {
      try { await api(`/members/${encodeURIComponent(m.userId)}`, { method: "DELETE" }); showNotice("Member removed."); } catch { /* shown */ }
      await load();
    });
  }

  function membersSection(res) {
    if (res === "denied") return h("p", { class: "hint" }, "People and roles are visible to admins and owners.");
    const list = res.members || [];
    const manage = can("members.manage");
    const kids = [];
    if (state.config?.auth?.mode !== "oidc") {
      kids.push(h("p", { class: "flag-note" }, "This computer is using local-development sign-in: one access token per workspace, and no user accounts. Roles and members need identity-provider sign-in (AUTH_MODE=oidc), which is not set up here. The token acts like an admin and can never manage people."));
    }
    kids.push(list.length
      ? h("table", {}, h("thead", {}, h("tr", {}, ...["Person", "Role", "Status", "Added", ""].map((x) => h("th", {}, x)))),
        h("tbody", {}, list.map((m) => {
          if (m.customRoleName) return h("tr", {}, h("td", {}, m.displayName || m.email || "Unnamed", m.email && m.displayName ? h("div", { class: "muted" }, m.email) : null),
            h("td", {}, pill("custom: " + m.customRoleName), h("div", { class: "hint" }, "Set through the organization (see the note below).")), h("td", {}, pill(m.status, m.status === "active" ? "ok" : "")), h("td", {}, stamp(m.addedAt)), h("td", {}));
          const sel = h("select", { "aria-label": `Role of ${m.displayName || m.email || "member"}`, disabled: !manage || m.status !== "active", title: manage ? null : "Only an owner can change roles." },
            ROLES.map((r) => h("option", { value: r, selected: r === m.role }, r)));
          sel.addEventListener("change", () => changeRole(m, sel.value, sel));
          const rm = h("button", { type: "button", class: "secondary", disabled: !manage || m.status !== "active", title: manage ? null : "Only an owner can remove people." }, "Remove");
          rm.addEventListener("click", () => removeMember(m, rm));
          return h("tr", {}, h("td", {}, m.displayName || m.email || "Unnamed", m.email && m.displayName ? h("div", { class: "muted" }, m.email) : null),
            h("td", {}, sel), h("td", {}, pill(m.status, m.status === "active" ? "ok" : "")), h("td", {}, stamp(m.addedAt)), h("td", {}, rm));
        })))
      : h("p", { class: "hint" }, "No people are listed for this workspace."));
    const form = h("form", { class: "grid", id: "member-add" },
      h("label", {}, "Person's user id (from their sign-in)", h("input", { name: "userId", required: true, maxlength: 80, disabled: !manage })),
      h("label", {}, "Role", h("select", { name: "role", disabled: !manage }, ROLES.map((r) => h("option", { value: r, selected: r === "viewer" }, r)))),
      h("div", { class: "wide" }, h("button", { type: "submit", disabled: !manage, title: manage ? null : "Only an owner can add people." }, "Add person"),
        manage ? null : h("span", { class: "hint" }, " Only an owner who signed in as a person can manage people.")));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      await once("member-add", [form.querySelector("button")], async () => {
        try { await api("/members", { method: "POST", body: { userId: f.userId.value.trim(), role: f.role.value } }); showNotice("Person added."); f.userId.value = ""; } catch { /* shown */ }
        await load();
      });
    });
    kids.push(form);
    kids.push(h("p", { class: "hint" }, "Custom roles (a role with exactly the permissions you choose, with a preview of what it can and cannot do) and organization-wide access are managed through the organization API by a signed-in owner. This page cannot sign in as a person yet, so it does not edit them."));
    return h("div", {}, ...kids);
  }

  /* ---------------------------------------------------------------- approval policy */
  function policySection(p) {
    if (!p || p === "denied") return h("p", { class: "hint" }, "The approval policy is not available to your role.");
    const mayChange = can("policy.manage");
    const box = h("input", { type: "checkbox", id: "policy-self", checked: !!p.preventSelfApproval, disabled: !mayChange, "aria-describedby": "policy-note" });
    box.addEventListener("change", () => once("policy", [box], async () => {
      try { await api("/policy", { method: "PUT", body: { preventSelfApproval: box.checked } }); showNotice(box.checked ? "A second person is now required to approve." : "Separation of duties is switched off."); } catch { /* shown */ }
      await load();
    }));
    const tokenMode = state.config?.auth?.mode !== "oidc";
    return h("div", { class: "card" },
      h("label", { class: "chk" }, box, " Require a second person to approve (a person cannot approve their own proposal)"),
      h("p", { id: "policy-note", class: "hint" }, mayChange ? "Only an owner can change this." : "Only an owner who signed in as a person can change this."),
      tokenMode ? h("p", { class: "flag-note" }, "Local sign-in: everyone shares one access token, so the app cannot tell two people apart and cannot enforce this. Approvals made this way are recorded as 'not enforced'. It is enforced for signed-in people.") : null);
  }

  /* ---------------------------------------------------------------- meta accounts */
  function metaSection(res) {
    if (state.config?.mode === "mock") {
      return h("p", { class: "hint" }, "Meta Ads is SIMULATED here. No real ad account is connected and none is needed. In live mode, only an ad account an owner has authorized for this workspace can ever be used, and live ad creation is not enabled in this release.");
    }
    if (res === "denied") return h("p", { class: "hint" }, "Ad accounts are visible to admins and owners.");
    const accts = res.accounts || [];
    return accts.length
      ? h("table", {}, h("thead", {}, h("tr", {}, ...["Ad account", "Status", "Added", ""].map((x) => h("th", {}, x)))), h("tbody", {}, accts.map((a) => {
        const dis = h("button", { type: "button", class: "secondary", disabled: !can("meta_accounts.manage") || a.status !== "active" }, "Disable");
        dis.addEventListener("click", () => once("meta-" + a.accountId, [dis], async () => { try { await api(`/meta-accounts/${encodeURIComponent(a.accountId)}/disable`, { method: "POST" }); } catch { /* shown */ } await load(); }));
        return h("tr", {}, h("td", {}, a.accountId), h("td", {}, pill(a.status, a.status === "active" ? "ok" : "")), h("td", {}, stamp(a.addedAt)), h("td", {}, dis));
      })))
      : h("p", { class: "hint" }, "No ad account is authorized for this workspace, so live writes are refused.");
  }

  /* ---------------------------------------------------------------- AI usage and cost */
  function usageSection(usage, status) {
    const kids = [];
    if (status) {
      kids.push(h("p", {}, h("strong", {}, "AI mode: "), status.mode === "mock" ? [simBadge(), " Nothing is sent to any AI provider and nothing is charged."] : status.mode === "live" ? [pill("LIVE", "warn"), " Real provider requests may be billed."] : [pill("LOCAL", "ok"), " A model on this computer answers; no charge."]));
      kids.push(h("p", { class: "hint" }, status.nextStep));
      kids.push(h("table", {}, h("thead", {}, h("tr", {}, ...["Provider", "Available", "Key on the server"].map((x) => h("th", {}, x)))),
        h("tbody", {}, status.providers.map((p) => h("tr", {}, h("td", {}, p.label), h("td", {}, pill(p.available ? "yes" : "no", p.available ? "ok" : "")),
          h("td", {}, p.keyConfigured === null ? "not needed" : p.keyConfigured ? "present (never shown)" : "not set"))))));
      const b = status.budget;
      kids.push(b.configured
        ? h("p", {}, h("strong", {}, "Live spending ceiling: "), `${money(b.ceilingMicros, b.currency)} this month; used ${money(b.spentMicros, b.currency)}, held for requests in flight or unconfirmed ${money(b.heldMicros, b.currency)}, left ${money(b.remainingMicros, b.currency)}. Requests today: ${b.requestsToday}${b.maxRequestsPerDay ? " of " + b.maxRequestsPerDay : ""}.`)
        : h("p", { class: "hint" }, "No live spending ceiling is set, so live AI requests are refused. Mock and local requests are unaffected."));
      kids.push(h("p", { class: "hint" }, b.note));
    }
    if (usage) {
      const row = (label, u) => h("tr", {}, h("td", {}, label), h("td", {}, String(u.attempts)), h("td", {}, String(u.simulatedRequests)), h("td", {}, String(u.localRequests)), h("td", {}, String(u.liveRequests)),
        h("td", {}, u.liveRequests ? `${money(u.knownCostMicros, usage.currency)} (estimate)${u.requestsWithUnknownCost ? `, plus ${u.requestsWithUnknownCost} request(s) of unknown cost` : ""}` : "none: nothing billable"));
      kids.push(h("table", {}, h("thead", {}, h("tr", {}, ...["Period", "Requests", "Simulated", "Local", "Live", "Estimated cost"].map((x) => h("th", {}, x)))), h("tbody", {}, row("Today", usage.today), row("This month", usage.thisMonth))));
      kids.push(h("p", { class: "hint" }, "Costs are estimates from token counts and the price list in this app. They are not your provider's bill. Simulated and local requests cost nothing."));
    }
    return h("div", {}, ...kids);
  }

  /* ---------------------------------------------------------------- loading */
  const safe = async (path) => { try { return await api(path, { quiet: true }); } catch (e) { return /\b403\b|not allowed|permission|forbidden/i.test(e.message) ? "denied" : "denied"; } };

  async function load() {
    if (!session()) { for (const id of ["ws-people-view", "ws-meta-view", "ws-usage-view"]) $(id).replaceChildren(); return; }
    const [members, meta, usage, status, policy] = await Promise.all([safe("/members"), safe("/meta-accounts"), safe("/ai/usage"), safe("/ai/status"), safe("/policy")]);
    $("ws-people-view").replaceChildren(workspaceCard(), membersSection(members), h("h4", {}, "Approvals"), policySection(policy));
    $("ws-meta-view").replaceChildren(metaSection(meta));
    $("ws-usage-view").replaceChildren(usageSection(usage === "denied" ? null : usage.summary, status === "denied" ? null : status));
  }
  $("ws-settings-reload")?.addEventListener("click", () => load());
  return { load };
}
