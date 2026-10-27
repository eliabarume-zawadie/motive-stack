/**
 * M4.4c Package 1: key operations (dependency report, probe, safe resumable rewrap) and the key-provider conformance checks.
 * Offline: isolated in-memory databases, random throwaway keys generated per run, no network, no real credentials.
 */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../src/app/workspaces.js";
import { userActor, type AuthzContext } from "../src/auth/authz.js";
import { checkKeyProvider, failedChecks } from "./support/keyProviderConformance.js";
import { KEY_BYTES } from "../src/credentials/crypto.js";
import { buildKeyReport, executeKeyCommand, formatKeyReport } from "../src/credentials/keyOps.js";
import { KeyUnavailableError, LocalKeyring, type KeyProvider } from "../src/credentials/keys.js";
import { selectKeyProvider } from "../src/credentials/provider.js";
import { CredentialVault, type CredentialKind } from "../src/credentials/vault.js";
import { migrate, openDb, type Db } from "../src/db/db.js";

const KOLD = randomBytes(KEY_BYTES);
const KNEW = randomBytes(KEY_BYTES);
const oldOnly = () => new LocalKeyring({ old: KOLD }, "old");
const bothNewActive = () => new LocalKeyring({ old: KOLD, new: KNEW }, "new");
const newOnly = () => new LocalKeyring({ new: KNEW }, "new");

const dbs: Db[] = [];
afterEach(() => {
  while (dbs.length) {
    const d = dbs.pop()!;
    if (d.open) d.close();
  }
});
const now = () => new Date("2026-10-19T12:00:00.000Z");
const secretOf = (i: number) => `FIXTURE-SECRET-NUMBER-${i}-0123456789abcdef`;
const az = (workspaceId: string): AuthzContext => ({ workspaceId, role: "owner", actor: userActor("usr_ops") });

/** A database with two workspaces and five live credentials stored under `provider`. */
async function world(provider: KeyProvider = oldOnly()) {
  const db = openDb(":memory:");
  migrate(db);
  dbs.push(db);
  const core = { db, now };
  const w1 = createWorkspace(core, "Ops Fixture One").workspace.id;
  const w2 = createWorkspace(core, "Ops Fixture Two").workspace.id;
  const vault = new CredentialVault(core, provider);
  const items: Array<{ ws: string; kind: CredentialKind; secret: string }> = [
    { ws: w1, kind: "openai", secret: secretOf(1) },
    { ws: w1, kind: "anthropic", secret: secretOf(2) },
    { ws: w1, kind: "ghl", secret: secretOf(3) },
    { ws: w2, kind: "openai", secret: secretOf(4) },
    { ws: w2, kind: "meta_graph", secret: secretOf(5) },
  ];
  for (const it of items) await vault.store(az(it.ws), { kind: it.kind, secret: it.secret });
  const as = (p: KeyProvider | null) => new CredentialVault(core, p);
  const dump = () => JSON.stringify(db.prepare("SELECT * FROM workspace_credentials ORDER BY id").all());
  const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
  const usable = async (v: CredentialVault) => {
    for (const it of items) expect(await v.use(it.ws, it.kind, (s) => s.toString("utf8")), `${it.kind}`).toBe(it.secret);
  };
  const keyIds = () => (db.prepare("SELECT DISTINCT key_id FROM workspace_credentials WHERE status = 'active' ORDER BY key_id").all() as Array<{ key_id: string }>).map((r) => r.key_id);
  return { db, core, vault, as, items, dump, count, usable, keyIds, w1, w2 };
}

