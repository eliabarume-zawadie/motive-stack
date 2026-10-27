/**
 * Milestone 4.3: encrypted per-workspace credential storage. Everything is offline. Keys are random per test run and live only in
 * memory. The "secret" is an obviously fake fixture string. Nothing here reads a real credential or contacts a provider.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { authorizeMetaAccount, isMetaAccountAuthorized } from "../src/app/metaAccounts.js";
import { createWorkspace } from "../src/app/workspaces.js";
import { ROUTE_PERMISSIONS, legacyTokenActor, userActor, type AuthzContext, type Role } from "../src/auth/authz.js";
import { MetaApiError } from "../src/connector/meta/errors.js";
import { CredentialCryptoError, KEY_BYTES, newDataKey, open, seal } from "../src/credentials/crypto.js";
import { KeyUnavailableError, LocalKeyring, type KeyProvider } from "../src/credentials/keys.js";
import { CREDENTIAL_KINDS } from "../src/credentials/vault.js";
import { migrate, openDb, type Db } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";

const SECRET = "FIXTURE-SECRET-VALUE-7f3a9c1e5b2d4f60";
const SECRET2 = "FIXTURE-SECRET-SECOND-91ab34cd56ef7801";
const b64 = (b: Buffer) => b.toString("base64");

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const keyMap = (...ids: string[]) => Object.fromEntries(ids.map((i) => [i, randomBytes(KEY_BYTES)]));
const ring = (keys: Record<string, Buffer>, active: string) => new LocalKeyring(keys, active);

/** A key provider that remembers every data key it was asked to wrap, so a test can prove none of them is stored. */
class SpyKeys implements KeyProvider {
  readonly name = "spy";
  readonly deks: Buffer[] = [];
  constructor(private readonly inner: LocalKeyring) {}
  activeKeyId = () => this.inner.activeKeyId();
  async wrap(dek: Buffer, context: Buffer) {
    this.deks.push(Buffer.from(dek));
    return this.inner.wrap(dek, context);
  }
  unwrap = (keyId: string, wrapped: Buffer, context: Buffer) => this.inner.unwrap(keyId, wrapped, context);
}

function world(keys: KeyProvider | null = ring(keyMap("k1"), "k1"), env: Record<string, string> = {}) {
  const db = openDb(":memory:");
  migrate(db);
  const ctx: AppContext = buildContext({ db, env, backoffMs: () => 0, gateway: { sleep: async () => {} }, keyProvider: keys });
  cleanups.push(() => db.open && db.close());
  const ws = (name = "Acme Plumbing") => createWorkspace(ctx, name);
  const as = (workspaceId: string, role: Role): AuthzContext => ({ workspaceId, role, actor: userActor(`usr_${role}`) });
  return { db, ctx, vault: ctx.credentials, ws, as };
}
const count = (db: Db, sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

/** Every table, every row, every column, as text and hex, so a search covers plaintext and binary forms. */
function dump(db: Db): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((t) => t.name);
  const parts: string[] = [];
  for (const t of tables) {
    for (const row of db.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>) {
      for (const v of Object.values(row)) parts.push(Buffer.isBuffer(v) ? `${v.toString("utf8")}|${v.toString("hex")}|${v.toString("base64")}` : String(v));
    }
  }
  return parts.join("\n");
}

describe("authenticated encryption", () => {
  const key = newDataKey();
  const aad = Buffer.from("ctx");

  it("round-trips, never stores the plaintext, and uses a fresh nonce every time", () => {
    const pt = Buffer.from(SECRET);
    const a = seal(key, pt, aad);
    expect(open(key, a, aad).equals(pt)).toBe(true);
    expect(a.includes(pt)).toBe(false);
    const nonces = new Set(Array.from({ length: 500 }, () => seal(key, pt, aad).subarray(0, 12).toString("hex")));
    expect(nonces.size).toBe(500);
    expect(seal(key, pt, aad).equals(a)).toBe(false);
  });

  it("rejects the wrong key, the wrong context, and any modified byte (nonce, tag or ciphertext), all with one uninformative error", () => {
    const sealed = seal(key, Buffer.from(SECRET), aad);
    const fails = (k: Buffer, s: Buffer, a: Buffer) => {
      try {
        open(k, s, a);
        return "OPENED";
      } catch (e) {
        expect(e).toBeInstanceOf(CredentialCryptoError);
        return (e as Error).message;
      }
    };
    const msg = fails(newDataKey(), sealed, aad);
    expect(msg).not.toBe("OPENED");
    expect(fails(key, sealed, Buffer.from("other"))).toBe(msg);
    for (const i of [0, 5, 11, 12, 20, 27, 28, sealed.length - 1]) {
      const bad = Buffer.from(sealed);
      bad[i] = bad[i]! ^ 0x01;
      expect(fails(key, bad, aad), `byte ${i}`).toBe(msg);
    }
    for (const bad of [Buffer.alloc(0), sealed.subarray(0, 20), sealed.subarray(0, sealed.length - 1), Buffer.concat([sealed, Buffer.from([0])])]) expect(fails(key, bad, aad)).toBe(msg);
    expect(fails(Buffer.alloc(16), sealed, aad)).toBe(msg); // a key of the wrong length
    expect(msg).not.toContain(SECRET);
  });
});

