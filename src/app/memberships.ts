import { authzAllows, isRole, type Actor, type Permission, type Role } from "../auth/authz.js";
import { audit, iso, type Core } from "./core.js";
import { AppError, conflict, forbidden, notFound } from "./errors.js";
import { newId, newToken, safeEqual, sha256 } from "./util.js";
import { customRolePermissions, ensurePersonalOrgOwner, orgAudit } from "./organizations.js";
import { ensureWorkspaceDefaults } from "./tenancy.js";
import { getWorkspace, type Workspace } from "./workspaces.js";

export interface Membership {
  workspaceId: string;
  userId: string;
  role: Role;
  status: "active" | "revoked";
  /** Set when the member has a custom role (which then replaces the built-in set). */
  customRoleId: string | null;
}

interface Row {
  workspace_id: string;
  user_id: string;
  role: string;
  status: "active" | "revoked";
  custom_role_id: string | null;
}

/** The CURRENT active membership, read fresh from the database on every call. Nothing about roles is cached or taken from a token. */
export function activeMembership(c: Core, userId: string, workspaceId: string): Membership | null {
  const r = c.db.prepare("SELECT workspace_id, user_id, role, status, custom_role_id FROM workspace_memberships WHERE workspace_id = ? AND user_id = ? AND status = 'active'").get(workspaceId, userId) as Row | undefined;
  return r && isRole(r.role) ? { workspaceId: r.workspace_id, userId: r.user_id, role: r.role, status: r.status, customRoleId: r.custom_role_id } : null;
}

/**
 * May this approval authorize an action in this mode RIGHT NOW? Used by the executor before any external call.
 *
 *   user          an active member whose current role may approve, in any mode
 *   legacy_token  the workspace token is not a person: it may authorize only a SIMULATED (mock) action, and only while enabled
 *   unverified    recorded without an identity: simulated (mock) actions only
 *   anything else, or no approval at all: never
 *
 * A live (real, external) write therefore always rests on a signed-in person who still holds an approving role.
 */
export function approverMayAuthorize(c: Core, approval: { approver_kind: string; approver_user_id: string | null } | undefined, workspaceId: string, mode: "mock" | "live"): boolean {
  if (!approval) return false;
  if (approval.approver_kind === "user") {
    const m = approval.approver_user_id ? activeMembership(c, approval.approver_user_id, workspaceId) : null;
    return !!m && memberMayDo(c, m, "proposals.decide");
  }
  if (approval.approver_kind === "legacy_token") return mode === "mock" && legacyTokenEnabled(c, workspaceId);
  if (approval.approver_kind === "unverified") return mode === "mock";
  return false;
}

/** Does this member hold this permission right now? Custom roles are judged by their own exact set; a vanished or archived custom role grants nothing. */
export function memberMayDo(c: Core, m: Membership, permission: Permission): boolean {
  if (m.customRoleId) {
    const set = customRolePermissions(c, m.customRoleId);
    return !!set && authzAllows({ role: m.role, actor: { kind: "user" }, customPermissions: set }, permission);
  }
  return authzAllows({ role: m.role, actor: { kind: "user" } }, permission);
}

export function legacyTokenEnabled(c: Core, workspaceId: string): boolean {
  const r = c.db.prepare("SELECT legacy_token_disabled_at d FROM workspaces WHERE id = ?").get(workspaceId) as { d: string | null } | undefined;
  return !!r && r.d === null;
}

export function listUserWorkspaces(c: Core, userId: string): Array<{ id: string; name: string; role: Role }> {
  return (c.db
    .prepare(`SELECT w.id, w.name, m.role FROM workspace_memberships m JOIN workspaces w ON w.id = m.workspace_id
              WHERE m.user_id = ? AND m.status = 'active' ORDER BY w.created_at, w.id`)
    .all(userId) as Array<{ id: string; name: string; role: Role }>);
}

