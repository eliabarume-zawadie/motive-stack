import { timingSafeEqual } from "node:crypto";
import { roleAllows, type AuthzContext, type Permission } from "../auth/authz.js";
import { audit, iso, type Core } from "../app/core.js";
import { AppError, forbidden, notFound } from "../app/errors.js";
import { newId } from "../app/util.js";
import { CredentialCryptoError, newDataKey, open, seal, wipe } from "./crypto.js";
import { KeyUnavailableError, type KeyProvider } from "./keys.js";

export const CREDENTIAL_KINDS = ["openai", "anthropic", "meta_graph", "ghl"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
const isKind = (v: unknown): v is CredentialKind => typeof v === "string" && (CREDENTIAL_KINDS as readonly string[]).includes(v);

/** What is safe to show: never the secret, never key material. */
export interface CredentialStatus {
  kind: CredentialKind;
  status: "active" | "revoked" | "deleted";
  version: number;
  label: string | null;
  /** Which master key protects it (an id, not a key). Null once the secret has been erased. */
  protectedBy: string | null;
  updatedAt: string;
  updatedBy: string;
}

/**
 * HTTP-style optimistic concurrency, applied when `enforce` is set (the credential routes always set it). Trusted server code and tests
 * leave it off. `ifMatch` is the credential version the caller believes is newest.
 */
export interface WriteOptions {
  enforce?: boolean;
  ifMatch?: number | null;
}
export interface WriteResult {
  outcome: "created" | "replaced" | "unchanged" | "revoked" | "deleted";
  credential: CredentialStatus;
}

const statusOf = (r: Row): CredentialStatus => ({ kind: r.kind, status: r.status, version: r.version, label: r.label, protectedBy: r.key_id, updatedAt: r.updated_at, updatedBy: r.updated_by });
const preconditionRequired = () => new AppError(428, "precondition_required", "An If-Match header with the credential's current version is required");
const credentialChanged = () => new AppError(409, "credential_changed", "The credential changed while this request was being processed; read it again and retry");
const preconditionFailed = () => new AppError(412, "precondition_failed", "The credential has changed since that version; read it again and retry");

const SECRET_FORMAT = /^[\x21-\x7E]{16,4096}$/; // visible ASCII, no spaces, controls or newlines (nothing that could split a header)
const LABEL_FORMAT = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;

interface Row {
  id: string;
  workspace_id: string;
  kind: CredentialKind;
  version: number;
  status: "active" | "revoked" | "deleted";
  label: string | null;
  sealed: Buffer | null;
  wrapped_dek: Buffer | null;
  key_id: string | null;
  updated_at: string;
  updated_by: string;
}

const unavailable = () => new AppError(503, "credentials_unavailable", "Credential storage is not configured on this server");
const unreadable = () => new AppError(500, "credential_unreadable", "The stored credential could not be read");
/** The master key (or key service) needed for this credential is not available: a condition of the deployment, not a fault in the data. Says nothing about which key. */
const keyUnavailable = () => new AppError(503, "credential_key_unavailable", "The key needed to read this credential is not available");

/** Context bound into every ciphertext and every wrapped key: moving either to another workspace, credential or kind breaks it. */
export const secretContext = (r: { id: string; workspace_id: string; kind: string }) => Buffer.from(`ms.cred.v1|ws=${r.workspace_id}|id=${r.id}|kind=${r.kind}`);
export const keyContext = (r: { id: string; workspace_id: string; kind: string }) => Buffer.from(`ms.dek.v1|ws=${r.workspace_id}|id=${r.id}|kind=${r.kind}`);

/** A coarse, secret-free reason for an audit event. */
function reasonOf(e: unknown): "key_unavailable" | "authentication_failed" | "busy" | "provider_error" {
  if (e instanceof KeyUnavailableError) return "key_unavailable";
  if (e instanceof CredentialCryptoError) return "authentication_failed";
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY") ? "busy" : "provider_error";
}

/** Failure paths must stay failures: if the audit write itself cannot happen (database busy), the original outcome still stands. */
function auditQuietly(core: Core, ...args: Parameters<typeof audit> extends [Core, ...infer R] ? R : never): void {
  try {
    audit(core, ...args);
  } catch {
    /* best effort: the read or rotation step that failed is already being reported to the caller */
  }
}

function busyOr(e: unknown): never {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) throw new AppError(503, "busy", "The workspace is being changed by another request; try again");
  throw e;
}