/** Wraps a provider so a test can observe calls and inject faults. Nothing here weakens the real provider's checks. */
function instrument(inner: KeyProvider, over: Partial<{ onWrap: (dek: Buffer, ctx: Buffer) => Promise<Buffer | void> | Buffer | void; wrap: KeyProvider["wrap"]; unwrap: KeyProvider["unwrap"]; delayMs: number }> = {}) {
  const calls = { wrap: 0, unwrap: 0 };
  const sleep = () => (over.delayMs ? new Promise<void>((r) => setTimeout(r, over.delayMs)) : Promise.resolve());
  const p: KeyProvider = {
    name: inner.name,
    managed: inner.managed,
    activeKeyId: () => inner.activeKeyId(),
    hasKey: inner.hasKey ? (k) => inner.hasKey!(k) : undefined,
    async wrap(dek, ctx) {
      calls.wrap++;
      await sleep();
      if (over.wrap) return over.wrap(dek, ctx);
      const replacement = await over.onWrap?.(dek, ctx);
      return inner.wrap(replacement ?? dek, ctx);
    },
    async unwrap(k, w, ctx) {
      calls.unwrap++;
      if (over.unwrap) return over.unwrap(k, w, ctx);
      return inner.unwrap(k, w, ctx);
    },
  };
  return { p, calls };
}

/* ====================================================================================================================
 * the report
 * ================================================================================================================== */

describe("dependency report", () => {
  it("shows which master keys live credentials depend on, which are held, and which may be retired", async () => {
    const w = await world();
    const r = buildKeyReport(w.as(bothNewActive()), "ok");
    expect(r).toMatchObject({ provider: "local_keyring", managed: false, activeKeyId: "new", totalActive: 5, needsRewrap: 5, unreadable: 0 });
    expect(r.keys).toEqual([{ keyId: "old", credentials: 5, active: false, available: true, retirable: false }]);
    await w.as(bothNewActive()).rewrap();
    expect(buildKeyReport(w.as(bothNewActive()), "ok").keys).toEqual([{ keyId: "new", credentials: 5, active: true, available: true, retirable: false }]);
    expect(w.as(bothNewActive()).canRetire("old")).toBe(true); // nothing depends on it any more
  });

  it("flags credentials that depend on a key the provider no longer holds, and works with no provider at all", async () => {
    const w = await world();
    const missing = buildKeyReport(w.as(newOnly()), "ok");
    expect(missing).toMatchObject({ unreadable: 5, needsRewrap: 5 });
    expect(missing.keys[0]).toMatchObject({ keyId: "old", available: false, retirable: false });
    const none = buildKeyReport(w.as(null), "production_requires_managed_provider");
    expect(none).toMatchObject({ provider: null, managed: null, activeKeyId: null, unreadable: 5 });
    expect(formatKeyReport(none)[0]).toBe("Key provider: none (production_requires_managed_provider)");
  });

  it("is read-only: no database change and no wrap or unwrap call", async () => {
    const w = await world();
    const spy = instrument(bothNewActive());
    const before = [w.dump(), w.count("SELECT COUNT(*) n FROM audit_events")];
    const r = await executeKeyCommand({ argv: ["report"], env: {}, db: w.db, keyProvider: spy.p });
    expect(r.code).toBe(0);
    expect([w.dump(), w.count("SELECT COUNT(*) n FROM audit_events")]).toEqual(before);
    expect(spy.calls).toEqual({ wrap: 0, unwrap: 0 });
  });
});

/* ====================================================================================================================
 * rewrap
 * ================================================================================================================== */