describe("master keys", () => {
  const good = () => b64(randomBytes(32));
  it("loads a keyring from the environment, and storage stays off when none is configured", () => {
    expect(LocalKeyring.fromEnv({})).toBeNull();
    expect(LocalKeyring.fromEnv({ CREDENTIAL_KEYRING: "  " })).toBeNull();
    const r = LocalKeyring.fromEnv({ DEPLOYMENT_ENV: "test", CREDENTIAL_ALLOW_LOCAL_KEYRING: "true", CREDENTIAL_KEYRING: `old:${good()},new-2:${good()}`, CREDENTIAL_ACTIVE_KEY: "new-2" })!;
    expect([r.activeKeyId(), r.keyIds()]).toEqual(["new-2", ["old", "new-2"]]);
  });

  it("refuses anything malformed, naming the variable and never echoing its contents", () => {
    const k = good();
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ CREDENTIAL_KEYRING: `a:${k}` }, /CREDENTIAL_ACTIVE_KEY/], // no active key
      [{ CREDENTIAL_KEYRING: `a:${k}`, CREDENTIAL_ACTIVE_KEY: "b" }, /CREDENTIAL_ACTIVE_KEY/],
      [{ CREDENTIAL_KEYRING: `a:${k},a:${good()}`, CREDENTIAL_ACTIVE_KEY: "a" }, /CREDENTIAL_KEYRING/], // duplicate id
      [{ CREDENTIAL_KEYRING: `A:${k}`, CREDENTIAL_ACTIVE_KEY: "A" }, /CREDENTIAL_KEYRING/], // id not allowed
      [{ CREDENTIAL_KEYRING: `a:${b64(randomBytes(16))}`, CREDENTIAL_ACTIVE_KEY: "a" }, /CREDENTIAL_KEYRING/], // 16 bytes
      [{ CREDENTIAL_KEYRING: `a:${b64(randomBytes(33))}`, CREDENTIAL_ACTIVE_KEY: "a" }, /CREDENTIAL_KEYRING/],
      [{ CREDENTIAL_KEYRING: `a:not-base64!!`, CREDENTIAL_ACTIVE_KEY: "a" }, /CREDENTIAL_KEYRING/],
      [{ CREDENTIAL_KEYRING: `a:${b64(Buffer.alloc(32))}`, CREDENTIAL_ACTIVE_KEY: "a" }, /CREDENTIAL_KEYRING/], // all zero
      [{ CREDENTIAL_KEYRING: `a:${b64(Buffer.alloc(32, 7))}`, CREDENTIAL_ACTIVE_KEY: "a" }, /CREDENTIAL_KEYRING/], // constant
      [{ CREDENTIAL_KEYRING: `just-a-word`, CREDENTIAL_ACTIVE_KEY: "a" }, /CREDENTIAL_KEYRING/],
    ];
    for (const [env, re] of cases) {
      let msg = "";
      try {
        LocalKeyring.fromEnv({ DEPLOYMENT_ENV: "test", CREDENTIAL_ALLOW_LOCAL_KEYRING: "true", ...env });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg, JSON.stringify(env).slice(0, 40)).toMatch(re);
      expect(msg).not.toContain(k);
      expect(msg).not.toContain(env.CREDENTIAL_KEYRING ?? "never");
    }
    expect(() => new LocalKeyring({ a: Buffer.alloc(31, 1) }, "a")).toThrow();
    expect(() => new LocalKeyring({ a: randomBytes(32) }, "missing")).toThrow();
  });

  it("wraps a data key only for the context and key id it was made for", async () => {
    const r = ring(keyMap("k1", "k2"), "k1");
    const dek = newDataKey();
    const ctx = Buffer.from("ms.dek.v1|ws=a|id=b|kind=openai");
    const w = await r.wrap(dek, ctx);
    expect(w.keyId).toBe("k1");
    expect((await r.unwrap("k1", w.wrapped, ctx)).equals(dek)).toBe(true);
    await expect(r.unwrap("k1", w.wrapped, Buffer.from("ms.dek.v1|ws=other|id=b|kind=openai"))).rejects.toBeInstanceOf(CredentialCryptoError);
    await expect(r.unwrap("k2", w.wrapped, ctx)).rejects.toBeInstanceOf(CredentialCryptoError); // another master key
    await expect(r.unwrap("gone", w.wrapped, ctx)).rejects.toBeInstanceOf(KeyUnavailableError);
    r.close();
    await expect(r.unwrap("k1", w.wrapped, ctx)).rejects.toBeInstanceOf(KeyUnavailableError);
  });
});

