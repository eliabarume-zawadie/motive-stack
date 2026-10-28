/**
 * Workspace authorization: roles, the permission matrix, and the per-route permission table.
 *
 * Roles are ordered, each includes everything below it:  viewer < operator < admin < owner.
 *
 * PERMISSION MATRIX (minimum role required)
 *
 *   permission                 viewer  operator  admin  owner   notes
 *   workspace.read               x        x        x      x
 *   brain.read                   x        x        x      x
 *   campaigns.read               x        x        x      x
 *   proposals.read               x        x        x      x
 *   leads.read                   x        x        x      x
 *   activity.read                x        x        x      x     the audit trail
 *   ai.settings.read             x        x        x      x
 *   ai.usage.read                x        x        x      x
 *   jobs.read                             x        x      x
 *   campaigns.generate                    x        x      x     billable in live mode; still bound by the workspace's AI limits
 *   campaigns.edit                        x        x      x
 *   proposals.create                      x        x      x     only creates a PROPOSAL; nothing external happens
 *   leads.simulate                        x        x      x     mock mode only (the service refuses it otherwise)
 *   proposals.decide                               x      x     approve / reject. Operators cannot: approval-first is not bypassable
 *   brain.write                                    x      x     facts the generator may claim
 *   workspace.update                               x      x     e.g. the connected ad account id
 *   ai.settings.write                              x      x     routing, allow-list, workspace limits
 *   ai.connection_test                             x      x     may make one real request in live mode
 *   members.read                                   x      x
 *   meta_accounts.read                             x      x     which ad accounts this workspace may use
 *   credentials.read                               x      x     MASKED status of stored integration credentials (GET /credentials, M4.4a; a signed-in person only)
 *   members.manage                                        x     add, change role, remove; the only way to create or transfer ownership
 *   meta_accounts.manage                                  x     authorize, disable, revoke an ad account. Admins can only CHOOSE among authorized ones
 *   credentials.manage                                    x     store, replace, revoke, delete an integration credential (PUT/POST revoke/DELETE /credentials/:kind, M4.4b; a signed-in person only)
 *   legacy_token.disable                                  x
 *   proposals.execute                              x      x     run an APPROVED action (simulated in this release). Approval alone never runs anything
 *   roles.manage                                          x     create and edit custom role templates, assign them to members
 *   policy.manage                                         x     workspace policy such as separation of duties
 *   plans.read                   x        x        x      x     marketing plans and their opportunities
 *   plans.write                           x        x      x     ask for a plan, edit it, generate its drafts
 *   plans.review                                   x      x     review a plan's total and each campaign's budget
 *   campaigns.archive                              x      x     archive a campaign or mark a run campaign completed
 *   brandkit.read                x        x        x      x     the Brand Kit (voice, look, audiences): preferences, never business facts
 *   brandkit.write                        x        x      x     edit the Brand Kit (makes a new version and withdraws its approval)
 *   brandkit.approve                               x      x     approve or reject the submitted Brand Kit version
 *   assets.read                  x        x        x      x     the asset library and the files in it
 *   assets.write                          x        x      x     upload or import an asset, add a version, submit it for review
 *   assets.review                                  x      x     approve or reject an asset version
 *   assets.archive                                 x      x     archive an asset
 *   creatives.read               x        x        x      x     creatives, their pictures, checks and history
 *   creatives.write                       x        x      x     make, edit and archive a creative, make or cancel pictures, attach an approved image, send for review
 *   creatives.review                               x      x     approve or reject a creative version
 *
 * No permission lets any role skip approval-first execution, the budget ceiling, mock/live separation, payload-hash checks or
 * the campaign safety rules: those live in the services and the executor and apply to everyone. Credential permissions guard the
 * vault. Credential routes are the masked status list (M4.4a) and owner-only create/replace, revoke and delete (M4.4b); none returns or
 * reveals a secret, and a stored credential never grants the right to use any resource (Meta ad accounts are authorized separately).
 *
 * The LEGACY WORKSPACE TOKEN is not a user. While it is enabled it acts as an 'admin'-equivalent principal that can never manage
 * members or ownership. Workspaces created by a signed-in person have no usable token.
 */
export const ROLES = ["viewer", "operator", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];
const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

