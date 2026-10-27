/**
 * D4: what happens when key material is not available.
 *  - a missing ACTIVE key still stops startup,
 *  - a credential whose older key is gone fails closed with a 503 (the deployment's problem), while tampering, a wrong key and any
 *    unclassified failure stay a 500 (an integrity or internal fault),
 *  - everything unrelated keeps working, and a replacement recovers the credential,
 *  - authentication and authorization are untouched.
 * Offline: in-memory databases and random throwaway keys.
 */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext } from "../src/app/context.js";
import { createWorkspace } from "../src/app/workspaces.js";
import { userActor, type AuthzContext } from "../src/auth/authz.js";
import { KEY_BYTES } from "../src/credentials/crypto.js";
import { KeyUnavailableError, LocalKeyring, type KeyProvider } from "../src/credentials/keys.js";
import { CredentialVault } from "../src/credentials/vault.js";
import { migrate, openDb, type Db } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";

const KOLD = randomBytes(KEY_BYTES);
const KNEW = randomBytes(KEY_BYTES);
const SECRET = "FIXTURE-SECRET-VALUE-7f3a9c1e5b2d4f60";
const SECRET2 = "FIXTURE-SECRET-SECOND-91ab34cd56ef7801";
const now = () => new Date("2026-10-19T12:00:00.000Z");

const dbs: Db[] = [];
afterEach(() => {
  while (dbs.length) {
    const d = dbs.pop()!;
    if (d.open) d.close();
  }
});
const az = (workspaceId: string): AuthzContext => ({ workspaceId, role: "owner", actor: userActor("usr_d4") });

/** One workspace holding a credential that was wrapped under the key "old". */
async function world() {
  const db = openDb(":memory:");
  migrate(db);
  dbs.push(db);
  const core = { db, now };
  const ws = createWorkspace(core, "D4 Fixture");
  await new CredentialVault(core, new LocalKeyring({ old: KOLD }, "old")).store(az(ws.workspace.id), { kind: "openai", secret: SECRET });
  const as = (p: KeyProvider | null) => new CredentialVault(core, p);
  return { db, core, wid: ws.workspace.id, token: ws.token, as };
}
const newOnly = () => new LocalKeyring({ new: KNEW }, "new");
const auditReasons = (db: Db) => (db.prepare("SELECT detail FROM audit_events WHERE type = 'credential.integrity_failure' ORDER BY id").all() as Array<{ detail: string }>).map((r) => JSON.parse(r.detail).reason);

describe("a missing ACTIVE key still stops startup", () => {
  it("the keyring is rejected, naming the variable and never its contents; nothing is generated in its place", () => {
    const keyring = `old:${KOLD.toString("base64")}`;
    const env = { DEPLOYMENT_ENV: "test", CREDENTIAL_ALLOW_LOCAL_KEYRING: "true", CREDENTIAL_KEYRING: keyring, CREDENTIAL_ACTIVE_KEY: "missing-id" };
    expect(() => LocalKeyring.fromEnv(env)).toThrow(/CREDENTIAL_ACTIVE_KEY/);
    const db = openDb(":memory:");
    migrate(db);
    dbs.push(db);
    let message = "";
    try { buildContext({ db, env }); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/CREDENTIAL_ACTIVE_KEY/);
    expect(message).not.toContain(KOLD.toString("base64"));
    expect(() => new LocalKeyring({ old: KOLD }, "not-in-the-ring")).toThrow();
  });
});

