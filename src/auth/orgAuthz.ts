import { ALL_PERMISSIONS, type Permission } from "./authz.js";

/**
 * Organization-level authorization. An organization is the agency (or the hidden "personal" organization of a direct business) that owns client workspaces.
 * Organization membership never grants access to a workspace's data: that always needs an explicit workspace membership. These roles only decide who may
 * manage the organization itself: its people, its role templates and the creation of client workspaces.
 *
 *   permission               member  admin  owner
 *   org.read                   x       x      x
 *   org.roles.read                     x      x     role templates and the permission catalog
 *   org.workspaces.read                x      x     names and ids only: never a workspace's records
 *   org.workspaces.create              x      x     the creator becomes that workspace's owner
 *   org.members.read                   x      x     and the organization's own change history
 *   org.members.manage                        x
 *   org.roles.manage                          x     create, edit and archive role templates
 *   org.access.grant                          x     give an organization member access to client workspaces
 */
export const ORG_ROLES = ["member", "admin", "owner"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
const ORG_RANK: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 };

export const ORG_PERMISSION_MIN_ROLE = {
  "org.read": "member",
  "org.roles.read": "admin",
  "org.workspaces.read": "admin",
  "org.workspaces.create": "admin",
  "org.members.read": "admin",
  "org.members.manage": "owner",
  "org.roles.manage": "owner",
  "org.access.grant": "owner",
} as const satisfies Record<string, OrgRole>;
export type OrgPermission = keyof typeof ORG_PERMISSION_MIN_ROLE;
export const orgRoleAllows = (role: OrgRole, p: OrgPermission): boolean => ORG_RANK[role] >= ORG_RANK[ORG_PERMISSION_MIN_ROLE[p]];
export const isOrgRole = (v: unknown): v is OrgRole => typeof v === "string" && (ORG_ROLES as readonly string[]).includes(v);

/** Every organization route and the permission it needs. A route under /api/organizations/:oid that is missing here is refused (default deny). */
export const ORG_ROUTE_PERMISSIONS: Readonly<Record<string, OrgPermission>> = {
  "GET /api/organizations/:oid": "org.read",
  "GET /api/organizations/:oid/workspaces": "org.workspaces.read",
  "POST /api/organizations/:oid/workspaces": "org.workspaces.create",
  "GET /api/organizations/:oid/members": "org.members.read",
  "POST /api/organizations/:oid/members": "org.members.manage",
  "PATCH /api/organizations/:oid/members/:uid": "org.members.manage",
  "DELETE /api/organizations/:oid/members/:uid": "org.members.manage",
  "GET /api/organizations/:oid/permissions": "org.roles.read",
  "GET /api/organizations/:oid/role-templates": "org.roles.read",
  "POST /api/organizations/:oid/role-templates": "org.roles.manage",
  "PUT /api/organizations/:oid/role-templates/:tid": "org.roles.manage",
  "DELETE /api/organizations/:oid/role-templates/:tid": "org.roles.manage",
  "POST /api/organizations/:oid/role-preview": "org.roles.read",
  "POST /api/organizations/:oid/access-grants": "org.access.grant",
  "GET /api/organizations/:oid/audit": "org.members.read",
};

/**
 * Permissions a custom role may NOT contain in this release. They stay with the built-in owner role, so a custom role can never be used to hand out the
 * power to create owners, change roles or policy, or touch credentials and ad accounts.
 */
export const OWNER_ONLY_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  "members.manage", "roles.manage", "policy.manage", "credentials.read", "credentials.manage", "meta_accounts.manage", "legacy_token.disable",
]);
export const CUSTOMIZABLE_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter((p) => !OWNER_ONLY_PERMISSIONS.has(p));