describe("storing and using a credential", () => {
  it("keeps the secret and every data key out of the database, and out of what the status shows", async () => {
    const spy = new SpyKeys(ring(keyMap("k1"), "k1"));
    const w = world(spy);
    const { workspace } = w.ws();
    const status = await w.vault.store(w.as(workspace.id, "owner"), { kind: "openai", secret: SECRET, label: "Production key" });
    expect(status).toEqual({ kind: "openai", status: "active", version: 1, label: "Production key", protectedBy: "k1", updatedAt: expect.any(String), updatedBy: "user:usr_owner" });
    const text = dump(w.db);
    for (const needle of [SECRET, b64(Buffer.from(SECRET)), Buffer.from(SECRET).toString("hex"), SECRET.slice(0, -4)]) expect(text, needle).not.toContain(needle);
    expect(spy.deks).toHaveLength(1);
    for (const dek of spy.deks) for (const form of [dek.toString("hex"), dek.toString("base64")]) expect(text).not.toContain(form);
    expect(JSON.stringify(w.vault.list(w.as(workspace.id, "admin")))).not.toContain(SECRET);
  });

  it("hands the secret to the caller's function only, then wipes it", async () => {
    const w = world();
    const { workspace } = w.ws();
    await w.vault.store(w.as(workspace.id, "owner"), { kind: "anthropic", secret: SECRET });
    let kept: Buffer | undefined;
    const out = await w.vault.use(workspace.id, "anthropic", (s) => {
      kept = s;
      expect(s.toString("utf8")).toBe(SECRET);
      return s.length;
    });
    expect(out).toBe(SECRET.length);
    expect(kept!.every((b) => b === 0)).toBe(true);
    await expect(w.vault.use(workspace.id, "openai", () => 1)).rejects.toMatchObject({ status: 404 }); // nothing stored for that kind
  });

  it("scrubs the secret from errors thrown by the code that uses it, keeping the error's type", async () => {
    const w = world();
    const { workspace } = w.ws();
    await w.vault.store(w.as(workspace.id, "owner"), { kind: "meta_graph", secret: SECRET });
    const thrown = await w.vault.use(workspace.id, "meta_graph", () => { throw new MetaApiError("permission", `rejected token ${SECRET}`); }).catch((e) => e as MetaApiError);
    expect(thrown).toBeInstanceOf(MetaApiError);
    expect(thrown.kind).toBe("permission");
    expect(thrown.message).toBe("rejected token [redacted]");
    expect(String(thrown.stack)).not.toContain(SECRET);
    const plain = await w.vault.use(workspace.id, "meta_graph", () => { throw `raw ${SECRET}`; }).catch((e) => e);
    expect(plain).toBe("raw [redacted]"); // a thrown string stays a string
  });

  it("refuses badly formed secrets, labels and kinds without repeating them", async () => {
    const w = world();
    const { workspace } = w.ws();
    const owner = w.as(workspace.id, "owner");
    const bad: Array<[string, unknown, unknown]> = [
      ["has space", { kind: "openai", secret: "FIXTURE SECRET WITH SPACES 1234" }, "FIXTURE SECRET WITH SPACES"],
      ["newline", { kind: "openai", secret: `${SECRET}\nX-Injected: 1` }, "X-Injected"],
      ["too short", { kind: "openai", secret: "short" }, "short"],
      ["too long", { kind: "openai", secret: "A".repeat(4097) }, "AAAAAAAAAAAAAAAA"],
      ["non-ascii", { kind: "openai", secret: `${SECRET}é` }, SECRET],
      ["not a string", { kind: "openai", secret: 12345678901234567890 }, "1234567890"],
      ["unknown kind", { kind: "stripe", secret: SECRET }, SECRET],
      ["label holds the secret", { kind: "openai", secret: SECRET, label: `key ${SECRET}` }, SECRET],
      ["label too long", { kind: "openai", secret: SECRET, label: "x".repeat(81) }, SECRET],
      ["label control chars", { kind: "openai", secret: SECRET, label: "a\nb" }, SECRET],
    ];
    for (const [name, input, mustNotEcho] of bad) {
      const err = (await w.vault.store(owner, input as never).catch((e) => e)) as { status: number; message: string };
      expect(err.status, name).toBe(400);
      expect(err.message, name).not.toContain(String(mustNotEcho));
    }
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials")).toBe(0);
  });
});

describe("who may touch credentials", () => {
  it("only an owner stores, replaces, revokes or deletes; only admins and owners see masked status; the legacy token sees nothing", async () => {
    const w = world();
    const { workspace } = w.ws();
    const id = workspace.id;
    await w.vault.store(w.as(id, "owner"), { kind: "openai", secret: SECRET });
    for (const role of ["viewer", "operator", "admin"] as Role[]) {
      await expect(w.vault.store(w.as(id, role), { kind: "openai", secret: SECRET2 }), role).rejects.toMatchObject({ status: 403 });
      await expect(w.vault.revoke(w.as(id, role), "openai"), role).rejects.toMatchObject({ status: 403 });
      await expect(w.vault.delete(w.as(id, role), "openai"), role).rejects.toMatchObject({ status: 403 });
    }
    expect(() => w.vault.list(w.as(id, "viewer"))).toThrow(/role/);
    expect(() => w.vault.list(w.as(id, "operator"))).toThrow(/role/);
    expect(w.vault.list(w.as(id, "admin"))).toHaveLength(1);
    const token: AuthzContext = { workspaceId: id, role: "admin", actor: legacyTokenActor(id) };
    expect(() => w.vault.list(token)).toThrow(/role/);
    await expect(w.vault.store(token, { kind: "ghl", secret: SECRET2 })).rejects.toMatchObject({ status: 403 });
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials WHERE status = 'active'")).toBe(1);
    await w.vault.use(id, "openai", (s) => expect(s.toString()).toBe(SECRET)); // unchanged by all the refusals
  });

  it("keeps workspaces apart: status, revocation, deletion and use never cross a tenant boundary", async () => {
    const w = world();
    const a = w.ws("Alpha Co").workspace.id;
    const b = w.ws("Bravo Co").workspace.id;
    await w.vault.store(w.as(a, "owner"), { kind: "openai", secret: SECRET, label: "alpha" });
    await w.vault.store(w.as(b, "owner"), { kind: "openai", secret: SECRET2, label: "bravo" });
    expect(w.vault.list(w.as(b, "owner")).map((s) => s.label)).toEqual(["bravo"]);
    await w.vault.use(b, "openai", (s) => expect(s.toString()).toBe(SECRET2));
    await w.vault.revoke(w.as(b, "owner"), "openai");
    await w.vault.use(a, "openai", (s) => expect(s.toString()).toBe(SECRET)); // Alpha untouched
    await expect(w.vault.revoke(w.as(b, "owner"), "openai")).rejects.toMatchObject({ status: 404 }); // Bravo has nothing active now
    await expect(w.vault.use(b, "openai", () => 1)).rejects.toMatchObject({ status: 404 });
    // an owner of B can never name A's credential: the workspace comes from the authorization, not from the arguments
    await w.vault.store(w.as(b, "owner"), { kind: "ghl", secret: SECRET2 });
    expect(w.vault.list(w.as(b, "owner")).map((s) => s.kind).sort()).toEqual(["ghl", "openai"]);
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials WHERE workspace_id = ? AND status = 'active'", a)).toBe(1);
  });

  it("a ciphertext moved to another workspace or kind (by someone with database access) does not decrypt, and the failure is audited", async () => {
    const w = world();
    const a = w.ws("Alpha Co").workspace.id;
    const b = w.ws("Bravo Co").workspace.id;
    await w.vault.store(w.as(a, "owner"), { kind: "openai", secret: SECRET });
    await w.vault.store(w.as(b, "owner"), { kind: "openai", secret: SECRET2 });
    await w.vault.store(w.as(a, "owner"), { kind: "anthropic", secret: SECRET2 });
    const row = (ws: string, kind: string) => w.db.prepare("SELECT sealed, wrapped_dek, key_id FROM workspace_credentials WHERE workspace_id = ? AND kind = ? AND status = 'active'").get(ws, kind) as { sealed: Buffer; wrapped_dek: Buffer; key_id: string };
    const put = (ws: string, kind: string, r: { sealed: Buffer; wrapped_dek: Buffer; key_id: string }) => w.db.prepare("UPDATE workspace_credentials SET sealed = ?, wrapped_dek = ?, key_id = ? WHERE workspace_id = ? AND kind = ? AND status = 'active'").run(r.sealed, r.wrapped_dek, r.key_id, ws, kind);
    const alpha = row(a, "openai");
    put(b, "openai", alpha); // Alpha's whole record into Bravo's row
    await expect(w.vault.use(b, "openai", () => "read")).rejects.toMatchObject({ status: 500, code: "credential_unreadable" });
    put(a, "anthropic", alpha); // same workspace, different kind
    await expect(w.vault.use(a, "anthropic", () => "read")).rejects.toMatchObject({ code: "credential_unreadable" });
    await w.vault.use(a, "openai", (s) => expect(s.toString()).toBe(SECRET)); // the original is fine
    const ev = w.db.prepare("SELECT workspace_id, actor, detail FROM audit_events WHERE type = 'credential.integrity_failure' ORDER BY id").all() as Array<{ workspace_id: string; actor: string; detail: string }>;
    expect(ev.map((e) => [e.workspace_id, e.actor, JSON.parse(e.detail).reason])).toEqual([[b, "system", "authentication_failed"], [a, "system", "authentication_failed"]]);
  });

  it("tampering with the stored bytes is detected, not decrypted into garbage", async () => {
    const w = world();
    const { workspace } = w.ws();
    await w.vault.store(w.as(workspace.id, "owner"), { kind: "openai", secret: SECRET });
    const r = w.db.prepare("SELECT sealed, wrapped_dek FROM workspace_credentials").get() as { sealed: Buffer; wrapped_dek: Buffer };
    for (const col of ["sealed", "wrapped_dek"] as const) {
      const bad = Buffer.from(r[col]);
      bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
      w.db.prepare(`UPDATE workspace_credentials SET ${col} = ?`).run(bad);
      const err = (await w.vault.use(workspace.id, "openai", () => "read").catch((e) => e)) as Error;
      expect(err.message, col).toBe("The stored credential could not be read");
      w.db.prepare(`UPDATE workspace_credentials SET ${col} = ?`).run(r[col]); // restore
    }
    await w.vault.use(workspace.id, "openai", (s) => expect(s.toString()).toBe(SECRET));
  });
});