export const PERMISSION_MIN_ROLE = {
  "workspace.read": "viewer",
  "brain.read": "viewer",
  "campaigns.read": "viewer",
  "proposals.read": "viewer",
  "leads.read": "viewer",
  "activity.read": "viewer",
  "ai.settings.read": "viewer",
  "ai.usage.read": "viewer",
  "jobs.read": "operator",
  "campaigns.generate": "operator",
  "campaigns.edit": "operator",
  "proposals.create": "operator",
  "leads.simulate": "operator",
  "leads.update": "operator",
  "jobs.retry": "admin",
  "proposals.decide": "admin",
  "brain.write": "admin",
  "workspace.update": "admin",
  "ai.settings.write": "admin",
  "ai.connection_test": "admin",
  "members.read": "admin",
  "meta_accounts.read": "admin",
  "credentials.read": "admin",
  "members.manage": "owner",
  "meta_accounts.manage": "owner",
  "credentials.manage": "owner",
  "legacy_token.disable": "owner",
  "proposals.execute": "admin",
  "roles.manage": "owner",
  "policy.manage": "owner",
  "plans.read": "viewer",
  "plans.write": "operator",
  "plans.review": "admin",
  "campaigns.archive": "admin",
  "brandkit.read": "viewer",
  "brandkit.write": "operator",
  "brandkit.approve": "admin",
  "assets.read": "viewer",
  "assets.write": "operator",
  "assets.review": "admin",
  "assets.archive": "admin",
  "creatives.read": "viewer",
  "creatives.write": "operator",
  "creatives.review": "admin",
} as const satisfies Record<string, Role>;
export type Permission = keyof typeof PERMISSION_MIN_ROLE;

/**
 * Permissions only a signed-in PERSON can hold. The legacy workspace token is admin-equivalent for everything else, but it is not a
 * person and never gets these, whatever its role says.
 */
export const PERSON_ONLY_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>(["credentials.read", "credentials.manage"]);

export const roleAllows = (role: Role, permission: Permission): boolean => RANK[role] >= RANK[PERMISSION_MIN_ROLE[permission]];

/** Every permission name, in table order. */
export const ALL_PERMISSIONS = Object.keys(PERMISSION_MIN_ROLE) as Permission[];
export const isPermission = (v: unknown): v is Permission => typeof v === "string" && Object.prototype.hasOwnProperty.call(PERMISSION_MIN_ROLE, v);

/**
 * May this caller do this? A member with a CUSTOM role is judged by that role's exact permission set (it replaces the built-in set); everyone else by the
 * built-in role. The person-only rule applies either way: the workspace token can never hold credential permissions.
 */
export const authzAllows = (a: { role: Role; actor: { kind: string }; customPermissions?: ReadonlySet<Permission> | undefined }, permission: Permission): boolean =>
  (a.customPermissions ? a.customPermissions.has(permission) : roleAllows(a.role, permission)) && !(PERSON_ONLY_PERMISSIONS.has(permission) && a.actor.kind !== "user");
/**
 * What a caller may do, as permission names, for the browser to show or disable controls. The browser only SHOWS this: every route still checks the
 * permission on the server. Person-only permissions (credentials) are left out for the legacy workspace token, which can never use them.
 */
export const permissionsFor = (role: Role, actorKind: "user" | "legacy_token" | "system", custom?: ReadonlySet<Permission>): Permission[] =>
  ALL_PERMISSIONS.filter((p) => authzAllows({ role, actor: { kind: actorKind }, customPermissions: custom }, p));
export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);

/**
 * Every workspace route and the permission it needs. The server refuses a workspace route that is missing from this table, so a
 * new route cannot be added without an explicit authorization decision. HEAD uses the GET entry. Trailing slashes are ignored.
 */