describe("a credential whose key is unavailable", () => {
  it("fails closed with 503 and a fixed message that says nothing about which key, and records only the coarse reason", async () => {
    const w = await world();
    const v = w.as(newOnly());
    const err = await v.use(w.wid, "openai", () => "never").catch((e) => e);
    expect(err).toMatchObject({ status: 503, code: "credential_key_unavailable", message: "The key needed to read this credential is not available" });
    expect(`${err.code} ${err.message}`).not.toMatch(/\bold\b|\bnew\b/); // no key id in what a caller can see
    expect(JSON.stringify({ code: err.code, message: err.message })).not.toContain(SECRET);
    expect(auditReasons(w.db)).toEqual(["key_unavailable"]);
    // the callback is never run, so no secret could have been handed to it
    let ran = false;
    await v.use(w.wid, "openai", () => { ran = true; }).catch(() => undefined);
    expect(ran).toBe(false);
  });

  it("also answers 503 when the provider itself reports the key as unavailable (how a managed service's outage is to be mapped)", async () => {
    const w = await world();
    const outage: KeyProvider = { name: "managed-fake", managed: true, activeKeyId: () => "old", wrap: async () => { throw new KeyUnavailableError(); }, unwrap: async () => { throw new KeyUnavailableError(); } };
    await expect(w.as(outage).use(w.wid, "openai", () => 1)).rejects.toMatchObject({ status: 503, code: "credential_key_unavailable" });
  });

  it("with no provider at all, use() keeps its existing 503 'credentials_unavailable'", async () => {
    const w = await world();
    await expect(w.as(null).use(w.wid, "openai", () => 1)).rejects.toMatchObject({ status: 503, code: "credentials_unavailable" });
  });

  it("tampering, a wrong key under the same id, and an unclassified provider failure stay a 500 integrity or internal fault", async () => {
    const w = await world();
    const withOld = () => w.as(new LocalKeyring({ old: KOLD }, "old"));
    // wrong key bytes under the same id: authentication fails
    await expect(w.as(new LocalKeyring({ old: randomBytes(KEY_BYTES) }, "old")).use(w.wid, "openai", () => 1)).rejects.toMatchObject({ status: 500, code: "credential_unreadable" });
    // an unclassified provider failure is not presumed to be an outage
    const buggy: KeyProvider = { name: "buggy", activeKeyId: () => "old", wrap: async () => { throw new Error("x"); }, unwrap: async () => { throw new TypeError("provider bug with SECRET-DETAIL"); } };
    const e = await w.as(buggy).use(w.wid, "openai", () => 1).catch((x) => x);
    expect(e).toMatchObject({ status: 500, code: "credential_unreadable" });
    expect(JSON.stringify(e) + e.message).not.toContain("SECRET-DETAIL");
    // modified ciphertext
    const row = w.db.prepare("SELECT sealed FROM workspace_credentials").get() as { sealed: Buffer };
    const bad = Buffer.from(row.sealed);
    bad[bad.length - 1]! ^= 1;
    w.db.prepare("UPDATE workspace_credentials SET sealed = ?").run(bad);
    await expect(withOld().use(w.wid, "openai", () => 1)).rejects.toMatchObject({ status: 500, code: "credential_unreadable" });
    expect(auditReasons(w.db)).toEqual(["authentication_failed", "provider_error", "authentication_failed"]);
  });

  it("a revoked or replaced credential is still 'not found', not an outage", async () => {
    const w = await world();
    await w.as(newOnly()).revoke(az(w.wid), "openai"); // revoking needs no key
    await expect(w.as(newOnly()).use(w.wid, "openai", () => 1)).rejects.toMatchObject({ status: 404 });
  });
});

describe("unrelated functionality stays available while an older key is missing", () => {
  it("the application serves requests, the masked list works, revoke works, and a replacement recovers the credential", async () => {
    const w = await world();
    const ctx = buildContext({ db: w.db, env: {}, keyProvider: newOnly() });
    const app = buildServer(ctx);
    const get = async (url: string, token?: string) => app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await get("/api/health")).statusCode).toBe(200);
    expect((await get(`/api/workspaces/${w.wid}`, w.token)).statusCode).toBe(200);
    expect((await get(`/api/workspaces/${w.wid}/campaigns`, w.token)).statusCode).toBe(200);
    expect(ctx.credentials.available).toBe(true);
    expect(ctx.credentials.keyDependencies()).toEqual([{ keyId: "old", credentials: 1, available: false }]); // what the startup warning is built from
    // the masked status is still readable by someone allowed to see it
    expect(ctx.credentials.list(az(w.wid)).map((c) => [c.kind, c.status])).toEqual([["openai", "active"]]);
    // the owner recovers by storing the credential again: it is wrapped under the active key and the old record is erased
    const recovered = await ctx.credentials.store(az(w.wid), { kind: "openai", secret: SECRET2 });
    expect(recovered).toMatchObject({ version: 2, status: "active", protectedBy: "new" });
    expect(await ctx.credentials.use(w.wid, "openai", (s) => s.toString("utf8"))).toBe(SECRET2);
    expect(ctx.credentials.keyDependencies()).toEqual([{ keyId: "new", credentials: 1, available: true }]);
  });

  it("authentication and authorization are unchanged: anonymous 401, the legacy token 403 on every credential route, and the vault state is not disclosed", async () => {
    const w = await world();
    const ctx = buildContext({ db: w.db, env: {}, keyProvider: newOnly() });
    const app = buildServer(ctx);
    const call = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, token?: string) =>
      app.inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(method === "PUT" ? { "content-type": "application/json" } : {}) }, payload: method === "PUT" ? JSON.stringify({ secret: SECRET2 }) : undefined });
    const base = `/api/workspaces/${w.wid}/credentials`;
    for (const [m, u] of [["GET", base], ["PUT", `${base}/openai`], ["POST", `${base}/openai/revoke`], ["DELETE", `${base}/openai`]] as const) {
      const anon = await call(m, u);
      const legacy = await call(m, u, w.token);
      expect([m, anon.statusCode, legacy.statusCode]).toEqual([m, 401, 403]);
      expect(legacy.body).not.toMatch(/key|unavailable|old|new/i);
    }
  });
});