/** Copy every row of the given tables between two databases (simulates a second process opening the same storage with different keys). */
function copyInto(src: Db, dst: Db, tables = ["workspaces", "workspace_credentials"]) {
  for (const t of tables) {
    for (const row of src.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>) {
      const cols = Object.keys(row);
      dst.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...Object.values(row));
    }
  }
}

describe("bindings that hold even when someone edits the database", () => {
  it("a record re-homed to another workspace or kind under the SAME id still does not open", async () => {
    const w = world();
    const a = w.ws("Alpha Co").workspace.id;
    const b = w.ws("Bravo Co").workspace.id;
    await w.vault.store(w.as(a, "owner"), { kind: "openai", secret: SECRET });
    const row = w.db.prepare("SELECT * FROM workspace_credentials").get() as Record<string, unknown>;
    const rehome = (over: Record<string, unknown>) => {
      w.db.prepare("DELETE FROM workspace_credentials WHERE id = ?").run(row.id);
      const moved = { ...row, ...over };
      w.db.prepare(`INSERT INTO workspace_credentials (${Object.keys(moved).join(",")}) VALUES (${Object.keys(moved).map(() => "?").join(",")})`).run(...Object.values(moved));
    };
    rehome({ workspace_id: b });
    await expect(w.vault.use(b, "openai", () => 1)).rejects.toMatchObject({ code: "credential_unreadable" });
    rehome({ workspace_id: a, kind: "anthropic" });
    await expect(w.vault.use(a, "anthropic", () => 1)).rejects.toMatchObject({ code: "credential_unreadable" });
    rehome({ workspace_id: a, kind: "openai" }); // put it back exactly as it was
    await w.vault.use(a, "openai", (s) => expect(s.toString()).toBe(SECRET));
  });

  it("a wrapped data key is tied to the master key id it was wrapped under, not just to the key bytes", async () => {
    const same = randomBytes(KEY_BYTES);
    const r = ring({ a: same, b: Buffer.from(same) }, "a");
    const context = Buffer.from("ms.dek.v1|ws=w|id=c|kind=openai");
    const w = await r.wrap(newDataKey(), context);
    await expect(r.unwrap("b", w.wrapped, context)).rejects.toBeInstanceOf(CredentialCryptoError);
    await expect(r.unwrap("a", w.wrapped, context)).resolves.toHaveLength(KEY_BYTES);
  });

  it("a record revoked or replaced while it is being re-wrapped is left alone", async () => {
    const keys = keyMap("k1", "k2");
    const before = world(ring({ k1: keys.k1! }, "k1"));
    const { workspace } = before.ws();
    await before.vault.store(before.as(workspace.id, "owner"), { kind: "openai", secret: SECRET });
    const inner = ring(keys, "k2");
    let during: (() => void) | null = null;
    const provider: KeyProvider = { name: "hook", activeKeyId: () => inner.activeKeyId(), wrap: async (d, c) => (during?.(), inner.wrap(d, c)), unwrap: (k, w, c) => inner.unwrap(k, w, c) };
    const after = world(provider);
    copyInto(before.db, after.db);
    during = () => void after.db.prepare("UPDATE workspace_credentials SET status = 'revoked', sealed = NULL, wrapped_dek = NULL, key_id = NULL").run();
    expect(await after.vault.rewrapAll()).toEqual({ rewrapped: 0, skipped: 1, failed: 0 });
    expect(after.db.prepare("SELECT status, key_id FROM workspace_credentials").all()).toEqual([{ status: "revoked", key_id: null }]);
    expect(count(after.db, "SELECT COUNT(*) n FROM audit_events WHERE type = 'credential.rewrapped'")).toBe(0);
  });
});