/** The ways a secret can show up inside text: as is, JSON-escaped, URL-encoded, base64 (Basic auth), base64url and hex. */
function secretForms(secret: string): string[] {
  const forms = new Set<string>([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]);
  const raw = Buffer.from(secret, "utf8");
  for (const f of [raw.toString("base64"), raw.toString("base64url"), raw.toString("hex")]) forms.add(f);
  return [...forms].filter((f) => f.length >= 8).sort((a, b) => b.length - a.length); // longest first, so a longer form is not half-replaced
}
const redactText = (s: string, forms: string[]): string => forms.reduce((acc, f) => (acc.includes(f) ? acc.split(f).join("[redacted]") : acc), s);

/**
 * Remove the secret, in every form above, from whatever the caller's own code threw, so it cannot reach a log or a response.
 * Works in place on the thrown object (so its class, `kind`, `code` and other facts survive), walking its own data properties and its
 * `cause` chain to a limited depth. Only matching text is replaced; getters are never invoked; cycles and huge graphs are bounded.
 * If a value holding the secret cannot be changed (a frozen error, say), the original is NOT rethrown: a plain error with the redacted
 * message replaces it. Thrown strings stay strings. Things this cannot see (internal slots such as a Headers object, bytes in a
 * Buffer) are outside its reach: callers must not stash secrets in errors.
 */
function scrub(thrown: unknown, secret: string): unknown {
  const forms = secretForms(secret);
  const seen = new Set<object>();
  let budget = 500;
  let blocked = false;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return redactText(v, forms);
    if (typeof v !== "object" || v === null || ArrayBuffer.isView(v) || seen.has(v) || depth > 5 || budget-- <= 0) return v;
    seen.add(v);
    for (const key of Reflect.ownKeys(v)) {
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d || !("value" in d)) continue; // an accessor: never run it
      const next = walk(d.value, depth + 1);
      if (next === d.value) continue;
      try {
        if (d.writable === false && d.configurable === false) throw new Error("fixed");
        Object.defineProperty(v, key, { ...d, value: next });
      } catch {
        blocked = true;
      }
    }
    return v;
  };
  const out = walk(thrown, 0);
  if (blocked) return new Error(redactText(thrown instanceof Error ? thrown.message : "error", forms) + " [error details withheld: they could not be redacted]");
  return out;
}

/**
 * The credential vault. Encrypted storage for per-workspace integration secrets, and the ONLY code that can decrypt them.
 *
 *  - Writing and reading status need a signed-in person with the right role in THAT workspace (owner to change, admin to see masked status).
 *  - `use` is for server code that needs the secret to call a provider. The secret exists only inside the callback, as a Buffer that is
 *    wiped afterwards. Nothing returns it, logs it, audits it or puts it in an error.
 *  - Keys never touch this database. With no key provider configured, everything that needs one refuses.
 *  - An encrypted credential gives NO right to use any resource: Meta ad-account authorization is decided separately (workspace_meta_accounts).
 */
export class CredentialVault {
  constructor(
    private readonly core: Core,
    private readonly keys: KeyProvider | null,
  ) {}

  get available(): boolean {
    return this.keys !== null;
  }
  get providerName(): string | null {
    return this.keys?.name ?? null;
  }

  private need(authz: AuthzContext, permission: Permission): void {
    if (authz.actor.kind !== "user" || !roleAllows(authz.role, permission)) throw forbidden("forbidden", "Your role does not allow this");
  }

  /** Masked status of every credential kind this workspace has ever stored. Metadata only; works without a key provider. */
  list(authz: AuthzContext): CredentialStatus[] {
    this.need(authz, "credentials.read");
    const rows = this.core.db
      .prepare(
        `SELECT c.* FROM workspace_credentials c
         WHERE c.workspace_id = ? AND c.version = (SELECT MAX(version) FROM workspace_credentials WHERE workspace_id = c.workspace_id AND kind = c.kind)
         ORDER BY c.kind`,
      )
      .all(authz.workspaceId) as Row[];
    return rows.map(statusOf);
  }

