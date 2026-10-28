import { z } from "zod";
import { isRole, isPermission, type Actor, type Permission, type Role } from "../auth/authz.js";
import { CUSTOMIZABLE_PERMISSIONS, ORG_ROLES, OWNER_ONLY_PERMISSIONS, PERMISSION_CATALOG, isOrgRole, type OrgRole } from "../auth/orgAuthz.js";
import { audit, iso, type Core } from "./core.js";
import { AppError, conflict, forbidden, notFound } from "./errors.js";
import { ensureWorkspaceDefaults } from "./tenancy.js";
import { newId, newToken, sha256 } from "./util.js";

/**
 * Organizations, organization membership, custom role templates and the grants that connect them to client workspaces.
 *
 * The rules that matter:
 *  - Organization membership never gives access to a workspace's data. Access is always an explicit workspace membership.
 *  - Everything here is for a signed-in PERSON. The legacy workspace token is not one and never reaches these functions (the routes refuse it first).
 *  - A custom role is a template owned by one organization; it replaces the built-in permission set of the member it is assigned to, and it can never contain
 *    the owner-only permissions, so it cannot be used to create owners or change policy.
 *  - Every change is written to the organization's own append-only trail (and to the workspace trail where a workspace is affected).
 */

export interface Organization { id: string; name: string; kind: "personal" | "agency"; createdAt: string }
const orgOf = (r: Record<string, unknown>): Organization => ({ id: r.id as string, name: r.name as string, kind: r.kind as "personal" | "agency", createdAt: r.created_at as string });

export function orgAudit(c: Core, orgId: string, actor: string, type: string, entityType: string, entityId: string, detail: Record<string, unknown> = {}): void {
  c.db.prepare("INSERT INTO organization_audit_events (organization_id, at, actor, type, entity_type, entity_id, detail) VALUES (?,?,?,?,?,?,?)").run(orgId, iso(c), actor, type, entityType, entityId, JSON.stringify(detail));
}

export function orgAuditView(c: Core, orgId: string, limit = 100) {
  return (c.db.prepare("SELECT id, at, actor, type, entity_type, entity_id, detail FROM organization_audit_events WHERE organization_id = ? ORDER BY id DESC LIMIT ?").all(orgId, limit) as Array<Record<string, unknown>>)
    .map((r) => ({ id: r.id, at: r.at, actor: r.actor, type: r.type, entityType: r.entity_type, entityId: r.entity_id, detail: JSON.parse(String(r.detail)) as unknown }));
}

export function getOrganization(c: Core, orgId: string): Organization {
  const r = c.db.prepare("SELECT id, name, kind, created_at FROM organizations WHERE id = ?").get(orgId) as Record<string, unknown> | undefined;
  if (!r) throw notFound("Organization");
  return orgOf(r);
}

export interface OrgMembership { organizationId: string; userId: string; role: OrgRole }
/** The CURRENT active organization membership, read fresh on every call. */
export function activeOrgMembership(c: Core, userId: string, orgId: string): OrgMembership | null {
  const r = c.db.prepare("SELECT organization_id, user_id, role FROM organization_memberships WHERE organization_id = ? AND user_id = ? AND status = 'active'").get(orgId, userId) as { organization_id: string; user_id: string; role: string } | undefined;
  return r && isOrgRole(r.role) ? { organizationId: r.organization_id, userId: r.user_id, role: r.role } : null;
}

export function listUserOrganizations(c: Core, userId: string): Array<Organization & { role: OrgRole }> {
  return (c.db.prepare(`SELECT o.id, o.name, o.kind, o.created_at, m.role FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
                        WHERE m.user_id = ? AND m.status = 'active' ORDER BY o.created_at, o.id`).all(userId) as Array<Record<string, unknown>>).map((r) => ({ ...orgOf(r), role: r.role as OrgRole }));
}

const activeOrgOwners = (c: Core, orgId: string): number => (c.db.prepare("SELECT COUNT(*) n FROM organization_memberships WHERE organization_id = ? AND status = 'active' AND role = 'owner'").get(orgId) as { n: number }).n;
const userExists = (c: Core, userId: string): boolean => !!c.db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId);