export function listMembers(c: Core, workspaceId: string) {
  return (c.db
    .prepare(`SELECT m.user_id, u.email, u.display_name, m.role, m.status, m.created_at, m.revoked_at, m.custom_role_id, t.name AS custom_role_name
              FROM workspace_memberships m JOIN users u ON u.id = m.user_id LEFT JOIN role_templates t ON t.id = m.custom_role_id WHERE m.workspace_id = ? ORDER BY m.created_at, m.user_id`)
    .all(workspaceId) as Array<Record<string, unknown>>).map((r) => ({
    userId: r.user_id, email: r.email ?? null, displayName: r.display_name ?? null, role: r.role, status: r.status, addedAt: r.created_at, revokedAt: r.revoked_at ?? null, customRoleId: r.custom_role_id ?? null, customRoleName: r.custom_role_name ?? null,
  }));
}

const activeOwners = (c: Core, workspaceId: string): number =>
  (c.db.prepare("SELECT COUNT(*) n FROM workspace_memberships WHERE workspace_id = ? AND status = 'active' AND role = 'owner'").get(workspaceId) as { n: number }).n;

const userExists = (c: Core, userId: string): boolean => !!c.db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId);

/** Add a member (or reactivate a revoked one). Callers must already hold `members.manage`; only owners do. */
export function addMember(c: Core, actor: Actor, workspaceId: string, userId: string, role: Role): void {
  if (!userExists(c, userId)) throw notFound("User");
  const at = iso(c);
  c.db.transaction(() => {
    const cur = c.db.prepare("SELECT status FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?").get(workspaceId, userId) as { status: string } | undefined;
    if (cur?.status === "active") throw conflict("already_member", "That user is already a member; change their role instead");
    if (cur) {
      c.db.prepare("UPDATE workspace_memberships SET role = ?, custom_role_id = NULL, status = 'active', updated_at = ?, revoked_at = NULL, revoked_by = NULL WHERE workspace_id = ? AND user_id = ?").run(role, at, workspaceId, userId);
    } else {
      c.db.prepare("INSERT INTO workspace_memberships (id, workspace_id, user_id, role, status, created_at, created_by, updated_at) VALUES (?,?,?,?,'active',?,?,?)").run(newId("mem"), workspaceId, userId, role, at, actor.label, at);
    }
    audit(c, workspaceId, actor.label, "membership.added", "user", userId, { role, reactivated: !!cur });
  })();
}

export function changeRole(c: Core, actor: Actor, workspaceId: string, userId: string, role: Role): void {
  c.db.transaction(() => {
    const cur = c.db.prepare("SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = ? AND status = 'active'").get(workspaceId, userId) as { role: string } | undefined;
    if (!cur) throw notFound("Member");
    if (cur.role === "owner" && role !== "owner" && activeOwners(c, workspaceId) <= 1) throw conflict("last_owner", "A workspace must keep at least one owner; make someone else an owner first");
    c.db.prepare("UPDATE workspace_memberships SET role = ?, custom_role_id = NULL, updated_at = ? WHERE workspace_id = ? AND user_id = ?").run(role, iso(c), workspaceId, userId);
    audit(c, workspaceId, actor.label, "membership.role_changed", "user", userId, { from: cur.role, to: role });
  })();
}

/**
 * Gives a member a built-in role OR one of the workspace's organization's custom roles. Only one of the two applies at a time. The last owner cannot be moved
 * off the owner role, and a custom role (which can never carry owner-only permissions) counts as "not an owner" for that rule.
 */