describe("credential lifecycle: replace, revoke, delete", () => {
  it("replacing revokes and erases the old version in the same step; the old secret is gone for good", async () => {
    const w = world();
    const { workspace } = w.ws();
    const owner = w.as(workspace.id, "owner");
    await w.vault.store(owner, { kind: "openai", secret: SECRET, label: "first" });
    const second = await w.vault.store(owner, { kind: "openai", secret: SECRET2, label: "second" });
    expect(second.version).toBe(2);
    expect(second).not.toHaveProperty("last4"); // no fragment of a secret is kept at all
    await w.vault.use(workspace.id, "openai", (s) => expect(s.toString()).toBe(SECRET2));
    expect(w.db.prepare("SELECT version, status, sealed IS NULL s, wrapped_dek IS NULL w, key_id IS NULL k FROM workspace_credentials ORDER BY version").all()).toEqual([
      { version: 1, status: "revoked", s: 1, w: 1, k: 1 },
      { version: 2, status: "active", s: 0, w: 0, k: 0 },
    ]);
    expect(dump(w.db)).not.toContain(SECRET);
    expect(w.vault.list(owner)).toMatchObject([{ kind: "openai", version: 2, status: "active" }]);
    const types = (w.db.prepare("SELECT type FROM audit_events WHERE type LIKE 'credential.%' ORDER BY id").all() as Array<{ type: string }>).map((e) => e.type);
    expect(types).toEqual(["credential.stored", "credential.replaced"]);
  });

  it("two simultaneous stores leave exactly one live credential", async () => {
    const w = world();
    const { workspace } = w.ws();
    const owner = w.as(workspace.id, "owner");
    await Promise.all([w.vault.store(owner, { kind: "openai", secret: SECRET }), w.vault.store(owner, { kind: "openai", secret: SECRET2 })]);
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials WHERE status = 'active'")).toBe(1);
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials")).toBe(2);
  });

  it("revoking erases the secret at once, cannot be undone, and use fails closed", async () => {
    const w = world();
    const { workspace } = w.ws();
    const owner = w.as(workspace.id, "owner");
    await w.vault.store(owner, { kind: "ghl", secret: SECRET, label: "crm" });
    await w.vault.revoke(owner, "ghl");
    await expect(w.vault.use(workspace.id, "ghl", () => "never")).rejects.toMatchObject({ status: 404 });
    expect(w.vault.list(owner)).toMatchObject([{ kind: "ghl", status: "revoked", protectedBy: null, label: "crm" }]);
    expect(dump(w.db)).not.toContain(SECRET);
    expect(() => w.db.prepare("UPDATE workspace_credentials SET status = 'active'").run()).toThrow(/cannot be reactivated|CHECK/);
    await expect(w.vault.revoke(owner, "ghl")).rejects.toMatchObject({ status: 404 });
    const again = await w.vault.store(owner, { kind: "ghl", secret: SECRET2 }); // the way back is a new credential
    expect(again.version).toBe(2);
  });

  it("deleting also forgets the label and hint of every version, leaving a bare tombstone", async () => {
    const w = world();
    const { workspace } = w.ws();
    const owner = w.as(workspace.id, "owner");
    await w.vault.store(owner, { kind: "openai", secret: SECRET, label: "alpha" });
    await w.vault.store(owner, { kind: "openai", secret: SECRET2, label: "beta" });
    await w.vault.delete(owner, "openai");
    expect(w.db.prepare("SELECT status, label, sealed IS NULL s, wrapped_dek IS NULL w FROM workspace_credentials ORDER BY version").all()).toEqual([
      { status: "deleted", label: null, s: 1, w: 1 }, { status: "deleted", label: null, s: 1, w: 1 },
    ]);
    expect(w.vault.list(owner)).toMatchObject([{ kind: "openai", status: "deleted", label: null }]);
    await expect(w.vault.delete(owner, "anthropic")).rejects.toMatchObject({ status: 404 });
    expect(dump(w.db)).not.toMatch(/alpha|beta|FIXTURE-SECRET/);
    expect((await w.vault.store(owner, { kind: "openai", secret: SECRET })).version).toBe(3);
  });

  it("audits every change with the real actor and no secret, label or hint", async () => {
    const w = world();
    const { workspace } = w.ws();
    const owner = w.as(workspace.id, "owner");
    await w.vault.store(owner, { kind: "openai", secret: SECRET, label: "alpha key" });
    await w.vault.store(owner, { kind: "openai", secret: SECRET2 });
    await w.vault.revoke(owner, "openai");
    await w.vault.store(owner, { kind: "ghl", secret: SECRET });
    await w.vault.delete(owner, "ghl");
    const ev = w.db.prepare("SELECT type, actor, workspace_id, detail FROM audit_events WHERE type LIKE 'credential.%' ORDER BY id").all() as Array<Record<string, string>>;
    expect(ev.map((e) => e.type)).toEqual(["credential.stored", "credential.replaced", "credential.revoked", "credential.stored", "credential.deleted"]);
    for (const e of ev) expect([e.actor, e.workspace_id]).toEqual(["user:usr_owner", workspace.id]);
    const all = JSON.stringify(ev);
    for (const needle of [SECRET, SECRET2, SECRET.slice(-4), SECRET2.slice(-4), "alpha key"]) expect(all).not.toContain(needle);
  });
});