describe("rewrap", () => {
  it("moves every live credential to the active key, keeps them usable, is idempotent, and audits each move without values", async () => {
    const w = await world();
    const next = w.as(bothNewActive());
    expect(await next.rewrap()).toMatchObject({ rewrapped: 5, skipped: 0, failed: 0, remaining: 0, failures: {} });
    expect(w.keyIds()).toEqual(["new"]);
    await w.usable(next);
    await w.usable(w.as(newOnly())); // and the old key is no longer needed
    expect(await next.rewrap()).toMatchObject({ rewrapped: 0, skipped: 0, failed: 0, remaining: 0 });
    expect(w.count("SELECT COUNT(*) n FROM audit_events WHERE type = 'credential.rewrapped'")).toBe(5);
    const details = (w.db.prepare("SELECT detail FROM audit_events WHERE type = 'credential.rewrapped'").all() as Array<{ detail: string }>).map((r) => r.detail).join("\n");
    for (const it of w.items) expect(details).not.toContain(it.secret);
    expect(w.as(bothNewActive()).canRetire("old")).toBe(true);
  });

  it("a dry run exercises the provider but writes nothing", async () => {
    const w = await world();
    const spy = instrument(bothNewActive());
    const before = [w.dump(), w.count("SELECT COUNT(*) n FROM audit_events")];
    const r = await w.as(spy.p).rewrap({ dryRun: true });
    expect(r).toMatchObject({ dryRun: true, wouldRewrap: 5, rewrapped: 0, failed: 0, remaining: 5 });
    expect([w.dump(), w.count("SELECT COUNT(*) n FROM audit_events")]).toEqual(before);
    expect(spy.calls.wrap).toBe(5);
    expect(spy.calls.unwrap).toBe(10); // each record: unwrap the old wrapping, then unwrap the new one to verify it
  });

  it("is resumable: a limit processes a part, and later runs finish the rest", async () => {
    const w = await world();
    const v = w.as(bothNewActive());
    const sizes: number[][] = [];
    for (let i = 0; i < 3; i++) {
      const r = await v.rewrap({ limit: 2 });
      sizes.push([r.rewrapped, r.remaining]);
    }
    expect(sizes).toEqual([[2, 3], [2, 1], [1, 0]]);
    await w.usable(v);
    expect((await v.rewrap({ limit: 0 })).rewrapped).toBe(0);
  });

  it("one failing credential does not stop the others, is left exactly as it was, still works, and is picked up by the next run", async () => {
    const w = await world();
    const target = (w.db.prepare("SELECT id FROM workspace_credentials WHERE kind = 'ghl'").get() as { id: string }).id;
    let broken = true;
    const flaky = instrument(bothNewActive(), {
      wrap: async (dek, ctx) => {
        if (broken && ctx.toString().includes(target)) throw new Error("provider hiccup: CANARY-DETAIL");
        return bothNewActive().wrap(dek, ctx);
      },
    });
    const v = w.as(flaky.p);
    const first = await v.rewrap();
    expect(first).toMatchObject({ rewrapped: 4, failed: 1, remaining: 1, failures: { provider_error: 1 } });
    const row = w.db.prepare("SELECT key_id, status FROM workspace_credentials WHERE id = ?").get(target);
    expect(row).toEqual({ key_id: "old", status: "active" });
    await w.usable(w.as(bothNewActive())); // all five still decrypt (the stuck one under its old key)
    expect(w.count("SELECT COUNT(*) n FROM audit_events WHERE type = 'credential.rewrap_failed'")).toBe(1);
    expect(JSON.stringify(w.db.prepare("SELECT detail FROM audit_events WHERE type = 'credential.rewrap_failed'").all())).not.toContain("CANARY-DETAIL");
    broken = false;
    expect(await v.rewrap()).toMatchObject({ rewrapped: 1, failed: 0, remaining: 0 });
    expect(w.keyIds()).toEqual(["new"]);
  });

  it("a provider that returns a wrapping which cannot be opened, the wrong key id, or a different key never replaces a working wrapping", async () => {
    const faults: Array<[string, KeyProvider["wrap"]]> = [
      ["garbage wrapping", async () => ({ keyId: "new", wrapped: randomBytes(60) })],
      ["wrong key id", async (d, c) => ({ ...(await bothNewActive().wrap(d, c)), keyId: "old" })],
      ["wraps some other key", async (_d, c) => bothNewActive().wrap(randomBytes(KEY_BYTES), c)],
      ["empty wrapping", async () => ({ keyId: "new", wrapped: Buffer.alloc(0) })],
    ];
    for (const [what, wrap] of faults) {
      const w = await world();
      const before = w.dump();
      const r = await w.as(instrument(bothNewActive(), { wrap }).p).rewrap();
      expect(r, what).toMatchObject({ rewrapped: 0, failed: 5, remaining: 5 });
      expect(w.dump(), what).toBe(before); // not one byte changed
      await w.usable(w.as(bothNewActive()));
    }
  });

  it("a master key that is missing fails closed: nothing changes, nothing is made up, and use() refuses", async () => {
    const w = await world();
    const before = w.dump();
    const v = w.as(newOnly());
    expect(await v.rewrap()).toMatchObject({ rewrapped: 0, failed: 5, remaining: 5, failures: { key_unavailable: 5 } });
    expect(w.dump()).toBe(before);
    expect(w.keyIds()).toEqual(["old"]);
    await expect(v.use(w.w1, "openai", (s) => s.toString())).rejects.toMatchObject({ status: 503, code: "credential_key_unavailable" });
    expect(v.canRetire("old")).toBe(false);
    const probe = await v.probeKeys();
    expect(probe).toMatchObject({ checked: 5, ok: 0, failed: 5, byReason: { key_unavailable: 5 } });
  });

  it("a credential revoked while its key is being rewrapped stays revoked and erased", async () => {
    const w = await world();
    let hit = false;
    const hooked = instrument(bothNewActive(), {
      onWrap: () => {
        if (hit) return;
        hit = true;
        w.db.prepare("UPDATE workspace_credentials SET status = 'revoked', sealed = NULL, wrapped_dek = NULL, key_id = NULL WHERE id = (SELECT id FROM workspace_credentials WHERE status = 'active' AND key_id = 'old' ORDER BY id LIMIT 1)").run();
      },
    });
    const r = await w.as(hooked.p).rewrap();
    expect(r).toMatchObject({ rewrapped: 4, skipped: 1, failed: 0 });
    expect(w.count("SELECT COUNT(*) n FROM workspace_credentials WHERE status = 'revoked' AND sealed IS NULL AND wrapped_dek IS NULL AND key_id IS NULL")).toBe(1);
    expect(w.count("SELECT COUNT(*) n FROM workspace_credentials WHERE status = 'active'")).toBe(4);
  });

  it("a credential another process already rewrapped is not overwritten", async () => {
    const w = await world();
    let once = false;
    const hooked = instrument(bothNewActive(), {
      onWrap: async () => {
        if (once) return;
        once = true;
        await w.as(bothNewActive()).rewrap(); // "another operator" finishes the whole job while this run is mid-record
      },
    });
    const r = await w.as(hooked.p).rewrap();
    expect(r).toMatchObject({ rewrapped: 0, failed: 0, skipped: 5 });
    expect(w.keyIds()).toEqual(["new"]);
    await w.usable(w.as(newOnly()));
  });

  it("two overlapping runs move every credential exactly once between them", async () => {
    const w = await world();
    const a = w.as(instrument(bothNewActive(), { delayMs: 8 }).p);
    const b = w.as(instrument(bothNewActive(), { delayMs: 3 }).p);
    const [ra, rb] = await Promise.all([a.rewrap(), b.rewrap()]);
    expect(ra.rewrapped + rb.rewrapped).toBe(5);
    expect(ra.failed + rb.failed).toBe(0);
    expect(w.count("SELECT COUNT(*) n FROM audit_events WHERE type = 'credential.rewrapped'")).toBe(5);
    await w.usable(w.as(newOnly()));
  });

  it("refuses without a provider, and credentials that are not live are never touched", async () => {
    const w = await world();
    await expect(w.as(null).rewrap()).rejects.toMatchObject({ status: 503 });
    await w.vault.revoke(az(w.w1), "openai");
    const r = await w.as(bothNewActive()).rewrap();
    expect(r).toMatchObject({ rewrapped: 4, failed: 0 });
    expect(w.count("SELECT COUNT(*) n FROM workspace_credentials WHERE status <> 'active' AND (sealed IS NOT NULL OR wrapped_dek IS NOT NULL OR key_id IS NOT NULL)")).toBe(0);
  });
});