export function assignMemberRole(c: Core, actor: Actor, workspaceId: string, userId: string, input: { role?: Role; customRoleId?: string }): void {
  if (!!input.role === !!input.customRoleId) throw new AppError(400, "validation", "Choose either a built-in role or a custom role");
  c.db.transaction(() => {
    const cur = c.db.prepare("SELECT role, custom_role_id FROM workspace_memberships WHERE workspace_id = ? AND user_id = ? AND status = 'active'").get(workspaceId, userId) as { role: string; custom_role_id: string | null } | undefined;
    if (!cur) throw notFound("Member");
    const wasOwner = cur.role === "owner" && !cur.custom_role_id;
    if (input.customRoleId) {
      const orgId = (c.db.prepare("SELECT organization_id o FROM workspaces WHERE id = ?").get(workspaceId) as { o: string | null } | undefined)?.o;
      const t = c.db.prepare("SELECT id, archived_at FROM role_templates WHERE id = ? AND organization_id = ?").get(input.customRoleId, orgId ?? "") as { id: string; archived_at: string | null } | undefined;
      if (!t) throw notFound("Role"); // a role from another organization looks like one that does not exist
      if (t.archived_at) throw conflict("role_archived", "This role is archived");
      if (wasOwner && activeOwners(c, workspaceId) <= 1) throw conflict("last_owner", "A workspace must keep at least one owner; make someone else an owner first");
      c.db.prepare("UPDATE workspace_memberships SET role = 'viewer', custom_role_id = ?, updated_at = ? WHERE workspace_id = ? AND user_id = ?").run(t.id, iso(c), workspaceId, userId);
      audit(c, workspaceId, actor.label, "membership.role_changed", "user", userId, { from: cur.custom_role_id ? "custom" : cur.role, to: "custom", customRoleId: t.id });
      if (orgId) orgAudit(c, orgId, actor.label, "access.role_assigned", "user", userId, { workspaceId, customRoleId: t.id });
    } else {
      if (wasOwner && input.role !== "owner" && activeOwners(c, workspaceId) <= 1) throw conflict("last_owner", "A workspace must keep at least one owner; make someone else an owner first");
      c.db.prepare("UPDATE workspace_memberships SET role = ?, custom_role_id = NULL, updated_at = ? WHERE workspace_id = ? AND user_id = ?").run(input.role, iso(c), workspaceId, userId);
      audit(c, workspaceId, actor.label, "membership.role_changed", "user", userId, { from: cur.custom_role_id ? "custom" : cur.role, to: input.role });
    }
  })();
}

export function removeMember(c: Core, actor: Actor, workspaceId: string, userId: string): void {
  c.db.transaction(() => {
    const cur = c.db.prepare("SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = ? AND status = 'active'").get(workspaceId, userId) as { role: string } | undefined;
    if (!cur) throw notFound("Member");
    if (cur.role === "owner" && activeOwners(c, workspaceId) <= 1) throw conflict("last_owner", "A workspace must keep at least one owner; make someone else an owner first");
    const at = iso(c);
    c.db.prepare("UPDATE workspace_memberships SET status = 'revoked', revoked_at = ?, revoked_by = ?, updated_at = ? WHERE workspace_id = ? AND user_id = ?").run(at, actor.label, at, workspaceId, userId);
    audit(c, workspaceId, actor.label, "membership.revoked", "user", userId, { role: cur.role });
  })();
}

/**
 * A signed-in person creates a workspace and becomes its owner. The workspace gets a random, never-revealed legacy token that is
 * disabled from the start, so it can only ever be reached through memberships.
 */
export function createWorkspaceForUser(c: Core, actor: Actor & { kind: "user" }, name: string): Workspace {
  const id = newId("ws");
  const at = iso(c);
  c.db.transaction(() => {
    c.db.prepare("INSERT INTO workspaces (id, name, token_hash, created_at, legacy_token_disabled_at) VALUES (?,?,?,?,?)").run(id, name, sha256(newToken()), at, at);
    c.db.prepare("INSERT INTO workspace_memberships (id, workspace_id, user_id, role, status, created_at, created_by, updated_at) VALUES (?,?,?,?,'active',?,?,?)").run(newId("mem"), id, actor.userId, "owner", at, actor.label, at);
    const orgId = ensureWorkspaceDefaults(c, id, { createdBy: actor.userId });
    ensurePersonalOrgOwner(c, orgId, actor.userId, actor.label);
    audit(c, id, actor.label, "workspace.created", "workspace", id, { name, owner: actor.userId, organizationId: orgId });
  })();
  return getWorkspace(c, id);
}

