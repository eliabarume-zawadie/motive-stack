/**
 * Milestone 4.3 closeout: regression tests for defects found while reviewing the vault.
 *   - erased ciphertext must not linger in the SQLite files (write-ahead log, freed pages)
 *   - a revocation that lands while a read is in flight must win
 *   - scrubbing a secret out of errors must work on causes, properties and encoded forms, without damaging unrelated information
 *   - missing master keys must be visible, and a key in use must not look retirable
 *   - a locked database on a failure path must not turn into a raw SQLite error
 *   - each binding layer (secret context, key context, master key id) is tested on its own
 * Offline: random in-memory keys, temporary files, an obviously fake secret.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { createWorkspace } from "../src/app/workspaces.js";
import { userActor, type AuthzContext } from "../src/auth/authz.js";
import { KEY_BYTES, CredentialCryptoError, newDataKey, open, seal } from "../src/credentials/crypto.js";
import { LocalKeyring, type KeyProvider } from "../src/credentials/keys.js";
import { keyContext, secretContext } from "../src/credentials/vault.js";
import { migrate, openDb, type Db } from "../src/db/db.js";

const SECRET = "FIXTURE-SECRET-VALUE-7f3a9c1e5b2d4f60";
const TRICKY = 'FIXTURE"SECRET\\value/with+chars=0123456789'; // quotes, backslash, slash, plus, equals: every encoding changes it
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
const keyMap = (...ids: string[]) => Object.fromEntries(ids.map((i) => [i, randomBytes(KEY_BYTES)]));
const ring = (keys: Record<string, Buffer>, active: string) => new LocalKeyring(keys, active);
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "ms-closeout-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function world(keys: KeyProvider | null = ring(keyMap("k1"), "k1"), file = ":memory:") {
  const db = openDb(file);
  migrate(db);
  const ctx: AppContext = buildContext({ db, env: {}, keyProvider: keys });
  cleanups.push(() => db.open && db.close());
  const workspace = createWorkspace(ctx, "Acme Plumbing").workspace;
  const owner: AuthzContext = { workspaceId: workspace.id, role: "owner", actor: userActor("usr_owner") };
  return { db, ctx, vault: ctx.credentials, workspace, owner };
}
const count = (db: Db, sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

describe("erased credentials do not linger in the database files", () => {
  async function filesContain(dir: string, needles: Buffer[]): Promise<string[]> {
    return readdirSync(dir).flatMap((f) => needles.flatMap((n, i) => (readFileSync(join(dir, f)).includes(n) ? [`needle${i} in ${f.replace(/.*\.db/, "db")}`] : [])));
  }

  it("revoke, replace and delete leave neither the sealed secret nor the wrapped key in the main file or the write-ahead log", async () => {
    for (const how of ["revoke", "replace", "delete"] as const) {
      const dir = tmp();
      const w = world(undefined, join(dir, "t.db"));
      await w.vault.store(w.owner, { kind: "openai", secret: SECRET });
      const row = w.db.prepare("SELECT sealed, wrapped_dek FROM workspace_credentials").get() as { sealed: Buffer; wrapped_dek: Buffer };
      expect(await filesContain(dir, [row.sealed, row.wrapped_dek]), "present while active").not.toEqual([]); // the check can see them
      if (how === "revoke") await w.vault.revoke(w.owner, "openai");
      if (how === "delete") await w.vault.delete(w.owner, "openai");
      if (how === "replace") await w.vault.store(w.owner, { kind: "openai", secret: "FIXTURE-SECRET-SECOND-91ab34cd56ef7801" });
      expect(await filesContain(dir, [row.sealed, row.wrapped_dek]), how).toEqual([]); // no manual checkpoint in between
    }
  });

  it("secure_delete is on for every connection the application opens", () => {
    const db = openDb(":memory:");
    expect(db.pragma("secure_delete", { simple: true })).toBe(1);
    db.close();
  });
});

describe("a revocation that lands during a read wins", () => {
  it("if the credential is revoked or replaced while its data key is being unwrapped, the secret is never handed out", async () => {
    const inner = ring(keyMap("k1"), "k1");
    let during: (() => void) | null = null;
    const provider: KeyProvider = { name: "hook", activeKeyId: () => inner.activeKeyId(), wrap: (d, c) => inner.wrap(d, c), unwrap: async (k, w, c) => (during?.(), inner.unwrap(k, w, c)) };
    for (const how of ["revoked", "replaced", "deleted"]) {
      const w = world(provider);
      await w.vault.store(w.owner, { kind: "openai", secret: SECRET });
      let called = false;
      during = () => {
        if (how === "revoked") w.db.prepare("UPDATE workspace_credentials SET status = 'revoked', sealed = NULL, wrapped_dek = NULL, key_id = NULL").run();
        else if (how === "deleted") w.db.prepare("UPDATE workspace_credentials SET status = 'deleted', sealed = NULL, wrapped_dek = NULL, key_id = NULL, label = NULL").run();
        else w.db.prepare("UPDATE workspace_credentials SET status = 'revoked', sealed = NULL, wrapped_dek = NULL, key_id = NULL").run();
      };
      await expect(w.vault.use(w.workspace.id, "openai", () => { called = true; }), how).rejects.toMatchObject({ status: 404 });
      expect(called, how).toBe(false);
      during = null;
    }
  });
});

describe("scrubbing a secret out of errors", () => {
  async function thrownBy(throwIt: (secret: string) => unknown, secret = SECRET): Promise<any> {
    const w = world();
    await w.vault.store(w.owner, { kind: "openai", secret });
    return w.vault.use(w.workspace.id, "openai", () => { throw throwIt(secret); }).catch((e) => e);
  }
  const everywhere = (value: unknown) => JSON.stringify(value, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack, cause: (v as { cause?: unknown }).cause } : v)) ?? "";

  it("cleans the message, stack, own properties, nested objects and the whole cause chain, keeping everything else", async () => {
    const e = await thrownBy((s) => {
      const root = Object.assign(new Error(`root failure for ${s}`), { code: "E_ROOT", status: 401 });
      const err = Object.assign(new Error(`request failed (status 401) with key ${s}`, { cause: root }), {
        kind: "permission", attempts: 3,
        request: { url: "https://api.example.test/v1", headers: { Authorization: `Bearer ${s}`, Accept: "application/json" } },
        details: [`first ${s}`, "second is harmless"],
      });
      return err;
    });
    const dumped = everywhere(e);
    expect(dumped).not.toContain(SECRET);
    // unrelated facts survive untouched
    expect([e.kind, e.attempts, e.request.url, e.request.headers.Accept, e.details[1], e.cause.code, e.cause.status]).toEqual(["permission", 3, "https://api.example.test/v1", "application/json", "second is harmless", "E_ROOT", 401]);
    expect(e.message).toBe("request failed (status 401) with key [redacted]");
    expect(e.request.headers.Authorization).toBe("Bearer [redacted]");
    expect(e.cause.message).toBe("root failure for [redacted]");
  });

  it("also removes the secret when it appears JSON-escaped, URL-encoded, base64 (Basic auth), base64url or hex", async () => {
    const e = await thrownBy((s) => new Error([
      `raw ${s}`,
      `json ${JSON.stringify({ k: s })}`,
      `url https://x.test/?key=${encodeURIComponent(s)}`,
      `basic ${Buffer.from(`user:${s}`).toString("base64")}`, // base64 of a longer string containing the secret is a different string; only exact forms are covered
      `b64 ${Buffer.from(s).toString("base64")}`,
      `b64url ${Buffer.from(s).toString("base64url")}`,
      `hex ${Buffer.from(s).toString("hex")}`,
    ].join(" | ")), TRICKY);
    const text = e.message as string;
    for (const form of [TRICKY, JSON.stringify(TRICKY).slice(1, -1), encodeURIComponent(TRICKY), Buffer.from(TRICKY).toString("base64"), Buffer.from(TRICKY).toString("base64url"), Buffer.from(TRICKY).toString("hex")]) expect(text).not.toContain(form);
    expect(text).toContain("raw [redacted]");
    expect(text).toContain("url https://x.test/?key=[redacted]");
  });

  it("leaves text without the secret alone, never runs getters, survives cycles, and keeps thrown strings as strings", async () => {
    let getterRan = false;
    const cyc: Record<string, unknown> = { note: "no secret here" };
    cyc.self = cyc;
    const e = await thrownBy((s) => Object.defineProperties(Object.assign(new TypeError("plain failure"), { cyc, list: [1, "two", { three: s }] }), {
      lazy: { get() { getterRan = true; return s; }, enumerable: true },
    }));
    expect(e).toBeInstanceOf(TypeError);
    expect([e.message, e.cyc.note, e.cyc.self === e.cyc, e.list[0], e.list[1], e.list[2].three]).toEqual(["plain failure", "no secret here", true, 1, "two", "[redacted]"]);
    expect(getterRan).toBe(false);
    expect(await thrownBy((s) => `string ${s}`)).toBe("string [redacted]");
    expect(await thrownBy(() => 42)).toBe(42);
    expect(await thrownBy(() => null)).toBe(null);
  });

  it("when a value holding the secret cannot be changed, a safe error replaces it rather than the original leaking", async () => {
    const e = await thrownBy((s) => Object.freeze(Object.assign(new Error(`frozen with ${s}`), {})));
    expect(everywhere(e)).not.toContain(SECRET);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toContain("[redacted]");
    expect(e.message).toContain("details withheld");
    const frozenProp = await thrownBy((s) => Object.freeze({ message: `obj ${s}` }));
    expect(everywhere(frozenProp)).not.toContain(SECRET);
  });

  it("is bounded: a huge or deep error graph neither hangs nor blows the stack", async () => {
    const e = await thrownBy((s) => {
      let deep: Record<string, unknown> = { leaf: s };
      for (let i = 0; i < 10_000; i++) deep = { next: deep };
      return Object.assign(new Error("deep"), { deep, wide: Array.from({ length: 50_000 }, (_, i) => `item ${i}`) });
    });
    expect(e.message).toBe("deep");
    expect(e.wide).toHaveLength(50_000);
  });
});

describe("master keys that stored credentials depend on", () => {
  it("reports which keys live credentials depend on and whether the server still has them; a key in use cannot be retired", async () => {
    const keys = keyMap("k1", "k2");
    const before = world(ring({ k1: keys.k1! }, "k1"));
    await before.vault.store(before.owner, { kind: "openai", secret: SECRET });
    expect(before.vault.keyDependencies()).toEqual([{ keyId: "k1", credentials: 1, available: true }]);
    expect(before.vault.canRetire("k1")).toBe(false); // it is the active key and in use
    expect(before.vault.canRetire("k2")).toBe(true); // nothing depends on a key that is not in the keyring
    // another process starts with a keyring that no longer has k1
    const after = world(ring({ k2: keys.k2! }, "k2"));
    for (const t of ["workspaces", "workspace_credentials"]) for (const row of before.db.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>) after.db.prepare(`INSERT INTO ${t} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    expect(after.vault.keyDependencies()).toEqual([{ keyId: "k1", credentials: 1, available: false }]);
    const nothing = world(null);
    for (const row of before.db.prepare("SELECT * FROM workspaces").all() as Array<Record<string, unknown>>) nothing.db.prepare(`INSERT INTO workspaces (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    for (const row of before.db.prepare("SELECT * FROM workspace_credentials").all() as Array<Record<string, unknown>>) nothing.db.prepare(`INSERT INTO workspace_credentials (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    expect(nothing.vault.keyDependencies()).toEqual([{ keyId: "k1", credentials: 1, available: false }]); // vault off, credentials still there
    expect(nothing.vault.canRetire("k1")).toBe(false);
    // after re-wrapping to k2 in a process that has both, k1 becomes retirable
    const both = world(ring(keys, "k2"));
    for (const t of ["workspaces", "workspace_credentials"]) for (const row of before.db.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>) both.db.prepare(`INSERT INTO ${t} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    expect(both.vault.canRetire("k1")).toBe(false);
    await both.vault.rewrapAll();
    expect(both.vault.canRetire("k1")).toBe(true);
    expect(both.vault.keyDependencies()).toEqual([{ keyId: "k2", credentials: 1, available: true }]);
  });

  it("a provider that cannot say whether it holds a key reports 'unknown', not 'missing'", async () => {
    const inner = ring(keyMap("k1"), "k1");
    const opaque: KeyProvider = { name: "opaque", activeKeyId: () => inner.activeKeyId(), wrap: (d, c) => inner.wrap(d, c), unwrap: (k, w, c) => inner.unwrap(k, w, c) };
    const w = world(opaque);
    await w.vault.store(w.owner, { kind: "ghl", secret: SECRET });
    expect(w.vault.keyDependencies()).toEqual([{ keyId: "k1", credentials: 1, available: null }]);
  });
});

describe("a locked database on a failure path stays a clean failure", () => {
  it("an unreadable credential is still reported as unreadable, and a rotation step that cannot be audited does not abort the others", async () => {
    const dir = tmp();
    const file = join(dir, "lock.db");
    const keys = keyMap("k1", "k2");
    const first = world(ring({ k1: keys.k1! }, "k1"), file);
    await first.vault.store(first.owner, { kind: "openai", secret: SECRET });
    first.db.close();

    const wid = first.workspace.id;
    const w = world(ring(keys, "k2"), file); // the same file, now with k2 active (and k1 still present)
    w.db.pragma("busy_timeout = 25"); // fail fast instead of waiting five seconds
    const row = w.db.prepare("SELECT sealed FROM workspace_credentials WHERE workspace_id = ?").get(wid) as { sealed: Buffer };
    const bad = Buffer.from(row.sealed);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
    w.db.prepare("UPDATE workspace_credentials SET sealed = ? WHERE workspace_id = ?").run(bad, wid);
    const rival = openDb(file); // another connection that is in the middle of a write
    cleanups.push(() => rival.open && rival.close());
    rival.exec("BEGIN IMMEDIATE");
    // use(): the tampering is detected, the audit write is blocked, and the answer is still the clean "unreadable" (not a SQLite error)
    await expect(w.vault.use(wid, "openai", () => 1)).rejects.toMatchObject({ code: "credential_unreadable", status: 500 });
    // rewrap: the update is blocked by the rival, counted as failed, the audit write is skipped quietly, and the call returns normally
    expect(await w.vault.rewrapAll()).toEqual({ rewrapped: 0, skipped: 0, failed: 1 });
    rival.exec("ROLLBACK");
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials WHERE status = 'active' AND key_id = 'k1'")).toBe(1); // untouched
  });
});

describe("each binding is checked on its own", () => {
  const base = { id: "crd_1", workspace_id: "ws_a", kind: "openai" };
  const variants = { workspace: { ...base, workspace_id: "ws_b" }, id: { ...base, id: "crd_2" }, kind: { ...base, kind: "anthropic" } };

  it("the secret's context differs when any one of workspace, credential id or kind differs, and a ciphertext does not open under the other", () => {
    const key = newDataKey();
    const sealed = seal(key, Buffer.from(SECRET), secretContext(base));
    for (const [what, other] of Object.entries(variants)) {
      expect(secretContext(other).equals(secretContext(base)), what).toBe(false);
      expect(() => open(key, sealed, secretContext(other)), what).toThrow(CredentialCryptoError);
    }
    expect(open(key, sealed, secretContext(base)).toString()).toBe(SECRET);
  });

  it("the wrapped key's context differs for any one of workspace, id or kind, and it does not unwrap under the other", async () => {
    const r = ring(keyMap("k1"), "k1");
    const w = await r.wrap(newDataKey(), keyContext(base));
    for (const [what, other] of Object.entries(variants)) {
      expect(keyContext(other).equals(keyContext(base)), what).toBe(false);
      await expect(r.unwrap("k1", w.wrapped, keyContext(other)), what).rejects.toBeInstanceOf(CredentialCryptoError);
    }
    await expect(r.unwrap("k1", w.wrapped, keyContext(base))).resolves.toHaveLength(KEY_BYTES);
  });

  it("the secret's context and the key's context are different strings, so one cannot stand in for the other", () => {
    expect(secretContext(base).equals(keyContext(base))).toBe(false);
  });
});

describe("rewrap is safe against interruption and concurrent change (why its extra WHERE conditions are redundant, not missing)", () => {
  it("the database guarantees only an active row has a key id, so 'key_id = old' alone already excludes revoked, deleted and replaced rows", () => {
    const db = openDb(":memory:");
    migrate(db);
    db.prepare("INSERT INTO workspaces (id, name, token_hash, created_at) VALUES ('w','W','h','t')").run();
    const ins = (status: string, key: string | null) => () =>
      db.prepare("INSERT INTO workspace_credentials (id, workspace_id, kind, version, status, sealed, wrapped_dek, key_id, created_at, created_by, updated_at, updated_by) VALUES ('c','w','openai',1,?,?,?,?, 't','x','t','x')").run(status, key ? Buffer.from("s") : null, key ? Buffer.from("w") : null, key);
    for (const status of ["revoked", "deleted"]) expect(ins(status, "k1"), status).toThrow(/CHECK/); // an ended row cannot keep a key id
    expect(ins("active", null)).toThrow(/CHECK/);
    db.close();
  });
});