describe("probe", () => {
  it("checks that each live credential's data key can be unwrapped, never decrypts a secret, and changes nothing", async () => {
    const w = await world();
    // Damage one stored secret: only a real decryption could notice, so a probe that stays happy proves it does not decrypt.
    const damaged = w.db.prepare("SELECT id, workspace_id, kind FROM workspace_credentials ORDER BY id LIMIT 1").get() as { id: string; workspace_id: string; kind: CredentialKind };
    w.db.prepare("UPDATE workspace_credentials SET sealed = X'00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF' WHERE id = ?").run(damaged.id);
    const spy = instrument(bothNewActive());
    const before = w.dump();
    const p = await w.as(spy.p).probeKeys();
    expect(p).toMatchObject({ checked: 5, ok: 5, failed: 0, byKey: [{ keyId: "old", ok: 5, failed: 0 }] });
    expect(spy.calls).toEqual({ wrap: 0, unwrap: 5 });
    expect(w.dump()).toBe(before);
    // ...while a real read of that credential does notice, and reports it as an internal integrity fault (500), not an outage
    await expect(w.as(bothNewActive()).use(damaged.workspace_id, damaged.kind, () => 1)).rejects.toMatchObject({ status: 500, code: "credential_unreadable" });
  });
  it("reports a failing key by id and reason only", async () => {
    const w = await world();
    const r = await w.as(newOnly()).probeKeys();
    expect(r.byKey).toEqual([{ keyId: "old", ok: 0, failed: 5 }]);
    await expect(w.as(null).probeKeys()).rejects.toMatchObject({ status: 503 });
  });
});