/** A signed-in person starts an agency organization and becomes its owner. */
export function createAgencyOrganization(c: Core, actor: Actor & { kind: "user" }, name: string): Organization {
  const id = newId("org");
  const at = iso(c);
  c.db.transaction(() => {
    c.db.prepare("INSERT INTO organizations (id, name, kind, created_at, created_by) VALUES (?,?, 'agency', ?, ?)").run(id, name, at, actor.userId);
    c.db.prepare("INSERT INTO organization_memberships (id, organization_id, user_id, role, status, created_at, created_by, updated_at) VALUES (?,?,?,'owner','active',?,?,?)").run(newId("om"), id, actor.userId, at, actor.label, at);
    orgAudit(c, id, actor.label, "organization.created", "organization", id, { name, kind: "agency" });
  })();
  return getOrganization(c, id);
}

/** Makes a person the owner of a workspace's personal organization if it has none yet (a direct business owner manages their own roles). Idempotent. */
export function ensurePersonalOrgOwner(c: Core, orgId: string, userId: string, actorLabel: string): void {
  const org = c.db.prepare("SELECT kind FROM organizations WHERE id = ?").get(orgId) as { kind: string } | undefined;
  if (!org || org.kind !== "personal" || activeOrgOwners(c, orgId) > 0) return;
  const at = iso(c);
  const cur = c.db.prepare("SELECT 1 FROM organization_memberships WHERE organization_id = ? AND user_id = ?").get(orgId, userId);
  if (cur) c.db.prepare("UPDATE organization_memberships SET role = 'owner', status = 'active', updated_at = ?, revoked_at = NULL, revoked_by = NULL WHERE organization_id = ? AND user_id = ?").run(at, orgId, userId);
  else c.db.prepare("INSERT INTO organization_memberships (id, organization_id, user_id, role, status, created_at, created_by, updated_at) VALUES (?,?,?,'owner','active',?,?,?)").run(newId("om"), orgId, userId, at, actorLabel, at);
  orgAudit(c, orgId, actorLabel, "organization.owner_set", "user", userId, { reason: "workspace_owner" });
}

export function listOrgMembers(c: Core, orgId: string) {
  return (c.db.prepare(`SELECT m.user_id, u.email, u.display_name, m.role, m.status, m.created_at FROM organization_memberships m JOIN users u ON u.id = m.user_id
                        WHERE m.organization_id = ? ORDER BY m.created_at, m.user_id`).all(orgId) as Array<Record<string, unknown>>)
    .map((r) => ({ userId: r.user_id, email: r.email ?? null, displayName: r.display_name ?? null, role: r.role, status: r.status, addedAt: r.created_at }));
}

export function addOrgMember(c: Core, actor: Actor, orgId: string, userId: string, role: OrgRole): void {
  if (!userExists(c, userId)) throw notFound("User");
  const at = iso(c);
  c.db.transaction(() => {
    const cur = c.db.prepare("SELECT status FROM organization_memberships WHERE organization_id = ? AND user_id = ?").get(orgId, userId) as { status: string } | undefined;
    if (cur?.status === "active") throw conflict("already_member", "That person is already a member; change their role instead");
    if (cur) c.db.prepare("UPDATE organization_memberships SET role = ?, status = 'active', updated_at = ?, revoked_at = NULL, revoked_by = NULL WHERE organization_id = ? AND user_id = ?").run(role, at, orgId, userId);
    else c.db.prepare("INSERT INTO organization_memberships (id, organization_id, user_id, role, status, created_at, created_by, updated_at) VALUES (?,?,?,?,'active',?,?,?)").run(newId("om"), orgId, userId, role, at, actor.label, at);
    orgAudit(c, orgId, actor.label, "org_membership.added", "user", userId, { role, reactivated: !!cur });
  })();
}

export function changeOrgRole(c: Core, actor: Actor, orgId: string, userId: string, role: OrgRole): void {
  c.db.transaction(() => {
    const cur = c.db.prepare("SELECT role FROM organization_memberships WHERE organization_id = ? AND user_id = ? AND status = 'active'").get(orgId, userId) as { role: string } | undefined;
    if (!cur) throw notFound("Member");
    if (cur.role === "owner" && role !== "owner" && activeOrgOwners(c, orgId) <= 1) throw conflict("last_owner", "An organization must keep at least one owner; make someone else an owner first");
    c.db.prepare("UPDATE organization_memberships SET role = ?, updated_at = ? WHERE organization_id = ? AND user_id = ?").run(role, iso(c), orgId, userId);
    orgAudit(c, orgId, actor.label, "org_membership.role_changed", "user", userId, { from: cur.role, to: role });
  })();
}