describe("master-key rotation", () => {
  it("re-wraps data keys under the new key without touching the secrets, and the old key can then be retired", async () => {
    const keys = keyMap("k1", "k2");
    const w = world(ring({ k1: keys.k1! }, "k1"));
    const a = w.ws("Alpha Co").workspace.id;
    const b = w.ws("Bravo Co").workspace.id;
    await w.vault.store(w.as(a, "owner"), { kind: "openai", secret: SECRET });
    await w.vault.store(w.as(b, "owner"), { kind: "meta_graph", secret: SECRET2 });
    const sealedBefore = (w.db.prepare("SELECT sealed FROM workspace_credentials ORDER BY id").all() as Array<{ sealed: Buffer }>).map((r) => r.sealed.toString("hex"));

    // the operator adds k2 and makes it active
    const rotated = world(ring(keys, "k2"));
    // same database, new key provider: move the data over by reusing the rows
    for (const t of ["workspaces", "workspace_credentials"]) {
      for (const row of w.db.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>) {
        const cols = Object.keys(row);
        rotated.db.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...Object.values(row));
      }
    }
    expect(rotated.vault.countProtectedBy("k1")).toBe(2);
    expect(await rotated.vault.rewrapAll()).toEqual({ rewrapped: 2, skipped: 0, failed: 0 });
    expect([rotated.vault.countProtectedBy("k1"), rotated.vault.countProtectedBy("k2")]).toEqual([0, 2]);
    expect((rotated.db.prepare("SELECT sealed FROM workspace_credentials ORDER BY id").all() as Array<{ sealed: Buffer }>).map((r) => r.sealed.toString("hex"))).toEqual(sealedBefore);
    await rotated.vault.use(a, "openai", (s) => expect(s.toString()).toBe(SECRET));
    expect(await rotated.vault.rewrapAll()).toEqual({ rewrapped: 0, skipped: 0, failed: 0 }); // idempotent

    // with k1 retired entirely, everything still opens
    const retired = world(ring({ k2: keys.k2! }, "k2"));
    for (const row of rotated.db.prepare("SELECT * FROM workspaces").all() as Array<Record<string, unknown>>) retired.db.prepare(`INSERT INTO workspaces (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    for (const row of rotated.db.prepare("SELECT * FROM workspace_credentials").all() as Array<Record<string, unknown>>) retired.db.prepare(`INSERT INTO workspace_credentials (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    await retired.vault.use(b, "meta_graph", (s) => expect(s.toString()).toBe(SECRET2));
    const ev = rotated.db.prepare("SELECT type, detail FROM audit_events WHERE type = 'credential.rewrapped'").all() as Array<{ type: string; detail: string }>;
    expect(ev).toHaveLength(2);
    expect(JSON.stringify(ev)).not.toMatch(/FIXTURE/);
  });

  it("a retired key that still protects a record makes that record unreadable (and says so in the audit), never wrong", async () => {
    const keys = keyMap("k1", "k2");
    const w = world(ring({ k1: keys.k1! }, "k1"));
    const { workspace } = w.ws();
    await w.vault.store(w.as(workspace.id, "owner"), { kind: "openai", secret: SECRET });
    const orphan = world(ring({ k2: keys.k2! }, "k2"));
    for (const t of ["workspaces", "workspace_credentials"]) for (const row of w.db.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>) orphan.db.prepare(`INSERT INTO ${t} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    await expect(orphan.vault.use(workspace.id, "openai", () => 1)).rejects.toMatchObject({ status: 503, code: "credential_key_unavailable" }); // an unavailable key is an outage (503), not an internal fault
    expect(await orphan.vault.rewrapAll()).toEqual({ rewrapped: 0, skipped: 0, failed: 1 });
    const reasons = (orphan.db.prepare("SELECT type, detail FROM audit_events WHERE type IN ('credential.integrity_failure','credential.rewrap_failed') ORDER BY id").all() as Array<{ type: string; detail: string }>).map((e) => [e.type, JSON.parse(e.detail).reason]);
    expect(reasons).toEqual([["credential.integrity_failure", "key_unavailable"], ["credential.rewrap_failed", "key_unavailable"]]);
    expect(count(orphan.db, "SELECT COUNT(*) n FROM workspace_credentials WHERE status = 'active'")).toBe(1); // left as it was
  });

  it("the same key id with different key bytes fails authentication instead of returning anything", async () => {
    const w = world(ring(keyMap("k1"), "k1"));
    const { workspace } = w.ws();
    await w.vault.store(w.as(workspace.id, "owner"), { kind: "openai", secret: SECRET });
    const imposter = world(ring(keyMap("k1"), "k1")); // another process with a different "k1"
    for (const t of ["workspaces", "workspace_credentials"]) for (const row of w.db.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>) imposter.db.prepare(`INSERT INTO ${t} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    await expect(imposter.vault.use(workspace.id, "openai", () => 1)).rejects.toMatchObject({ code: "credential_unreadable" });
    expect((imposter.db.prepare("SELECT detail FROM audit_events WHERE type = 'credential.integrity_failure'").get() as { detail: string }).detail).toContain("authentication_failed");
  });
});

describe("with no key provider configured", () => {
  it("nothing is stored or read, status shows nothing, and the answer is a clear 503", async () => {
    const w = world(null);
    const { workspace } = w.ws();
    expect(w.vault.available).toBe(false);
    await expect(w.vault.store(w.as(workspace.id, "owner"), { kind: "openai", secret: SECRET })).rejects.toMatchObject({ status: 503, code: "credentials_unavailable" });
    await expect(w.vault.use(workspace.id, "openai", () => 1)).rejects.toMatchObject({ status: 503 });
    await expect(w.vault.rewrapAll()).rejects.toMatchObject({ status: 503 });
    expect(w.vault.list(w.as(workspace.id, "owner"))).toEqual([]);
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials")).toBe(0);
  });

  it("is off by default in a normal context, because no keyring is set in the environment", () => {
    const db = openDb(":memory:");
    migrate(db);
    cleanups.push(() => db.open && db.close());
    expect(buildContext({ db, env: {} }).credentials.available).toBe(false);
    const keyring = { CREDENTIAL_KEYRING: `k1:${b64(randomBytes(32))}`, CREDENTIAL_ACTIVE_KEY: "k1" };
    // master keys in the environment are ignored unless the operator explicitly allows them (the repo cannot tell production from development)
    expect(buildContext({ db, env: keyring }).credentials.available).toBe(false);
    expect(buildContext({ db, env: { ...keyring, CREDENTIAL_ALLOW_LOCAL_KEYRING: "yes" } }).credentials.available).toBe(false); // only the exact word "true"
    const on = buildContext({ db, env: { ...keyring, DEPLOYMENT_ENV: "test", CREDENTIAL_ALLOW_LOCAL_KEYRING: "true" } }).credentials;
    expect([on.available, on.providerName]).toEqual([true, "local_keyring"]);
    expect([LocalKeyring.ignored(keyring), LocalKeyring.ignored({ ...keyring, DEPLOYMENT_ENV: "test", CREDENTIAL_ALLOW_LOCAL_KEYRING: "true" }), LocalKeyring.ignored({})]).toEqual([true, false, false]);
  });
});

describe("no leakage through the existing API, and no route that writes or reveals", () => {
  it("a stored secret appears in no response from any workspace route, the config, or the audit trail", async () => {
    const w = world();
    const { workspace, token } = w.ws();
    await w.vault.store(w.as(workspace.id, "owner"), { kind: "openai", secret: SECRET, label: "alpha key" });
    await w.vault.store(w.as(workspace.id, "owner"), { kind: "meta_graph", secret: SECRET2 });
    const app = buildServer(w.ctx);
    const gets = Object.keys(ROUTE_PERMISSIONS).filter((k) => k.startsWith("GET ")).map((k) => k.slice(4).replace(":wid", workspace.id).replace(/:[a-z]+/g, "x_1"));
    expect(gets.length).toBeGreaterThan(10);
    const seen: string[] = [];
    for (const url of [...gets, "/api/config", "/api/health"]) {
      const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
      seen.push(res.body);
    }
    const all = seen.join("\n");
    for (const needle of [SECRET, SECRET2, SECRET.slice(-4), "alpha key", "sealed", "wrapped_dek"]) expect(all, needle).not.toContain(needle);
    // and the activity feed does carry the (secret-free) audit events
    const activity = (await app.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/activity`, headers: { authorization: `Bearer ${token}` } })).body;
    expect(activity).toContain("credential.stored");
    // M4.4b: the credential routes are the masked status list and the owner-only create/replace, revoke and delete; none returns a secret
    await app.ready();
    const routes = app.routeTable.filter((r) => /credential|secret|vault|key/i.test(r.url));
    expect([...new Set(routes.map((r) => `${r.method === "HEAD" ? "GET" : r.method} ${r.url}`))].sort()).toEqual(["DELETE /api/workspaces/:wid/credentials/:kind", "GET /api/workspaces/:wid/credentials", "POST /api/workspaces/:wid/credentials/:kind/revoke", "PUT /api/workspaces/:wid/credentials/:kind"]);
    expect(Object.keys(ROUTE_PERMISSIONS).filter((k) => /credential/i.test(k)).sort()).toEqual(["DELETE /api/workspaces/:wid/credentials/:kind", "GET /api/workspaces/:wid/credentials", "POST /api/workspaces/:wid/credentials/:kind/revoke", "PUT /api/workspaces/:wid/credentials/:kind"]);
  });

  it("decryption lives in one module, and only the vault knows how to call it", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk("src");
    const read = (f: string) => readFileSync(f, "utf8");
    const using = (re: RegExp) => files.filter((f) => re.test(read(f))).map((f) => f.replace(/\\/g, "/")).sort();
    expect(using(/createDecipheriv|createCipheriv/)).toEqual(["src/credentials/crypto.ts"]);
    expect(using(/from "\.\.?\/(?:\.\.\/)?credentials\/crypto\.js"|from "\.\/crypto\.js"/)).toEqual(["src/credentials/keys.ts", "src/credentials/vault.ts"]);
    expect(using(/\.unwrap\(/)).toEqual(["src/credentials/vault.ts"]);
    expect(using(/env\.CREDENTIAL_(KEYRING|ACTIVE_KEY|ALLOW_LOCAL_KEYRING)|env\["CREDENTIAL_/).filter((f) => !f.startsWith("src/credentials/"))).toEqual([]);
    // nothing outside the vault itself calls the decrypt path yet: no consumer was wired in this milestone
    expect(using(/credentials\.use\(|vault\.use\(/)).toEqual([]);
  });
});

describe("a stored credential grants no authority over anything", () => {
  it("storing a Meta credential authorizes no ad account, reaches no connector, and authorizing an account stores no credential", async () => {
    const calls: string[] = [];
    const inner: any = new Proxy({}, { get: (_t, m) => async () => (calls.push(String(m)), []) });
    const db = openDb(":memory:");
    migrate(db);
    const ctx = buildContext({
      db,
      env: { INTEGRATION_MODE: "live", LIVE_META: "true", META_ACCESS_TOKEN: "FIXTURE-TOKEN-NOT-A-SECRET", META_WRITE_ALLOWLIST: "act_111" },
      keyProvider: ring(keyMap("k1"), "k1"),
      metaConnector: () => inner,
    });
    cleanups.push(() => db.open && db.close());
    const { workspace } = createWorkspace(ctx, "Acme Plumbing");
    const owner: AuthzContext = { workspaceId: workspace.id, role: "owner", actor: userActor("usr_owner") };
    for (const kind of CREDENTIAL_KINDS) await ctx.credentials.store(owner, { kind, secret: `${SECRET}-${kind}` });
    db.prepare("UPDATE workspaces SET meta_account_id = 'act_111' WHERE id = ?").run(workspace.id);
    expect(isMetaAccountAuthorized(ctx, workspace.id, "act_111")).toBe(false);
    const handle = ctx.metaFor(workspace.id);
    expect([handle.accountId, handle.mode]).toEqual([null, "live"]);
    await expect(handle.connector.listCampaigns("act_111")).rejects.toMatchObject({ kind: "permission" });
    await ctx.credentials.use(workspace.id, "meta_graph", () => "using it");
    expect(calls).toEqual([]); // not one call reached the platform
    expect(count(db, "SELECT COUNT(*) n FROM workspace_meta_accounts")).toBe(0);
    // and the other direction
    const before = db.prepare("SELECT id, status, version FROM workspace_credentials ORDER BY id").all();
    authorizeMetaAccount(ctx, owner.actor, workspace.id, "act_111");
    expect(isMetaAccountAuthorized(ctx, workspace.id, "act_111")).toBe(true);
    expect(db.prepare("SELECT id, status, version FROM workspace_credentials ORDER BY id").all()).toEqual(before);
    expect(calls).toEqual([]);
  });
});

describe("migration 007", () => {
  function oldDb() {
    const db = openDb(":memory:");
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const f of ["001_init.sql", "002_ai.sql", "003_generation_identity.sql", "004_users.sql", "005_memberships.sql", "006_meta_accounts.sql"]) {
      db.exec(readFileSync(`src/db/migrations/${f}`, "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES (?, 'then')").run(f);
    }
    return db;
  }

  it("is additive: existing data is untouched, nothing is imported, and no column can hold a plaintext secret", () => {
    const db = oldDb();
    db.prepare("INSERT INTO workspaces (id, name, token_hash, meta_account_id, created_at) VALUES ('ws_old','Old Co','h','act_111','t')").run();
    const before = db.prepare("SELECT * FROM workspaces").all();
    expect(migrate(db)).toEqual(["007_credentials.sql", "008_drop_credential_hint.sql", "009_website_analysis.sql", "010_website_content_hash.sql"]);
    expect(db.prepare("SELECT * FROM workspaces").all()).toEqual(before);
    expect(count(db, "SELECT COUNT(*) n FROM workspace_credentials")).toBe(0);
    const cols = (db.prepare("PRAGMA table_info(workspace_credentials)").all() as Array<{ name: string; type: string }>);
    expect(cols.map((c) => c.name).filter((n) => /secret|plain|password|token|apikey|api_key/i.test(n))).toEqual([]);
    expect(cols.filter((c) => c.type === "BLOB").map((c) => c.name).sort()).toEqual(["sealed", "wrapped_dek"]);
    db.close();
  });

  it("enforces in the database that an active credential has key material, an ended one has none, one is live per kind, and nothing is revived", () => {
    const db = openDb(":memory:");
    migrate(db);
    db.prepare("INSERT INTO workspaces (id, name, token_hash, created_at) VALUES ('w1','W1','h','t'), ('w2','W2','h','t')").run();
    const ins = (id: string, ws: string, kind: string, version: number, status: string, material: boolean) => () =>
      db.prepare("INSERT INTO workspace_credentials (id, workspace_id, kind, version, status, sealed, wrapped_dek, key_id, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?, 't','x','t','x')").run(id, ws, kind, version, status, material ? Buffer.from("s") : null, material ? Buffer.from("w") : null, material ? "k1" : null);
    expect(ins("c0", "w1", "openai", 1, "active", false)).toThrow(/CHECK/); // active without material
    expect(ins("c0", "w1", "openai", 1, "revoked", true)).toThrow(/CHECK/); // ended but still holding material
    expect(ins("c0", "w1", "openai", 1, "deleted", true)).toThrow(/CHECK/);
    expect(ins("c0", "w1", "stripe", 1, "active", true)).toThrow(/CHECK/);
    expect(ins("c0", "w1", "openai", 0, "active", true)).toThrow(/CHECK/);
    expect(ins("c0", "nope", "openai", 1, "active", true)).toThrow(/FOREIGN KEY/);
    expect(ins("c1", "w1", "openai", 1, "active", true)).not.toThrow();
    expect(ins("c2", "w1", "openai", 2, "active", true)).toThrow(/UNIQUE/); // second live credential of one kind
    expect(ins("c3", "w2", "openai", 1, "active", true)).not.toThrow(); // another workspace is independent
    expect(ins("c4", "w1", "openai", 1, "revoked", false)).toThrow(/UNIQUE/); // version reuse
    db.prepare("UPDATE workspace_credentials SET status = 'revoked', sealed = NULL, wrapped_dek = NULL, key_id = NULL WHERE id = 'c1'").run();
    expect(() => db.prepare("UPDATE workspace_credentials SET status = 'active', sealed = x'01', wrapped_dek = x'02', key_id = 'k1' WHERE id = 'c1'").run()).toThrow(/reactivated/);
    expect(() => db.prepare("UPDATE workspace_credentials SET workspace_id = 'w2' WHERE id = 'c1'").run()).toThrow(/cannot change/);
    expect(() => db.prepare("UPDATE workspace_credentials SET kind = 'ghl' WHERE id = 'c1'").run()).toThrow(/cannot change/);
    expect(() => db.prepare("UPDATE workspace_credentials SET version = 9 WHERE id = 'c1'").run()).toThrow(/cannot change/);
    expect(ins("c5", "w1", "openai", 2, "active", true)).not.toThrow(); // after the first ended, a new one is allowed
    db.close();
  });
});