export const ROUTE_PERMISSIONS: Readonly<Record<string, Permission>> = {
  "GET /api/workspaces/:wid": "workspace.read",
  "GET /api/workspaces/:wid/dashboard": "workspace.read",
  "PATCH /api/workspaces/:wid": "workspace.update",
  "GET /api/workspaces/:wid/brain": "brain.read",
  "PUT /api/workspaces/:wid/brain": "brain.write",
  "GET /api/workspaces/:wid/brain/provenance": "brain.read",
  "GET /api/workspaces/:wid/campaigns": "campaigns.read",
  "POST /api/workspaces/:wid/campaigns/generate": "campaigns.generate",
  "GET /api/workspaces/:wid/campaigns/:cid": "campaigns.read",
  "PUT /api/workspaces/:wid/campaigns/:cid/brief": "campaigns.edit",
  "POST /api/workspaces/:wid/campaigns/:cid/proposals": "proposals.create",
  "POST /api/workspaces/:wid/campaigns/:cid/simulate-lead": "leads.simulate",
  "GET /api/workspaces/:wid/proposals/:pid": "proposals.read",
  "POST /api/workspaces/:wid/proposals/:pid/approve": "proposals.decide",
  "POST /api/workspaces/:wid/proposals/:pid/reject": "proposals.decide",
  "POST /api/workspaces/:wid/proposals/:pid/execute": "proposals.execute",
  "GET /api/workspaces/:wid/plans": "plans.read",
  "POST /api/workspaces/:wid/plans/recommend": "plans.write",
  "GET /api/workspaces/:wid/plans/:plid": "plans.read",
  "PATCH /api/workspaces/:wid/plans/:plid": "plans.write",
  "PATCH /api/workspaces/:wid/plans/:plid/opportunities/:opid": "plans.write",
  "POST /api/workspaces/:wid/plans/:plid/generate": "plans.write",
  "POST /api/workspaces/:wid/plans/:plid/opportunities/:opid/regenerate": "plans.write",
  "POST /api/workspaces/:wid/plans/:plid/apply-allocations": "plans.write",
  "POST /api/workspaces/:wid/plans/:plid/budget-review": "plans.review",
  "POST /api/workspaces/:wid/plans/:plid/archive": "plans.write",
  "POST /api/workspaces/:wid/campaigns/:cid/archive": "campaigns.archive",
  "POST /api/workspaces/:wid/campaigns/:cid/complete": "campaigns.archive",
  "GET /api/workspaces/:wid/brand-kit": "brandkit.read",
  "PUT /api/workspaces/:wid/brand-kit": "brandkit.write",
  "POST /api/workspaces/:wid/brand-kit/submit": "brandkit.write",
  "POST /api/workspaces/:wid/brand-kit/approve": "brandkit.approve",
  "POST /api/workspaces/:wid/brand-kit/reject": "brandkit.approve",
  "GET /api/workspaces/:wid/brand-kit/versions": "brandkit.read",
  "GET /api/workspaces/:wid/assets": "assets.read",
  "POST /api/workspaces/:wid/assets": "assets.write",
  "GET /api/workspaces/:wid/assets/:aid": "assets.read",
  "POST /api/workspaces/:wid/assets/:aid/versions": "assets.write",
  "GET /api/workspaces/:wid/assets/:aid/versions/:v/file": "assets.read",
  "POST /api/workspaces/:wid/assets/:aid/versions/:v/submit": "assets.write",
  "POST /api/workspaces/:wid/assets/:aid/versions/:v/approve": "assets.review",
  "POST /api/workspaces/:wid/assets/:aid/versions/:v/reject": "assets.review",
  "POST /api/workspaces/:wid/assets/:aid/archive": "assets.archive",
  "GET /api/workspaces/:wid/creative/providers": "creatives.read",
  "GET /api/workspaces/:wid/campaigns/:cid/creative-concepts": "creatives.read",
  "GET /api/workspaces/:wid/campaigns/:cid/creatives": "creatives.read",
  "POST /api/workspaces/:wid/campaigns/:cid/creatives": "creatives.write",
  "GET /api/workspaces/:wid/creatives/:crid": "creatives.read",
  "POST /api/workspaces/:wid/creatives/:crid/versions": "creatives.write",
  "POST /api/workspaces/:wid/creatives/:crid/archive": "creatives.write",
  "POST /api/workspaces/:wid/creatives/:crid/versions/:v/renders": "creatives.write",
  "POST /api/workspaces/:wid/creatives/:crid/versions/:v/images": "creatives.write",
  "POST /api/workspaces/:wid/creatives/:crid/versions/:v/check": "creatives.read",
  "POST /api/workspaces/:wid/creatives/:crid/versions/:v/submit": "creatives.write",
  "POST /api/workspaces/:wid/creatives/:crid/versions/:v/approve": "creatives.review",
  "POST /api/workspaces/:wid/creatives/:crid/versions/:v/reject": "creatives.review",
  "GET /api/workspaces/:wid/creatives/:crid/versions/:v/pictures/:ratio/file": "creatives.read",
  "POST /api/workspaces/:wid/renders/:rid/cancel": "creatives.write",
  "POST /api/workspaces/:wid/renders/:rid/retry": "creatives.write",
  "GET /api/workspaces/:wid/policy": "workspace.read",
  "PUT /api/workspaces/:wid/policy": "policy.manage",
  "GET /api/workspaces/:wid/ai/settings": "ai.settings.read",
  "PUT /api/workspaces/:wid/ai/settings": "ai.settings.write",
  "GET /api/workspaces/:wid/ai/usage": "ai.usage.read",
  "POST /api/workspaces/:wid/ai/connection-test": "ai.connection_test",
  "GET /api/workspaces/:wid/ai/status": "ai.settings.read",
  "POST /api/workspaces/:wid/ai/test-request": "ai.connection_test",
  "POST /api/workspaces/:wid/website-analyses": "brain.write",
  "GET /api/workspaces/:wid/website-analyses/latest": "brain.read",
  "GET /api/workspaces/:wid/website-analyses/:aid": "brain.read",
  "POST /api/workspaces/:wid/website-analyses/:aid/retry-ai": "brain.write",
  "POST /api/workspaces/:wid/website-analyses/:aid/approve-safe": "brain.write",
  "POST /api/workspaces/:wid/website-analyses/:aid/insights/:iid": "brain.write",
  "GET /api/workspaces/:wid/website-analyses/:aid/brain-patch": "brain.read",
  "POST /api/workspaces/:wid/website-analyses/:aid/applied": "brain.write",
  "GET /api/workspaces/:wid/leads": "leads.read",
  "GET /api/workspaces/:wid/leads/:lid": "leads.read",
  "PUT /api/workspaces/:wid/leads/:lid/status": "leads.update",
  "POST /api/workspaces/:wid/jobs/:jid/retry": "jobs.retry",
  "GET /api/workspaces/:wid/activity": "activity.read",
  "GET /api/workspaces/:wid/jobs": "jobs.read",
  "GET /api/workspaces/:wid/members": "members.read",
  "POST /api/workspaces/:wid/members": "members.manage",
  "PATCH /api/workspaces/:wid/members/:uid": "members.manage",
  "DELETE /api/workspaces/:wid/members/:uid": "members.manage",
  "GET /api/workspaces/:wid/credentials": "credentials.read",
  "PUT /api/workspaces/:wid/credentials/:kind": "credentials.manage",
  "POST /api/workspaces/:wid/credentials/:kind/revoke": "credentials.manage",
  "DELETE /api/workspaces/:wid/credentials/:kind": "credentials.manage",
  "GET /api/workspaces/:wid/meta-accounts": "meta_accounts.read",
  "POST /api/workspaces/:wid/meta-accounts": "meta_accounts.manage",
  "POST /api/workspaces/:wid/meta-accounts/:aid/disable": "meta_accounts.manage",
  "DELETE /api/workspaces/:wid/meta-accounts/:aid": "meta_accounts.manage",
  "POST /api/workspaces/:wid/legacy-token/disable": "legacy_token.disable",
};

export const routeKey = (method: string, pattern: string): string => `${method === "HEAD" ? "GET" : method} ${pattern.length > 1 ? pattern.replace(/\/$/, "") : pattern}`;

/** Who is acting. Always derived on the server; never read from a request body. */
export type Actor =
  | { kind: "user"; userId: string; label: string }
  | { kind: "legacy_token"; workspaceId: string; label: string }
  | { kind: "system"; label: "system" };

/** The result of authorizing one request for one workspace. `workspaceId` is the verified one: services use it, not the raw URL value. */
export interface AuthzContext {
  workspaceId: string;
  role: Role;
  actor: Actor;
  /** Set only for a member with a custom role: the exact permissions that role grants (it replaces the built-in set for this member). */
  customPermissions?: ReadonlySet<Permission>;
  /** The custom role id, when there is one (for display and audit). */
  customRoleId?: string;
}

export const SYSTEM_ACTOR: Actor = { kind: "system", label: "system" };
export const userActor = (userId: string): Actor => ({ kind: "user", userId, label: `user:${userId}` });
export const legacyTokenActor = (workspaceId: string): Actor => ({ kind: "legacy_token", workspaceId, label: `workspace-token:${workspaceId}` });