export function removeOrgMember(c: Core, actor: Actor, orgId: string, userId: string): void {
  c.db.transaction(() => {
    const cur = c.db.prepare("SELECT role FROM organization_memberships WHERE organization_id = ? AND user_id = ? AND status = 'active'").get(orgId, userId) as { role: string } | undefined;
    if (!cur) throw notFound("Member");
    if (cur.role === "owner" && activeOrgOwners(c, orgId) <= 1) throw conflict("last_owner", "An organization must keep at least one owner; make someone else an owner first");
    const at = iso(c);
    c.db.prepare("UPDATE organization_memberships SET status = 'revoked', revoked_at = ?, revoked_by = ?, updated_at = ? WHERE organization_id = ? AND user_id = ?").run(at, actor.label, at, orgId, userId);
    orgAudit(c, orgId, actor.label, "org_membership.revoked", "user", userId, { role: cur.role });
  })();
}

export function listOrgWorkspaces(c: Core, orgId: string) {
  return (c.db.prepare("SELECT id, name, created_at FROM workspaces WHERE organization_id = ? ORDER BY created_at, id").all(orgId) as Array<{ id: string; name: string; created_at: string }>).map((w) => ({ id: w.id, name: w.name, createdAt: w.created_at }));
}

/** An organization owner or admin creates a client workspace in the organization and becomes its owner. It has no usable workspace token. */
export function createClientWorkspace(c: Core, actor: Actor & { kind: "user" }, orgId: string, name: string): { id: string; name: string; organizationId: string } {
  const id = newId("ws");
  const at = iso(c);
  c.db.transaction(() => {
    c.db.prepare("INSERT INTO workspaces (id, name, token_hash, created_at, legacy_token_disabled_at, organization_id) VALUES (?,?,?,?,?,?)").run(id, name, sha256(newToken()), at, at, orgId);
    c.db.prepare("INSERT INTO workspace_memberships (id, workspace_id, user_id, role, status, created_at, created_by, updated_at) VALUES (?,?,?,'owner','active',?,?,?)").run(newId("mem"), id, actor.userId, at, actor.label, at);
    ensureWorkspaceDefaults(c, id, { organizationId: orgId });
    audit(c, id, actor.label, "workspace.created", "workspace", id, { name, owner: actor.userId, organizationId: orgId });
    orgAudit(c, orgId, actor.label, "workspace.created", "workspace", id, { name });
  })();
  return { id, name, organizationId: orgId };
}

/* ---------------------------------------------------------------- role templates */

export const RoleTemplateSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional(),
  permissions: z.array(z.string()).min(1).max(60),
}).strict();

export interface RoleTemplate { id: string; name: string; description: string | null; permissions: Permission[]; archived: boolean; membersUsing: number }