/**
 * Bootstrap for a workspace that predates memberships: a signed-in person who presents the workspace's token becomes its first
 * owner. Refused if the workspace already has an active owner (the token cannot be used to add a second owner or take one over),
 * if the token is disabled or wrong. Wrong token and unknown workspace give the same answer.
 */
export function claimWorkspace(c: Core, actor: Actor & { kind: "user" }, workspaceId: string, token: string): Workspace {
  /** The conditions for a claim. Wrong token, unknown workspace and disabled token are one answer. Read-only. */
  const check = () => {
    const r = c.db.prepare("SELECT token_hash, legacy_token_disabled_at d FROM workspaces WHERE id = ?").get(workspaceId) as { token_hash: string; d: string | null } | undefined;
    if (!r || r.d !== null || !safeEqual(r.token_hash, sha256(token))) throw notFound("Workspace");
    if (activeOwners(c, workspaceId) > 0) throw conflict("already_claimed", "This workspace already has an owner; ask an owner to add you");
  };
  // 1) A cheap read-only pre-check, so invalid or repeated claims never take the database's write lock.
  check();
  const at = iso(c);
  // 2) The decisive check and the write happen in ONE transaction that takes the write lock up front (BEGIN IMMEDIATE). Another
  //    connection or process cannot commit a claim between the check and the insert: it waits for the lock (SQLite's busy timeout),
  //    then re-runs the check, sees the new owner, and gets "already_claimed". A deferred transaction would read first and could
  //    lose that race.
  const claim = c.db.transaction(() => {
    check();
    const cur = c.db.prepare("SELECT 1 FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?").get(workspaceId, actor.userId);
    if (cur) c.db.prepare("UPDATE workspace_memberships SET role = 'owner', status = 'active', updated_at = ?, revoked_at = NULL, revoked_by = NULL WHERE workspace_id = ? AND user_id = ?").run(at, workspaceId, actor.userId);
    else c.db.prepare("INSERT INTO workspace_memberships (id, workspace_id, user_id, role, status, created_at, created_by, updated_at) VALUES (?,?,?,?,'active',?,?,?)").run(newId("mem"), workspaceId, actor.userId, "owner", at, actor.label, at);
    const orgId = ensureWorkspaceDefaults(c, workspaceId, { createdBy: actor.userId });
    ensurePersonalOrgOwner(c, orgId, actor.userId, actor.label);
    audit(c, workspaceId, actor.label, "workspace.claimed", "workspace", workspaceId, { owner: actor.userId });
  });
  try {
    claim.immediate();
  } catch (e) {
    // Expected contention (the lock was not free within the busy timeout) is a retryable 503, not an unexplained 500. Nothing was written.
    if (typeof (e as { code?: unknown }).code === "string" && (e as { code: string }).code.startsWith("SQLITE_BUSY")) throw new AppError(503, "busy", "The workspace is being changed by another request; try again");
    throw e;
  }
  return getWorkspace(c, workspaceId);
}

export function disableLegacyToken(c: Core, actor: Actor, workspaceId: string): void {
  if (actor.kind !== "user") throw forbidden("forbidden", "Only a signed-in owner can disable the workspace token");
  const at = iso(c);
  c.db.transaction(() => {
    c.db.prepare("UPDATE workspaces SET legacy_token_disabled_at = COALESCE(legacy_token_disabled_at, ?) WHERE id = ?").run(at, workspaceId);
    audit(c, workspaceId, actor.label, "workspace.legacy_token_disabled", "workspace", workspaceId, {});
  })();
}