/** Plain-language names for the permission preview ("what can this role do?"). */
export const PERMISSION_CATALOG: Record<Permission, { group: string; label: string }> = {
  "workspace.read": { group: "Workspace", label: "See the workspace and its dashboard" },
  "workspace.update": { group: "Workspace", label: "Change workspace settings" },
  "brain.read": { group: "Business Brain", label: "Read the Business Brain and website findings" },
  "brain.write": { group: "Business Brain", label: "Edit the Business Brain and review website findings" },
  "campaigns.read": { group: "Campaigns", label: "See campaigns and their versions" },
  "campaigns.generate": { group: "Campaigns", label: "Create campaign drafts" },
  "campaigns.edit": { group: "Campaigns", label: "Edit campaign drafts (makes a new version)" },
  "proposals.read": { group: "Approvals", label: "See proposals and approvals" },
  "proposals.create": { group: "Approvals", label: "Submit a campaign for approval" },
  "proposals.decide": { group: "Approvals", label: "Approve or reject proposals" },
  "proposals.execute": { group: "Approvals", label: "Run an approved action (simulated in this release)" },
  "leads.read": { group: "Leads", label: "See leads" },
  "leads.simulate": { group: "Leads", label: "Add synthetic test leads" },
  "leads.update": { group: "Leads", label: "Change a lead's status" },
  "activity.read": { group: "Operations", label: "Read the activity history" },
  "jobs.read": { group: "Operations", label: "See background jobs" },
  "jobs.retry": { group: "Operations", label: "Retry a failed background job" },
  "ai.settings.read": { group: "AI", label: "See AI settings and status" },
  "ai.settings.write": { group: "AI", label: "Change AI settings" },
  "ai.usage.read": { group: "AI", label: "See AI usage and cost" },
  "ai.connection_test": { group: "AI", label: "Run an AI connection test" },
  "members.read": { group: "People", label: "See the workspace's members" },
  "members.manage": { group: "People", label: "Add, change and remove members (owner only)" },
  "roles.manage": { group: "People", label: "Manage custom roles (owner only)" },
  "policy.manage": { group: "People", label: "Change workspace policy such as separation of duties (owner only)" },
  "meta_accounts.read": { group: "Integrations", label: "See which ad accounts are authorized" },
  "meta_accounts.manage": { group: "Integrations", label: "Authorize or revoke ad accounts (owner only)" },
  "credentials.read": { group: "Integrations", label: "See masked credential status (owner only)" },
  "credentials.manage": { group: "Integrations", label: "Store or revoke credentials (owner only)" },
  "legacy_token.disable": { group: "People", label: "Disable the workspace token (owner only)" },
  "plans.read": { group: "Campaigns", label: "See marketing plans" },
  "plans.write": { group: "Campaigns", label: "Ask for a plan, edit it and generate its drafts" },
  "plans.review": { group: "Campaigns", label: "Review a plan's total and each campaign's budget" },
  "campaigns.archive": { group: "Campaigns", label: "Archive a campaign or mark it completed" },
  "brandkit.read": { group: "Brand", label: "See the Brand Kit" },
  "brandkit.write": { group: "Brand", label: "Edit the Brand Kit (a change withdraws its approval)" },
  "brandkit.approve": { group: "Brand", label: "Approve or reject the Brand Kit" },
  "assets.read": { group: "Brand", label: "See the asset library and its files" },
  "assets.write": { group: "Brand", label: "Upload assets and add versions" },
  "assets.review": { group: "Brand", label: "Approve or reject asset versions" },
  "assets.archive": { group: "Brand", label: "Archive assets" },
  "creatives.read": { group: "Creative", label: "See creatives, their pictures and checks" },
  "creatives.write": { group: "Creative", label: "Make and edit creatives, make pictures, send for review" },
  "creatives.review": { group: "Creative", label: "Approve or reject creative versions" },
  "experiments.read": { group: "Learning", label: "See experiments, their results and analysis" },
  "experiments.write": { group: "Learning", label: "Plan and start experiments, record what was used and the results" },
  "experiments.decide": { group: "Learning", label: "Conclude or abandon experiments (records a decision only)" },
  "learnings.read": { group: "Learning", label: "See the Marketing Brain (learnings)" },
  "learnings.write": { group: "Learning", label: "Write learnings and generate suggestions" },
  "learnings.confirm": { group: "Learning", label: "Confirm, reject or retire learnings" },
  "recommendations.read": { group: "Learning", label: "See recommendations and their evidence" },
  "recommendations.decide": { group: "Learning", label: "Accept or dismiss recommendations (acts on nothing)" },
  "leads.import": { group: "Leads", label: "Import leads (labelled imported, never sent to a CRM)" },
  "forms.read": { group: "Leads", label: "See lead form definitions" },
  "forms.write": { group: "Leads", label: "Define lead forms (nothing is published)" },
  "analytics.read": { group: "Leads", label: "See reporting (counts by origin, what is not measured)" },
  "tasks.read": { group: "Team", label: "See the inbox, the calendar, tasks and who owns what" },
  "tasks.write": { group: "Team", label: "Create and update tasks and dated milestones" },
  "assignments.manage": { group: "Team", label: "Set owners and reviewers (coordination only)" },
};
