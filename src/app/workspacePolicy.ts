import { z } from "zod";
import { forbidden } from "./errors.js";
import type { Actor } from "../auth/authz.js";
import { audit, iso, type Core } from "./core.js";
import { ensureWorkspaceDefaults } from "./tenancy.js";

/** Per-workspace rules that an owner can change. Separation of duties is ON unless an owner switches it off, and switching it off is audited. */
export interface WorkspacePolicy { preventSelfApproval: boolean; updatedAt: string; updatedBy: string }

export const PolicyUpdateSchema = z.object({ preventSelfApproval: z.boolean() }).strict();

export function getPolicy(c: Core, workspaceId: string): WorkspacePolicy {
  ensureWorkspaceDefaults(c, workspaceId); // a workspace from an older build still gets the safe default
  const r = c.db.prepare("SELECT prevent_self_approval p, updated_at, updated_by FROM workspace_policy WHERE workspace_id = ?").get(workspaceId) as { p: number; updated_at: string; updated_by: string };
  return { preventSelfApproval: r.p === 1, updatedAt: r.updated_at, updatedBy: r.updated_by === "system" ? "system" : "a member" };
}

export type SeparationOutcome = "enforced" | "not_enforceable_token_mode" | "policy_off";

/**
 * Separation of duties for any reviewable thing (a proposal, a Brand Kit version, an asset version). `proposedBy` is the server-derived actor label of whoever
 * submitted it. With the policy on (the default) that same actor may not approve it. The shared workspace token is one identity and cannot be told apart from
 * itself, so there the decision is allowed but recorded as "not_enforceable_token_mode", never as separation. Where the submitter is unknown a person's approval
 * is refused because separation cannot be proven.
 */
export function separationOutcome(c: Core, workspaceId: string, proposedBy: string | null, by: { decidedBy: string; approver?: { kind: string } }, subject: string): SeparationOutcome {
  if (!getPolicy(c, workspaceId).preventSelfApproval) return "policy_off";
  const tokenApprover = by.approver?.kind === "legacy_token";
  if (proposedBy && proposedBy === by.decidedBy) {
    if (tokenApprover) return "not_enforceable_token_mode";
    throw forbidden("self_approval_not_allowed", `You submitted this ${subject}, so someone else has to approve it. This workspace requires a second person for approvals.`);
  }
  if (!proposedBy) {
    if (tokenApprover) return "not_enforceable_token_mode";
    throw forbidden("separation_unprovable", `Who submitted this ${subject} was not recorded, so a second person cannot be confirmed. Submit it again and have someone else approve it.`);
  }
  return "enforced";
}

export function setPolicy(c: Core, actor: Actor, workspaceId: string, input: unknown): WorkspacePolicy {
  const body = PolicyUpdateSchema.parse(input);
  const before = getPolicy(c, workspaceId);
  c.db.transaction(() => {
    c.db.prepare("UPDATE workspace_policy SET prevent_self_approval = ?, updated_at = ?, updated_by = ? WHERE workspace_id = ?").run(body.preventSelfApproval ? 1 : 0, iso(c), actor.label, workspaceId);
    audit(c, workspaceId, actor.label, "policy.changed", "workspace", workspaceId, { preventSelfApproval: { from: before.preventSelfApproval, to: body.preventSelfApproval } });
  })();
  return getPolicy(c, workspaceId);
}