  /** The newest row for this workspace and kind, whatever its status. Its version is what `If-Match` is compared with. */
  private latest(workspaceId: string, kind: CredentialKind): Row | undefined {
    return this.core.db.prepare("SELECT * FROM workspace_credentials WHERE workspace_id = ? AND kind = ? ORDER BY version DESC LIMIT 1").get(workspaceId, kind) as Row | undefined;
  }

  /** Is this submitted secret (and label) exactly what is already stored? Decrypts inside the vault; the answer is all that leaves. */
  private async sameAsStored(active: Row, secret: string, label: string | null): Promise<boolean> {
    if ((active.label ?? null) !== label || !this.keys || !active.sealed || !active.wrapped_dek || !active.key_id) return false;
    let dek: Buffer | undefined;
    let stored: Buffer | undefined;
    const given = Buffer.from(secret, "utf8");
    try {
      dek = await this.keys.unwrap(active.key_id, active.wrapped_dek, keyContext(active));
      stored = open(dek, active.sealed, secretContext(active));
      return stored.length === given.length && timingSafeEqual(stored, given);
    } catch (e) {
      auditQuietly(this.core, active.workspace_id, "system", "credential.integrity_failure", "credential", active.id, { kind: active.kind, reason: reasonOf(e) });
      return false; // an unreadable credential is not "the same": the owner must be able to replace it
    } finally {
      wipe(dek, stored, given);
    }
  }

  /**
   * Store a credential, or replace the current one, WITHOUT HTTP-style preconditions: for trusted server code and tests. A replacement
   * revokes (and erases) the previous version in the same transaction, so there is never a moment with two live secrets of one kind.
   * Returns masked status only.
   */
  async store(authz: AuthzContext, input: { kind: CredentialKind; secret: string; label?: string }): Promise<CredentialStatus> {
    return (await this.put(authz, input)).credential;
  }