/* ====================================================================================================================
 * the operator command
 * ================================================================================================================== */

describe("operator command", () => {
  const b64 = (k: Buffer) => k.toString("base64");
  const envFor = (ids: Array<[string, Buffer]>, active: string, extra: Record<string, string> = {}) => ({
    DEPLOYMENT_ENV: "test",
    CREDENTIAL_ALLOW_LOCAL_KEYRING: "true",
    CREDENTIAL_KEYRING: ids.map(([i, k]) => `${i}:${b64(k)}`).join(","),
    CREDENTIAL_ACTIVE_KEY: active,
    ...extra,
  });
  const run = (db: Db, argv: string[], env: Record<string, string | undefined>, keyProvider?: KeyProvider | null) => executeKeyCommand({ argv, env, db, now, keyProvider });

  it("rotates end to end from configuration: report, dry run, rewrap, report again, retire", async () => {
    const stage1 = envFor([["old", KOLD]], "old");
    const w = await world(selectKeyProvider(stage1).provider!);
    const stage2 = envFor([["old", KOLD], ["new", KNEW]], "new");
    const r1 = await run(w.db, ["report"], stage2);
    expect([r1.code, r1.lines.join("\n")]).toEqual([0, expect.stringContaining("needing a rewrap: 5")]);
    const dry = await run(w.db, ["rewrap", "--dry-run"], stage2);
    expect([dry.code, dry.lines[0]]).toEqual([0, expect.stringContaining("Dry run: 5 credential(s) would be rewrapped under new")]);
    const real = await run(w.db, ["rewrap"], stage2);
    expect(real.code).toBe(0);
    expect(real.lines.join("\n")).toMatch(/Rewrapped 5 credential\(s\) under new; 0 skipped.*0 failed/s);
    const r2 = await run(w.db, ["report"], stage2);
    expect(r2.lines.join("\n")).toContain("needing a rewrap: 0");
    expect(r2.lines.join("\n")).not.toMatch(/key old/); // no live credential depends on it any more
  });

  it("reports the retirement state correctly after a rewrap", async () => {
    const w = await world(selectKeyProvider(envFor([["old", KOLD]], "old")).provider!);
    const stage2 = envFor([["old", KOLD], ["new", KNEW]], "new");
    await run(w.db, ["rewrap"], stage2);
    const rep = await run(w.db, ["report"], stage2);
    expect(rep.lines).toContain("  key new: 5 credential(s); ACTIVE; held by the provider; cannot be retired yet");
    expect(rep.lines.join("\n")).not.toMatch(/key old/);
  });

  it("exit codes: a failed rewrap or a missing key is 1, usage mistakes are 2, success is 0", async () => {
    const w = await world();
    const missing = envFor([["new", KNEW]], "new");
    const rep = await run(w.db, ["report"], missing);
    expect(rep.code).toBe(1);
    expect(rep.lines.join("\n")).toContain("PROBLEM:");
    const rw = await run(w.db, ["rewrap"], missing);
    expect(rw.code).toBe(1);
    expect(rw.lines.join("\n")).toMatch(/5 failed \(master key not available: 5\)/);
    expect(rw.lines.join("\n")).toContain("left exactly as they were");
    const pr = await run(w.db, ["probe"], missing);
    expect(pr.code).toBe(1);
    for (const argv of [[], ["nope"], ["report", "--dry-run"], ["rewrap", "--limit"], ["rewrap", "--limit", "0"], ["rewrap", "--limit", "x"], ["rewrap", "--force"], ["probe", "--limit", "2"]]) {
      expect((await run(w.db, argv, missing)).code, argv.join(" ")).toBe(2);
    }
    expect((await run(w.db, ["rewrap", "--limit", "2"], envFor([["old", KOLD], ["new", KNEW]], "new"))).code).toBe(0);
  });

  it("production, an unset DEPLOYMENT_ENV and the local-keyring opt-in all keep the guard: there is no provider and nothing is done", async () => {
    const w = await world();
    const before = w.dump();
    const keyring = { CREDENTIAL_KEYRING: `old:${b64(KOLD)},new:${b64(KNEW)}`, CREDENTIAL_ACTIVE_KEY: "new", CREDENTIAL_ALLOW_LOCAL_KEYRING: "true" };
    for (const [env, why] of [[{ ...keyring, DEPLOYMENT_ENV: "production" }, "production_requires_managed_provider"], [{ ...keyring }, "local_keyring_not_allowed"], [{ ...keyring, DEPLOYMENT_ENV: "development", CREDENTIAL_ALLOW_LOCAL_KEYRING: "" }, "local_keyring_not_allowed"]] as const) {
      const rw = await run(w.db, ["rewrap"], env);
      expect([rw.code, rw.lines[0]]).toEqual([1, `No key provider is available (${why}). Nothing was checked or changed.`]);
      expect((await run(w.db, ["probe"], env)).code).toBe(1);
      expect((await run(w.db, ["report"], env)).lines[0]).toBe(`Key provider: none (${why})`);
    }
    expect(w.dump()).toBe(before);
  });

  it("an invalid DEPLOYMENT_ENV stops the command, naming the variable but not the value; a database without the table is refused", async () => {
    const w = await world();
    const r = await run(w.db, ["report"], { DEPLOYMENT_ENV: "Productionish-VALUE" });
    expect(r.code).toBe(2);
    expect(r.lines.join("\n")).toMatch(/DEPLOYMENT_ENV/);
    expect(r.lines.join("\n")).not.toContain("Productionish-VALUE");
    const bare = openDb(":memory:");
    dbs.push(bare);
    const none = await run(bare, ["report"], envFor([["old", KOLD]], "old"));
    expect(none.code).toBe(2);
    expect(none.lines[0]).toContain("no credential table");
  });

  it("never prints a secret, a key, wrapped bytes, workspace names or anything a provider said, even when the provider fails loudly", async () => {
    const w = await world();
    const stage2 = envFor([["old", KOLD], ["new", KNEW]], "new");
    const stored = w.db.prepare("SELECT sealed, wrapped_dek FROM workspace_credentials").all() as Array<{ sealed: Buffer; wrapped_dek: Buffer }>;
    const forbidden = [
      ...w.items.map((i) => i.secret),
      "Ops Fixture One", "Ops Fixture Two", "CANARY-PROVIDER-ERROR",
      ...[KOLD, KNEW].flatMap((k) => [k.toString("hex"), k.toString("base64"), k.toString("base64url")]),
      ...stored.flatMap((r) => [r.sealed, r.wrapped_dek].flatMap((b) => [b.toString("hex"), b.toString("base64")])),
    ];
    const hostile = instrument(bothNewActive(), {
      wrap: async () => { throw new Error(`CANARY-PROVIDER-ERROR ${KNEW.toString("hex")} ${secretOf(1)}`); },
      unwrap: async () => { throw Object.assign(new Error(`CANARY-PROVIDER-ERROR ${KOLD.toString("base64")}`), { cause: secretOf(2) }); },
    }).p;
    const outputs: string[] = [];
    for (const argv of [["report"], ["probe"], ["rewrap"], ["rewrap", "--dry-run"], ["rewrap", "--limit", "2"]]) {
      outputs.push((await run(w.db, argv, stage2)).lines.join("\n"));
      outputs.push((await run(w.db, argv, {}, hostile)).lines.join("\n"));
    }
    const all = outputs.join("\n");
    for (const f of forbidden) expect(all.includes(f), f.slice(0, 24)).toBe(false);
    expect(outputs.every((o) => o.length > 0)).toBe(true);
    // and the audit trail written by failed runs holds only coarse reasons
    const audit = JSON.stringify(w.db.prepare("SELECT detail FROM audit_events WHERE type LIKE 'credential.%'").all());
    for (const f of forbidden) expect(audit.includes(f), f.slice(0, 24)).toBe(false);
  });

  it("shows only ids that look like ids", async () => {
    const w = await world();
    // the unique index allows one live row per workspace and kind: retire the real one first
    w.db.prepare("UPDATE workspace_credentials SET status = 'revoked', sealed = NULL, wrapped_dek = NULL, key_id = NULL WHERE workspace_id = ? AND kind = 'openai'").run(w.w1);
    w.db.prepare("INSERT INTO workspace_credentials (id, workspace_id, kind, version, status, sealed, wrapped_dek, key_id, created_at, created_by, updated_at, updated_by) VALUES ('crd_evil', ?, 'openai', 99, 'active', X'00', X'00', ?, 'x', 'x', 'x', 'x')").run(w.w1, "evil\nINJECTED LINE");
    const r = await run(w.db, ["report"], envFor([["old", KOLD]], "old"));
    expect(r.lines.join("\n")).toContain("(unrecognized id)");
    expect(r.lines.join("\n")).not.toContain("INJECTED LINE");
  });
});