/** Checks a requested permission list and returns it de-duplicated. Unknown names and owner-only permissions are refused, never silently dropped. */
export function validatePermissionList(list: string[]): Permission[] {
  const out: Permission[] = [];
  for (const p of list) {
    if (!isPermission(p)) throw new AppError(400, "unknown_permission", `Unknown permission: ${p.slice(0, 60)}`);
    if (OWNER_ONLY_PERMISSIONS.has(p)) throw new AppError(400, "owner_only_permission", `${p} stays with the owner role and cannot be put in a custom role`);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** "What can this role do?" in plain language, grouped, plus what it can NOT do. Pure: nothing is saved. */
export function describePermissions(list: Permission[]) {
  const has = new Set(list);
  const groups = new Map<string, { can: string[]; cannot: string[] }>();
  for (const p of Object.keys(PERMISSION_CATALOG) as Permission[]) {
    const { group, label } = PERMISSION_CATALOG[p];
    const g = groups.get(group) ?? { can: [], cannot: [] };
    (has.has(p) ? g.can : g.cannot).push(label);
    groups.set(group, g);
  }
  const warnings: string[] = [];
  if (has.has("proposals.decide") && has.has("proposals.create")) warnings.push("This role can both submit and approve proposals. With separation of duties on, a person still cannot approve their own.");
  if (has.has("proposals.execute") && !has.has("proposals.read")) warnings.push("Running an approved action without being able to see proposals is unusual.");
  if (has.has("campaigns.edit") && !has.has("campaigns.read")) warnings.push("Editing campaigns without being able to read them is unusual.");
  return { groups: [...groups].map(([group, v]) => ({ group, ...v })), warnings };
}

const permsOf = (c: Core, templateId: string): Permission[] =>
  (c.db.prepare("SELECT permission FROM role_template_permissions WHERE template_id = ? ORDER BY permission").all(templateId) as Array<{ permission: string }>).map((r) => r.permission).filter(isPermission);

export function listRoleTemplates(c: Core, orgId: string): RoleTemplate[] {
  return (c.db.prepare("SELECT id, name, description, archived_at FROM role_templates WHERE organization_id = ? ORDER BY name").all(orgId) as Array<{ id: string; name: string; description: string | null; archived_at: string | null }>)
    .map((t) => ({
      id: t.id, name: t.name, description: t.description, permissions: permsOf(c, t.id), archived: t.archived_at !== null,
      membersUsing: (c.db.prepare("SELECT COUNT(*) n FROM workspace_memberships WHERE custom_role_id = ? AND status = 'active'").get(t.id) as { n: number }).n,
    }));
}

function ownedTemplate(c: Core, orgId: string, templateId: string): { id: string; name: string; archived_at: string | null } {
  const t = c.db.prepare("SELECT id, name, archived_at FROM role_templates WHERE id = ? AND organization_id = ?").get(templateId, orgId) as { id: string; name: string; archived_at: string | null } | undefined;
  if (!t) throw notFound("Role");
  return t;
}

export function createRoleTemplate(c: Core, actor: Actor, orgId: string, input: unknown): RoleTemplate {
  const body = RoleTemplateSchema.parse(input);
  const perms = validatePermissionList(body.permissions);
  const id = newId("rol");
  const at = iso(c);
  c.db.transaction(() => {
    if (c.db.prepare("SELECT 1 FROM role_templates WHERE organization_id = ? AND name = ?").get(orgId, body.name)) throw conflict("role_exists", "A role with that name already exists");
    c.db.prepare("INSERT INTO role_templates (id, organization_id, name, description, created_at, created_by, updated_at) VALUES (?,?,?,?,?,?,?)").run(id, orgId, body.name, body.description ?? null, at, actor.label, at);
    const ins = c.db.prepare("INSERT INTO role_template_permissions (template_id, permission) VALUES (?,?)");
    for (const p of perms) ins.run(id, p);
    orgAudit(c, orgId, actor.label, "role.created", "role", id, { name: body.name, permissions: perms });
  })();
  return listRoleTemplates(c, orgId).find((t) => t.id === id)!;
}

/**
 * Edits a template. The change applies to everyone who has the role, immediately (permissions are read fresh on every request), so it is audited with both the
 * old and new lists, in the organization trail and in each affected workspace's trail.
 */
export function updateRoleTemplate(c: Core, actor: Actor, orgId: string, templateId: string, input: unknown): RoleTemplate {
  const body = RoleTemplateSchema.parse(input);
  const perms = validatePermissionList(body.permissions);
  const cur = ownedTemplate(c, orgId, templateId);
  if (cur.archived_at) throw conflict("role_archived", "This role is archived");
  c.db.transaction(() => {
    const clash = c.db.prepare("SELECT 1 FROM role_templates WHERE organization_id = ? AND name = ? AND id != ?").get(orgId, body.name, templateId);
    if (clash) throw conflict("role_exists", "A role with that name already exists");
    const before = permsOf(c, templateId);
    c.db.prepare("UPDATE role_templates SET name = ?, description = ?, updated_at = ? WHERE id = ?").run(body.name, body.description ?? null, iso(c), templateId);
    c.db.prepare("DELETE FROM role_template_permissions WHERE template_id = ?").run(templateId);
    const ins = c.db.prepare("INSERT INTO role_template_permissions (template_id, permission) VALUES (?,?)");
    for (const p of perms) ins.run(templateId, p);
    orgAudit(c, orgId, actor.label, "role.updated", "role", templateId, { name: body.name, before, after: perms });
    const wss = c.db.prepare("SELECT DISTINCT workspace_id w FROM workspace_memberships WHERE custom_role_id = ? AND status = 'active'").all(templateId) as Array<{ w: string }>;
    for (const { w } of wss) audit(c, w, actor.label, "role.permissions_changed", "role", templateId, { name: body.name, before, after: perms });
  })();
  return listRoleTemplates(c, orgId).find((t) => t.id === templateId)!;
}

export function archiveRoleTemplate(c: Core, actor: Actor, orgId: string, templateId: string): void {
  const cur = ownedTemplate(c, orgId, templateId);
  const inUse = (c.db.prepare("SELECT COUNT(*) n FROM workspace_memberships WHERE custom_role_id = ? AND status = 'active'").get(templateId) as { n: number }).n;
  if (inUse > 0) throw conflict("role_in_use", `${inUse} member${inUse === 1 ? " still has" : "s still have"} this role; give them another role first`);
  c.db.transaction(() => {
    c.db.prepare("UPDATE role_templates SET archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?").run(iso(c), iso(c), templateId);
    orgAudit(c, orgId, actor.label, "role.archived", "role", templateId, { name: cur.name });
  })();
}

/** The exact permission set of a custom role, or null if it does not exist or is archived (a member whose role vanished gets NO permissions, never more). */
export function customRolePermissions(c: Core, templateId: string): ReadonlySet<Permission> | null {
  const t = c.db.prepare("SELECT archived_at FROM role_templates WHERE id = ?").get(templateId) as { archived_at: string | null } | undefined;
  if (!t || t.archived_at) return null;
  return new Set(permsOf(c, templateId));
}

export const OrgMemberAddSchema = z.object({ userId: z.string().trim().min(1).max(64), role: z.enum(ORG_ROLES) }).strict();
export const OrgMemberRoleSchema = z.object({ role: z.enum(ORG_ROLES) }).strict();
export const OrgNameSchema = z.object({ name: z.string().trim().min(2).max(80) }).strict();
export const PermissionPreviewSchema = z.object({ permissions: z.array(z.string()).max(60) }).strict();
export const AccessGrantSchema = z.object({
  userId: z.string().trim().min(1).max(64),
  workspaceIds: z.union([z.literal("all"), z.array(z.string().trim().min(1).max(64)).min(1).max(100)]),
  role: z.string().optional(),
  customRoleId: z.string().trim().min(1).max(64).optional(),
}).strict();

/**
 * An organization OWNER gives an active organization member access to some or all of the organization's workspaces, as a built-in role or one of the
 * organization's custom roles. This only writes ordinary workspace memberships: from then on each is judged exactly like any other. It can never grant
 * 'owner' (workspace ownership is handed over only by a workspace owner), and it never touches a workspace outside the organization.
 */
export function grantWorkspaceAccess(c: Core, actor: Actor, orgId: string, input: unknown): { granted: string[] } {
  const body = AccessGrantSchema.parse(input);
  if (!!body.role === !!body.customRoleId) throw new AppError(400, "validation", "Choose either a built-in role or a custom role");
  if (!activeOrgMembership(c, body.userId, orgId)) throw notFound("Member");
  let role: Role = "viewer";
  let customRoleId: string | null = null;
  if (body.role) {
    if (!isRole(body.role) || body.role === "owner") throw new AppError(400, "invalid_role", "Access grants can give viewer, operator or admin; ownership is handed over by a workspace owner");
    role = body.role;
  } else {
    const t = ownedTemplate(c, orgId, body.customRoleId!);
    if (t.archived_at) throw conflict("role_archived", "This role is archived");
    customRoleId = t.id;
  }
  const mine = new Set((c.db.prepare("SELECT id FROM workspaces WHERE organization_id = ?").all(orgId) as Array<{ id: string }>).map((w) => w.id));
  const targets = body.workspaceIds === "all" ? [...mine] : body.workspaceIds;
  for (const w of targets) if (!mine.has(w)) throw notFound("Workspace"); // a workspace outside this organization looks like one that does not exist
  const at = iso(c);
  const granted: string[] = [];
  c.db.transaction(() => {
    for (const w of targets) {
      const cur = c.db.prepare("SELECT role, status FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?").get(w, body.userId) as { role: string; status: string } | undefined;
      if (cur?.status === "active" && cur.role === "owner") continue; // never downgrade an owner through a grant
      if (cur) c.db.prepare("UPDATE workspace_memberships SET role = ?, custom_role_id = ?, status = 'active', updated_at = ?, revoked_at = NULL, revoked_by = NULL WHERE workspace_id = ? AND user_id = ?").run(role, customRoleId, at, w, body.userId);
      else c.db.prepare("INSERT INTO workspace_memberships (id, workspace_id, user_id, role, custom_role_id, status, created_at, created_by, updated_at) VALUES (?,?,?,?,?,'active',?,?,?)").run(newId("mem"), w, body.userId, role, customRoleId, at, actor.label, at);
      audit(c, w, actor.label, "membership.granted_by_organization", "user", body.userId, { role: customRoleId ? "custom" : role, customRoleId });
      granted.push(w);
    }
    orgAudit(c, orgId, actor.label, "access.granted", "user", body.userId, { workspaces: granted.length, role: customRoleId ? "custom" : role, customRoleId });
  })();
  return { granted };
}

export { forbidden, CUSTOMIZABLE_PERMISSIONS };