  /**
   * Create or replace a credential. With `enforce` (what the HTTP route uses) the optimistic-concurrency rules apply:
   *   - `ifMatch`, when given, must equal the newest version of this credential, else 412. With nothing stored yet, any `ifMatch` is stale.
   *   - when a credential is ACTIVE, a request without `ifMatch` is refused with 428 UNLESS it asks for exactly what is already stored
   *     (same secret, same label): then nothing changes and the outcome is "unchanged", which makes a retry after a lost response safe.
   *   - when nothing is active (never stored, revoked or deleted) no `ifMatch` is needed to create.
   *   - if the state changes between the checks and the write, nothing is written and the answer is 409.
   * The comparison, the write and the state check never return or log the secret.
   */
  async put(authz: AuthzContext, input: { kind: CredentialKind; secret: string; label?: string | null }, opts: WriteOptions = {}): Promise<WriteResult> {
    this.need(authz, "credentials.manage");
    if (!this.keys) throw unavailable();
    // Messages below never repeat the input: a mistyped secret must not be echoed into a response or a log.
    if (!isKind(input.kind)) throw new AppError(400, "validation", "Unknown credential kind");
    if (typeof input.secret !== "string" || !SECRET_FORMAT.test(input.secret)) throw new AppError(400, "validation", "The credential must be 16 to 4096 visible characters with no spaces or line breaks");
    const label = input.label === undefined ? null : input.label;
    if (label !== null && (typeof label !== "string" || !LABEL_FORMAT.test(label) || label.includes(input.secret))) throw new AppError(400, "validation", "The label must be 1 to 80 plain characters and must not contain the credential");

    const enforce = opts.enforce === true;
    const ifMatch = opts.ifMatch ?? null;
    const snap = this.latest(authz.workspaceId, input.kind);
    if (enforce) {
      if (ifMatch !== null && (!snap || ifMatch !== snap.version)) throw preconditionFailed();
      // Once ANY version exists (active, revoked or deleted) changing the state needs the version; only the very first creation is free.
      // Otherwise a stale client retrying an old create could silently bring back a credential an owner has since revoked or deleted.
      if (snap && snap.status !== "active" && ifMatch === null) throw preconditionRequired();
      if (snap?.status === "active" && (ifMatch === null || ifMatch === snap.version)) {
        if (await this.sameAsStored(snap, input.secret, label)) {
          // The comparison took time (it may be a remote call). Make sure nothing moved meanwhile, so "unchanged" is never reported for a
          // state that no longer exists. Nothing awaits between this check and the return.
          const again = this.latest(authz.workspaceId, input.kind);
          if (again?.id !== snap.id || again.version !== snap.version || again.status !== snap.status) throw credentialChanged();
          auditQuietly(this.core, authz.workspaceId, authz.actor.label, "credential.unchanged", "credential", snap.id, { kind: input.kind, version: snap.version, operation: "store" });
          return { outcome: "unchanged", credential: statusOf(snap) };
        }
        if (ifMatch === null) throw preconditionRequired();
      }
    }

    const id = newId("crd");
    const row = { id, workspace_id: authz.workspaceId, kind: input.kind };
    const secret = Buffer.from(input.secret, "utf8");
    const dek = newDataKey();
    let sealed: Buffer;
    let wrapped: { keyId: string; wrapped: Buffer };
    try {
      sealed = seal(dek, secret, secretContext(row));
      wrapped = await this.keys.wrap(dek, keyContext(row)); // may be a remote call; no database transaction is open across it
    } finally {
      wipe(dek, secret);
    }
    const at = iso(this.core);
    const actor = authz.actor.label;
    const db = this.core.db;
    let replaced = false;
    const run = db.transaction(() => {
      const now = this.latest(authz.workspaceId, input.kind);
      if (enforce && (now?.id !== snap?.id || now?.version !== snap?.version || now?.status !== snap?.status)) throw credentialChanged();
      const current = now?.status === "active" ? now : undefined;
      if (current) {
        db.prepare("UPDATE workspace_credentials SET status = 'revoked', sealed = NULL, wrapped_dek = NULL, key_id = NULL, ended_at = ?, ended_by = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(at, actor, at, actor, current.id);
        replaced = true;
      }
      const version = (now?.version ?? 0) + 1;
      db.prepare(
        `INSERT INTO workspace_credentials (id, workspace_id, kind, version, status, label, sealed, wrapped_dek, key_id, created_at, created_by, updated_at, updated_by)
         VALUES (?,?,?,?, 'active', ?,?,?,?, ?,?,?,?)`,
      ).run(id, authz.workspaceId, input.kind, version, label, sealed, wrapped.wrapped, wrapped.keyId, at, actor, at, actor);
      audit(this.core, authz.workspaceId, actor, replaced ? "credential.replaced" : "credential.stored", "credential", id, { kind: input.kind, version, previous: current?.id ?? null });
      return version;
    });
    let version: number;
    try {
      version = run.immediate();
    } catch (e) {
      return busyOr(e);
    }
    if (replaced) this.purge();
    return { outcome: replaced ? "replaced" : "created", credential: { kind: input.kind, status: "active", version, label, protectedBy: wrapped.keyId, updatedAt: at, updatedBy: actor } };
  }

  /** Stop using the current credential and erase its secret. It cannot be brought back; store a new one. */
  async revoke(authz: AuthzContext, kind: CredentialKind, opts: WriteOptions = {}): Promise<WriteResult> {
    this.need(authz, "credentials.manage");
    if (!isKind(kind)) throw notFound("Credential");
    return this.end(authz, kind, "revoked", opts);
  }

  /** Revoke, and also forget the label of every version of this kind. A bare tombstone remains for the audit trail. */
  async delete(authz: AuthzContext, kind: CredentialKind, opts: WriteOptions = {}): Promise<WriteResult> {
    this.need(authz, "credentials.manage");
    if (!isKind(kind)) throw notFound("Credential");
    return this.end(authz, kind, "deleted", opts);
  }

  /**
   * Revoke or delete. With `enforce`: `ifMatch` is REQUIRED (428 if absent) and must equal the newest version (412 if not), and a repeat of
   * an operation that already happened, with the same version, succeeds with the outcome "unchanged" (safe to retry). Without `enforce`
   * (trusted server code) the older rules apply: revoking needs an active credential.
   */
  private end(authz: AuthzContext, kind: CredentialKind, to: "revoked" | "deleted", opts: WriteOptions): WriteResult {
    const enforce = opts.enforce === true;
    const ifMatch = opts.ifMatch ?? null;
    const at = iso(this.core);
    const actor = authz.actor.label;
    const db = this.core.db;
    let changed = false;
    const run = db.transaction(() => {
      const rows = db.prepare("SELECT id, status, version FROM workspace_credentials WHERE workspace_id = ? AND kind = ? ORDER BY version").all(authz.workspaceId, kind) as Array<{ id: string; status: string; version: number }>;
      const newest = rows[rows.length - 1];
      if (!newest) throw notFound("Credential");
      const live = rows.find((r) => r.status === "active");
      if (enforce) {
        if (ifMatch === null) throw preconditionRequired();
        if (ifMatch !== newest.version) throw preconditionFailed();
        if (to === "revoked" && newest.status === "deleted") throw notFound("Credential"); // nothing left to revoke
      } else if (to === "revoked" && !live) {
        throw notFound("Credential");
      }
      const alreadyDone = enforce && (newest.status === to || (to === "revoked" && newest.status === "deleted"));
      if (alreadyDone) {
        auditQuietly(this.core, authz.workspaceId, actor, "credential.unchanged", "credential", newest.id, { kind, version: newest.version, operation: to === "revoked" ? "revoke" : "delete" });
        return;
      }
      if (to === "revoked") {
        db.prepare("UPDATE workspace_credentials SET status = 'revoked', sealed = NULL, wrapped_dek = NULL, key_id = NULL, ended_at = ?, ended_by = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(at, actor, at, actor, live!.id);
      } else {
        db.prepare("UPDATE workspace_credentials SET status = 'deleted', sealed = NULL, wrapped_dek = NULL, key_id = NULL, label = NULL, ended_at = COALESCE(ended_at, ?), ended_by = COALESCE(ended_by, ?), updated_at = ?, updated_by = ? WHERE workspace_id = ? AND kind = ?").run(at, actor, at, actor, authz.workspaceId, kind);
      }
      changed = true;
      audit(this.core, authz.workspaceId, actor, to === "revoked" ? "credential.revoked" : "credential.deleted", "credential", live?.id ?? newest.id, { kind, versions: rows.length });
    });
    try {
      run.immediate();
    } catch (e) {
      busyOr(e);
    }
    if (changed) this.purge();
    return { outcome: changed ? to : "unchanged", credential: statusOf(this.latest(authz.workspaceId, kind)!) };
  }

  /**
   * THE decrypt path. Runs `fn` with the secret and returns its result. The Buffer is wiped when `fn` finishes, so `fn` must not keep it.
   * Callers are server-side provider code only; there is no HTTP route to this. A failure to read is audited (no secret, no detail).
   */
  async use<T>(workspaceId: string, kind: CredentialKind, fn: (secret: Buffer) => Promise<T> | T): Promise<T> {
    if (!this.keys) throw unavailable();
    if (!isKind(kind)) throw notFound("Credential");
    const r = this.core.db.prepare("SELECT * FROM workspace_credentials WHERE workspace_id = ? AND kind = ? AND status = 'active'").get(workspaceId, kind) as Row | undefined;
    if (!r || !r.sealed || !r.wrapped_dek || !r.key_id) throw notFound("Credential");
    let dek: Buffer | undefined;
    let secret: Buffer;
    try {
      dek = await this.keys.unwrap(r.key_id, r.wrapped_dek, keyContext(r));
      secret = open(dek, r.sealed, secretContext(r));
    } catch (e) {
      const why = reasonOf(e);
      auditQuietly(this.core, workspaceId, "system", "credential.integrity_failure", "credential", r.id, { kind, reason: why });
      // Only a provider that says the key is UNAVAILABLE (KeyUnavailableError) is a 503. Tampering, a wrong key or context, and any
      // unclassified failure stay the internal 500 so they are never mistaken for an outage.
      throw why === "key_unavailable" ? keyUnavailable() : unreadable();
    } finally {
      wipe(dek);
    }
    // Unwrapping can take a while (it may be a remote call). If the credential was revoked, replaced or deleted in the meantime,
    // do not hand the secret out: revocation takes effect for any call that has not started using it yet.
    if (!this.core.db.prepare("SELECT 1 FROM workspace_credentials WHERE id = ? AND status = 'active'").get(r.id)) {
      wipe(secret);
      throw notFound("Credential");
    }
    const text = secret.toString("utf8"); // only to scrub errors; never stored or returned
    try {
      return await fn(secret);
    } catch (e) {
      throw scrub(e, text);
    } finally {
      wipe(secret);
    }
  }

  /** Active credentials still wrapped by `keyId`. */
  countProtectedBy(keyId: string): number {
    return (this.core.db.prepare("SELECT COUNT(*) n FROM workspace_credentials WHERE status = 'active' AND key_id = ?").get(keyId) as { n: number }).n;
  }

  /** May this master key be removed from the keyring now? Not while it is the active key or any live credential depends on it. */
  canRetire(keyId: string): boolean {
    return this.keys !== null && this.keys.activeKeyId() !== keyId && this.countProtectedBy(keyId) === 0;
  }

  /**
   * Which master keys do live credentials depend on, how many, and does the provider still hold each (null: it cannot say)?
   * Software cannot stop an operator deleting a key from the environment; this is how the server notices it did, at startup.
   */
  keyDependencies(): Array<{ keyId: string; credentials: number; available: boolean | null }> {
    const rows = this.core.db.prepare("SELECT key_id, COUNT(*) n FROM workspace_credentials WHERE status = 'active' GROUP BY key_id ORDER BY key_id").all() as Array<{ key_id: string; n: number }>;
    return rows.map((r) => ({ keyId: r.key_id, credentials: r.n, available: this.keys === null ? false : this.keys.hasKey ? this.keys.hasKey(r.key_id) : null }));
  }

  /**
   * Called after a secret has been erased from a live row. SQLite's write-ahead log still holds the previous page images until it is
   * checkpointed, so ask for that now (best effort: it cannot complete while another connection is reading). Freed pages are
   * overwritten by `secure_delete`. Copies outside this process (backups, disk blocks) are outside our reach.
   */
  private purge(): void {
    try {
      this.core.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      /* not fatal: erasure in the live row already happened inside the transaction */
    }
  }

  /** Which master key new records are wrapped under, or null when no provider is configured. An id, never a key. */
  get activeKeyId(): string | null {
    return this.keys ? this.keys.activeKeyId() : null;
  }
  /** True only when the provider declares itself an approved managed key service. */
  get managedProvider(): boolean | null {
    return this.keys ? this.keys.managed === true : null;
  }

  /**
   * Can every live credential's data key still be unwrapped? Reads each record's wrapped key and asks the provider to unwrap it, then wipes
   * the result. The secret itself is NEVER decrypted, and nothing is written. Failures are counted by a coarse reason, never described.
   */
  async probeKeys(): Promise<{ checked: number; ok: number; failed: number; byReason: Record<string, number>; byKey: Array<{ keyId: string; ok: number; failed: number }> }> {
    if (!this.keys) throw unavailable();
    const rows = this.core.db.prepare("SELECT id FROM workspace_credentials WHERE status = 'active' ORDER BY id").all() as Array<{ id: string }>;
    const out = { checked: 0, ok: 0, failed: 0, byReason: {} as Record<string, number> };
    const perKey = new Map<string, { ok: number; failed: number }>();
    for (const { id } of rows) {
      const r = this.core.db.prepare("SELECT * FROM workspace_credentials WHERE id = ? AND status = 'active'").get(id) as Row | undefined;
      if (!r || !r.wrapped_dek || !r.key_id) continue; // changed meanwhile: nothing to check
      out.checked++;
      const k = perKey.get(r.key_id) ?? { ok: 0, failed: 0 };
      perKey.set(r.key_id, k);
      let dek: Buffer | undefined;
      try {
        dek = await this.keys.unwrap(r.key_id, r.wrapped_dek, keyContext(r));
        out.ok++;
        k.ok++;
      } catch (e) {
        out.failed++;
        k.failed++;
        const why = reasonOf(e);
        out.byReason[why] = (out.byReason[why] ?? 0) + 1;
      } finally {
        wipe(dek);
      }
    }
    return { ...out, byKey: [...perKey.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([keyId, v]) => ({ keyId, ...v })) };
  }

  /**
   * Master-key rotation. Re-wraps every active record's data key under the CURRENT key. Secrets are not re-encrypted or even read.
   * (The original summary-only form; see rewrap() for the full result.)
   */
  async rewrapAll(): Promise<{ rewrapped: number; skipped: number; failed: number }> {
    const r = await this.rewrap();
    return { rewrapped: r.rewrapped, skipped: r.skipped, failed: r.failed };
  }

  /**
   * Re-wrap active records that are not under the active master key. Safe to stop and run again: each record is independent, a record
   * already under the active key is never touched, and one that fails is left exactly as it was.
   *
   * For each record: unwrap, wrap under the active key, then UNWRAP THE NEW WRAPPING AND COMPARE before anything is written, so a faulty
   * provider can never replace a working wrapping with one that cannot be opened. The write is conditional on the record still being
   * active with the same key and wrapped bytes, so a record revoked, replaced or already re-wrapped meanwhile is skipped.
   *
   * `dryRun` does everything except the write (it still asks the provider to wrap and unwrap). `limit` caps how many records are examined
   * in this run. `failures` counts by coarse reason only.
   */
  async rewrap(opts: { dryRun?: boolean; limit?: number } = {}): Promise<{ rewrapped: number; wouldRewrap: number; skipped: number; failed: number; remaining: number; failures: Record<string, number>; dryRun: boolean }> {
    if (!this.keys) throw unavailable();
    const target = this.keys.activeKeyId();
    const db = this.core.db;
    const dryRun = opts.dryRun === true;
    const limit = opts.limit === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.floor(opts.limit));
    const ids = db.prepare("SELECT id FROM workspace_credentials WHERE status = 'active' AND key_id <> ? ORDER BY id").all(target) as Array<{ id: string }>;
    const out = { rewrapped: 0, wouldRewrap: 0, skipped: 0, failed: 0, remaining: 0, failures: {} as Record<string, number>, dryRun };
    let examined = 0;
    for (const { id } of ids) {
      if (examined >= limit) break;
      const r = db.prepare("SELECT * FROM workspace_credentials WHERE id = ? AND status = 'active' AND key_id <> ?").get(id, target) as Row | undefined;
      if (!r || !r.wrapped_dek || !r.key_id) {
        out.skipped++; // revoked, replaced or already re-wrapped since the list was read
        continue;
      }
      examined++;
      let dek: Buffer | undefined;
      let check: Buffer | undefined;
      try {
        dek = await this.keys.unwrap(r.key_id, r.wrapped_dek, keyContext(r));
        const w = await this.keys.wrap(dek, keyContext(r));
        if (w.keyId !== target || !Buffer.isBuffer(w.wrapped) || w.wrapped.length === 0) throw new CredentialCryptoError();
        check = await this.keys.unwrap(w.keyId, w.wrapped, keyContext(r));
        if (check.length !== dek.length || !timingSafeEqual(check, dek)) throw new CredentialCryptoError(); // the new wrapping must open to the same key
        if (dryRun) {
          out.wouldRewrap++;
          continue;
        }
        const changed = db.transaction(() => {
          const res = db.prepare("UPDATE workspace_credentials SET wrapped_dek = ?, key_id = ?, updated_at = ?, updated_by = 'system' WHERE id = ? AND status = 'active' AND key_id = ? AND wrapped_dek = ?").run(w.wrapped, w.keyId, iso(this.core), r.id, r.key_id, r.wrapped_dek);
          if (res.changes === 1) audit(this.core, r.workspace_id, "system", "credential.rewrapped", "credential", r.id, { kind: r.kind, from: r.key_id, to: w.keyId });
          return res.changes;
        }).immediate();
        if (changed === 1) out.rewrapped++;
        else out.skipped++;
      } catch (e) {
        out.failed++;
        const why = reasonOf(e);
        out.failures[why] = (out.failures[why] ?? 0) + 1;
        if (!dryRun) auditQuietly(this.core, r.workspace_id, "system", "credential.rewrap_failed", "credential", r.id, { kind: r.kind, from: r.key_id, reason: why });
      } finally {
        wipe(dek, check);
      }
    }
    out.remaining = (db.prepare("SELECT COUNT(*) n FROM workspace_credentials WHERE status = 'active' AND key_id <> ?").get(target) as { n: number }).n;
    return out;
  }
}
