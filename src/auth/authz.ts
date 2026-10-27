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
} as const satisfies Record<string, Role>;
export type Permission = keyof typeof PERMISSION_MIN_ROLE;

/**
 * Permissions only a signed-in PERSON can hold. The legacy workspace token is admin-equivalent for everything else, but it is not a
 * person and never gets these, whatever its role says.
 */
export const PERSON_ONLY_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>(["credentials.read", "credentials.manage"]);

export const roleAllows = (role: Role, permission: Permission): boolean => RANK[role] >= RANK[PERMISSION_MIN_ROLE[permission]];
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
  "GET /api/workspaces/:wid/campaigns": "campaigns.read",
  "POST /api/workspaces/:wid/campaigns/generate": "campaigns.generate",
  "GET /api/workspaces/:wid/campaigns/:cid": "campaigns.read",
  "PUT /api/workspaces/:wid/campaigns/:cid/brief": "campaigns.edit",
  "POST /api/workspaces/:wid/campaigns/:cid/proposals": "proposals.create",
  "POST /api/workspaces/:wid/campaigns/:cid/simulate-lead": "leads.simulate",
  "GET /api/workspaces/:wid/proposals/:pid": "proposals.read",
  "POST /api/workspaces/:wid/proposals/:pid/approve": "proposals.decide",
  "POST /api/workspaces/:wid/proposals/:pid/reject": "proposals.decide",
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
  "GET /api/workspaces/:wid/leads": "leads.read",
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
}

export const SYSTEM_ACTOR: Actor = { kind: "system", label: "system" };
export const userActor = (userId: string): Actor => ({ kind: "user", userId, label: `user:${userId}` });
export const legacyTokenActor = (workspaceId: string): Actor => ({ kind: "legacy_token", workspaceId, label: `workspace-token:${workspaceId}` });
