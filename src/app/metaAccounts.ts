import type { Actor } from "../auth/authz.js";
import type { AppContext } from "./context.js";
import { audit, iso, type Core } from "./core.js";
import { AppError, conflict, notFound } from "./errors.js";
import { newId } from "./util.js";
import { setMetaAccount, type Workspace } from "./workspaces.js";

/** The one accepted spelling: "act_" and digits, no leading zero. Anything else is rejected, never "fixed up". */
export const ACCOUNT_ID_RE = /^act_[1-9][0-9]{0,19}$/;
export const parseAccountId = (v: unknown): string | null => (typeof v === "string" && ACCOUNT_ID_RE.test(v) ? v : null);

export type MetaAccountStatus = "active" | "disabled" | "revoked";
export interface MetaAccountRow {
  accountId: string;
  status: MetaAccountStatus;
  source: string;
  addedAt: string;
  addedBy: string;
  updatedAt: string;
  updatedBy: string;
}

/**
 * THE authorization check for a live Meta account. True only if this workspace holds the account, it is ACTIVE, and nobody else
 * holds it. Read fresh from the database on every call. Missing, malformed, disabled, revoked or ambiguous all mean "no".
 */
export function isMetaAccountAuthorized(c: Core, workspaceId: string, accountId: unknown): boolean {
  const id = parseAccountId(accountId);
  if (!id) return false;
  const holders = c.db.prepare("SELECT workspace_id, status FROM workspace_meta_accounts WHERE account_id = ? AND status IN ('active','disabled')").all(id) as Array<{ workspace_id: string; status: string }>;
  return holders.length === 1 && holders[0]!.workspace_id === workspaceId && holders[0]!.status === "active";
}

export function authorizedAccountIds(c: Core, workspaceId: string): string[] {
  return (c.db.prepare("SELECT account_id FROM workspace_meta_accounts WHERE workspace_id = ? AND status = 'active' ORDER BY account_id").all(workspaceId) as Array<{ account_id: string }>)
    .map((r) => r.account_id)
    .filter((id) => isMetaAccountAuthorized(c, workspaceId, id));
}

/** Live mode only: a simulated (mock) connection has no real account to authorize. Used at every point that could reach the connector. */
export function liveAccountDenied(c: AppContext, workspaceId: string, accountId: string): boolean {
  return c.metaFor(workspaceId).mode === "live" && !isMetaAccountAuthorized(c, workspaceId, accountId);
}

export function listMetaAccounts(c: Core, workspaceId: string): MetaAccountRow[] {
  return (c.db.prepare("SELECT account_id, status, source, created_at, created_by, updated_at, updated_by FROM workspace_meta_accounts WHERE workspace_id = ? ORDER BY created_at, account_id").all(workspaceId) as Array<Record<string, string>>).map((r) => ({
    accountId: r.account_id!, status: r.status as MetaAccountStatus, source: r.source!, addedAt: r.created_at!, addedBy: r.created_by!, updatedAt: r.updated_at!, updatedBy: r.updated_by!,
  }));
}

/** One answer for "held by someone else", "not on the operator's allow-list", and "not a real live setup", so it reveals none of them. */
const unavailable = () => conflict("meta_account_unavailable", "This ad account cannot be authorized for this workspace");
const notAuthorized = () => conflict("meta_account_not_authorized", "This ad account is not authorized for this workspace");

function busyOr(e: unknown, fallback: () => never): never {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) throw new AppError(503, "busy", "The workspace is being changed by another request; try again");
  if (code === "SQLITE_CONSTRAINT_UNIQUE") return fallback(); // lost a race for the account to another workspace
  throw e;
}

/**
 * An OWNER states that this workspace controls the ad account. Allowed only if the operator's global allow-list includes the account
 * (the intersection rule) and no other workspace holds it. This is an assertion, not proof of ownership: see the migration notes.
 */
export function authorizeMetaAccount(c: AppContext, actor: Actor, workspaceId: string, accountId: string): void {
  const id = parseAccountId(accountId);
  if (!id || !c.integrations.liveMeta || !c.metaWriteAllowlist().includes(id)) throw unavailable();
  const at = iso(c);
  const run = c.db.transaction(() => {
    const holders = c.db.prepare("SELECT workspace_id, status FROM workspace_meta_accounts WHERE account_id = ? AND status IN ('active','disabled')").all(id) as Array<{ workspace_id: string; status: string }>;
    if (holders.some((h) => h.workspace_id !== workspaceId)) throw unavailable();
    const own = c.db.prepare("SELECT status FROM workspace_meta_accounts WHERE workspace_id = ? AND account_id = ?").get(workspaceId, id) as { status: string } | undefined;
    if (own?.status === "active") return;
    if (own) c.db.prepare("UPDATE workspace_meta_accounts SET status = 'active', updated_at = ?, updated_by = ? WHERE workspace_id = ? AND account_id = ?").run(at, actor.label, workspaceId, id);
    else c.db.prepare("INSERT INTO workspace_meta_accounts (id, workspace_id, account_id, status, source, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,'active','owner_assertion',?,?,?,?)").run(newId("mac"), workspaceId, id, at, actor.label, at, actor.label);
    audit(c, workspaceId, actor.label, "meta_account.authorized", "meta_account", id, { accountId: id, source: "owner_assertion", reactivated: !!own });
  });
  try {
    run.immediate();
  } catch (e) {
    busyOr(e, () => { throw unavailable(); });
  }
}

function setStatus(c: Core, actor: Actor, workspaceId: string, accountId: string, from: MetaAccountStatus[], to: MetaAccountStatus, event: string): void {
  const id = parseAccountId(accountId);
  if (!id) throw notFound("Ad account");
  const at = iso(c);
  c.db.transaction(() => {
    const own = c.db.prepare("SELECT status FROM workspace_meta_accounts WHERE workspace_id = ? AND account_id = ?").get(workspaceId, id) as { status: MetaAccountStatus } | undefined;
    if (!own || (own.status !== to && !from.includes(own.status))) throw notFound("Ad account"); // another workspace's account looks exactly like a missing one
    if (own.status === to) return;
    c.db.prepare("UPDATE workspace_meta_accounts SET status = ?, updated_at = ?, updated_by = ? WHERE workspace_id = ? AND account_id = ?").run(to, at, actor.label, workspaceId, id);
    audit(c, workspaceId, actor.label, event, "meta_account", id, { accountId: id, from: own.status });
  })();
}

/** Suspend an account: it stops working at once and can be re-enabled by authorizing it again. */
export const disableMetaAccount = (c: Core, actor: Actor, wid: string, accountId: string): void => setStatus(c, actor, wid, accountId, ["active"], "disabled", "meta_account.disabled");
/** End an authorization. The row stays for history, and the account becomes available to others. */
export const revokeMetaAccount = (c: Core, actor: Actor, wid: string, accountId: string): void => setStatus(c, actor, wid, accountId, ["active", "disabled"], "revoked", "meta_account.revoked");

/**
 * Choose the workspace's working Meta account. In live mode only an account this workspace is currently authorized for can be chosen;
 * clearing (null) is always allowed. In mock mode the setting is inert (the simulator is used), so it behaves as before.
 */
export function selectMetaAccount(c: AppContext, workspaceId: string, accountId: string | null, actor: Actor): Workspace {
  if (accountId !== null && c.integrations.liveMeta && !isMetaAccountAuthorized(c, workspaceId, accountId)) throw notAuthorized();
  return setMetaAccount(c, workspaceId, accountId, actor.label);
}
