import { readDeployment } from "../deployment.js";
import { KEY_BYTES, open, seal, wipe } from "./crypto.js";

/**
 * Where the MASTER keys live. The database stores only which key id wrapped a record, never a key.
 *
 * A production deployment should implement this interface over a managed key service (a KMS or HSM) so that master keys never enter
 * this process and every wrap/unwrap is a logged, access-controlled call. Which service is a DEPLOYMENT DECISION that this
 * repository does not make (see docs/credential-security.md). `LocalKeyring` below is a deliberately plain implementation for local
 * development, tests and a single-host pilot; it is NOT a substitute for a managed key service.
 */
export interface KeyProvider {
  /** For logs and status screens: a short non-secret name such as "local_keyring". */
  readonly name: string;
  /**
   * True only for a provider backed by an APPROVED MANAGED key service (a KMS or HSM) whose master keys never enter this process.
   * Production accepts nothing else. Absent or false means "not managed", and production refuses it.
   */
  readonly managed?: boolean;
  /** The key id new records are wrapped under. */
  activeKeyId(): string;
  /** Wrap a 32-byte data key. `context` is authenticated but not secret (workspace, credential, kind). */
  wrap(dataKey: Buffer, context: Buffer): Promise<{ keyId: string; wrapped: Buffer }>;
  /**
   * Does this provider currently hold the master key `keyId`? Optional: a managed key service may not be able to say cheaply.
   * Used only to warn that stored credentials depend on a key that is no longer available.
   */
  hasKey?(keyId: string): boolean;
  /** Unwrap with the master key named by `keyId`. Fails (without detail) if the key is unavailable or the context differs. */
  unwrap(keyId: string, wrapped: Buffer, context: Buffer): Promise<Buffer>;
}

export class KeyUnavailableError extends Error {
  constructor() {
    super("the master key for this credential is not available");
    this.name = "KeyUnavailableError";
  }
}

const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const bind = (context: Buffer, keyId: string): Buffer => Buffer.concat([context, Buffer.from(`|master=${keyId}`)]);

/**
 * Master keys held in this process's memory, loaded from the environment. Keeps keys out of the database and out of source control,
 * but they are visible to anyone who can read the process environment or memory. Supports rotation: several keys can be present,
 * one is active; old ones stay only until every record has been re-wrapped.
 */
export class LocalKeyring implements KeyProvider {
  readonly name = "local_keyring";
  /** Master keys live in this process: never a managed key service. */
  readonly managed = false;
  private readonly keys = new Map<string, Buffer>();

  constructor(keys: ReadonlyMap<string, Buffer> | Record<string, Buffer>, private readonly active: string) {
    const entries = keys instanceof Map ? [...keys.entries()] : Object.entries(keys);
    for (const [id, key] of entries) {
      if (!KEY_ID.test(id)) throw new Error("master key id is not valid");
      if (key.length !== KEY_BYTES) throw new Error("master key must be exactly 32 bytes");
      if (key.every((b: number) => b === key[0])) throw new Error("master key is not random"); // all-zero and other constant keys
      this.keys.set(id, Buffer.from(key));
    }
    if (!this.keys.has(active)) throw new Error("the active master key id is not in the keyring");
  }

  /**
   * CREDENTIAL_KEYRING   = "id:base64key,id2:base64key2"   (each key is 32 random bytes, base64)
   * CREDENTIAL_ACTIVE_KEY = "id"                           (the key new credentials are wrapped under)
   * Unset keyring = credential storage is switched off (returns null). A set but malformed keyring stops startup.
   * Error text names the variables only, never their contents.
   *
   * A keyring in the environment is IGNORED unless BOTH DEPLOYMENT_ENV is development or test AND CREDENTIAL_ALLOW_LOCAL_KEYRING=true.
   * In production it is refused whatever else is set, and an unset or invalid DEPLOYMENT_ENV never enables it. It is a development,
   * test or single-host-pilot choice, not a substitute for a managed key service.
   */
  static fromEnv(env: Record<string, string | undefined>): LocalKeyring | null {
    const raw = env.CREDENTIAL_KEYRING?.trim();
    if (!raw || !LocalKeyring.allowed(env)) return null;
    const keys = new Map<string, Buffer>();
    for (const part of raw.split(",")) {
      const i = part.indexOf(":");
      const id = i < 0 ? "" : part.slice(0, i).trim();
      const b64 = i < 0 ? "" : part.slice(i + 1).trim();
      if (!KEY_ID.test(id) || keys.has(id) || !/^[A-Za-z0-9+/]{43}=$/.test(b64)) throw new Error("Invalid configuration (CREDENTIAL_KEYRING: expected id:base64 entries, unique ids, 32-byte keys)");
      keys.set(id, Buffer.from(b64, "base64"));
    }
    const active = env.CREDENTIAL_ACTIVE_KEY?.trim() ?? "";
    if (!keys.has(active)) throw new Error("Invalid configuration (CREDENTIAL_ACTIVE_KEY: must name a key in CREDENTIAL_KEYRING)");
    try {
      return new LocalKeyring(keys, active);
    } catch {
      throw new Error("Invalid configuration (CREDENTIAL_KEYRING: keys must be 32 random bytes)");
    }
  }

  /**
   * May master keys be read from the environment at all? Only in a deployment KNOWN to be development or test, and only with the explicit
   * opt-in. Production, an unset DEPLOYMENT_ENV and an invalid one all answer no (this never throws; startup rejects an invalid value).
   */
  static allowed(env: Record<string, string | undefined>): boolean {
    const d = readDeployment(env);
    return env.CREDENTIAL_ALLOW_LOCAL_KEYRING === "true" && d.kind === "set" && (d.env === "development" || d.env === "test");
  }

  /** A keyring is present in the environment but was ignored because it was not explicitly allowed (so the operator can be told). */
  static ignored(env: Record<string, string | undefined>): boolean {
    return !!env.CREDENTIAL_KEYRING?.trim() && !LocalKeyring.allowed(env);
  }

  activeKeyId(): string {
    return this.active;
  }

  hasKey(keyId: string): boolean {
    return this.keys.has(keyId);
  }

  /** Key ids present, for operators deciding which old key can be retired. Ids are not secret. */
  keyIds(): string[] {
    return [...this.keys.keys()];
  }

  async wrap(dataKey: Buffer, context: Buffer): Promise<{ keyId: string; wrapped: Buffer }> {
    const master = this.keys.get(this.active)!;
    return { keyId: this.active, wrapped: seal(master, dataKey, bind(context, this.active)) };
  }

  async unwrap(keyId: string, wrapped: Buffer, context: Buffer): Promise<Buffer> {
    const master = this.keys.get(keyId);
    if (!master) throw new KeyUnavailableError();
    return open(master, wrapped, bind(context, keyId));
  }

  /** Wipe master keys from memory (tests, shutdown). */
  close(): void {
    for (const k of this.keys.values()) wipe(k);
    this.keys.clear();
  }
}