/* ====================================================================================================================
 * conformance checks for key providers
 * ================================================================================================================== */

describe("key provider conformance", () => {
  it("LocalKeyring passes every check, including after a rotation", async () => {
    const results = await checkKeyProvider(oldOnly(), { rotated: bothNewActive() });
    expect(failedChecks(results)).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(12);
    expect(new Set(results.map((r) => r.check)).size).toBe(results.length);
  });

  /** Each faulty provider wraps a correct one and breaks exactly one property. The matching check must fail. */
  const good = () => oldOnly();
  const withFault = (over: Partial<KeyProvider> & { name?: string }): KeyProvider => {
    const g = good();
    return { name: g.name, managed: false, activeKeyId: () => g.activeKeyId(), hasKey: (k) => g.hasKey(k), wrap: (d, c) => g.wrap(d, c), unwrap: (k, w, c) => g.unwrap(k, w, c), ...over };
  };
  const cases: Array<[string, KeyProvider, RegExp]> = [
    ["ignores the context", (() => { const g = good(); return withFault({ wrap: (d) => g.wrap(d, Buffer.alloc(0)), unwrap: (k, w) => g.unwrap(k, w, Buffer.alloc(0)) }); })(), /different context is refused/],
    ["reports the wrong key id", withFault({ wrap: async (d, c) => ({ ...(await good().wrap(d, c)), keyId: "other" }) }), /unwraps to exactly the original/],
    ["wipes the caller's buffer", withFault({ wrap: async (d, c) => { const r = await good().wrap(d, c); d.fill(0); return r; } }), /neither changed nor kept/],
    ["wraps deterministically", (() => { const cache = new Map<string, { keyId: string; wrapped: Buffer }>(); return withFault({ wrap: async (d, c) => { const k = d.toString("hex") + c.toString("hex"); if (!cache.has(k)) cache.set(k, await good().wrap(d, c)); return cache.get(k)!; } }); })(), /wrapping is randomized/],
    ["accepts anything", withFault({ unwrap: async (k, w, c) => { try { return await good().unwrap(k, w, c); } catch { return Buffer.alloc(KEY_BYTES, 7); } } }), /refused/],
    ["throws a generic error for an unknown key", withFault({ unwrap: async (k, w, c) => { if (k === "no-such-key-zzz") throw new Error("nope"); return good().unwrap(k, w, c); } }), /unknown key id is refused/],
    ["leaks context into errors", withFault({ unwrap: async (k, w, c) => { try { return await good().unwrap(k, w, c); } catch (e) { throw new Error(`failed for ${c.toString()}`, { cause: e }); } } }), /never repeat the key, the context/],
    ["lies about holding keys", withFault({ hasKey: () => true }), /hasKey/],
    ["shares one output buffer", (() => { const cache = new Map<string, Buffer>(); return withFault({ unwrap: async (k, w, c) => { const id = w.toString("hex"); if (!cache.has(id)) cache.set(id, await good().unwrap(k, w, c)); return cache.get(id)!; } }); })(), /private copy/],
    ["has an invalid name", withFault({ name: "Bad Name!" }), /declares a name/],
    ["has a non-boolean managed flag", withFault({ managed: "yes" as unknown as boolean }), /declares a name/],
    ["has an invalid key id", withFault({ activeKeyId: () => "Bad Id" }), /valid id/],
    ["returns an empty wrapping", withFault({ wrap: async () => ({ keyId: "old", wrapped: Buffer.alloc(0) }) }), /unwraps to exactly the original/],
  ];
  for (const [what, provider, expected] of cases) {
    it(`detects a provider that ${what}`, async () => {
      const failed = failedChecks(await checkKeyProvider(provider));
      expect(failed.map((f) => f.check).join(" | ")).toMatch(expected);
    });
  }

  it("detects a provider whose wrapping contains the data key in the clear, even though it round-trips and binds the context", async () => {
    const { createHash } = await import("node:crypto");
    const tag = (c: Buffer) => createHash("sha256").update(c).digest();
    const clear = withFault({
      wrap: async (d, c) => ({ keyId: "old", wrapped: Buffer.concat([d, tag(c)]) }),
      unwrap: async (k, w, c) => {
        if (k !== "old") throw new KeyUnavailableError();
        if (w.length !== KEY_BYTES + 32 || !w.subarray(KEY_BYTES).equals(tag(c))) throw new Error("no");
        return Buffer.from(w.subarray(0, KEY_BYTES));
      },
    });
    const failed = failedChecks(await checkKeyProvider(clear));
    expect(failed.map((f) => f.note).join(" | ")).toMatch(/contains the data key in the clear/);
  });

  it("detects a rotated provider that lost the old key or kept the old active key", async () => {
    expect(failedChecks(await checkKeyProvider(oldOnly(), { rotated: newOnly() })).map((f) => f.check)).toEqual(["after rotation: old wrappings still open, new ones use the new key id"]);
    expect(failedChecks(await checkKeyProvider(oldOnly(), { rotated: oldOnly() })).length).toBe(1);
  });

  it("its results carry fixed notes only, never anything a provider said", async () => {
    const leaky = withFault({ unwrap: async () => { throw new Error("CANARY-LEAK-TEXT"); } });
    const throwing = withFault({ wrap: async () => { throw new Error("CANARY-LEAK-TEXT"); } });
    for (const p of [leaky, throwing]) {
      const results = await checkKeyProvider(p);
      expect(failedChecks(results).length).toBeGreaterThan(0);
      expect(JSON.stringify(results)).not.toContain("CANARY-LEAK-TEXT");
    }
  });
});
