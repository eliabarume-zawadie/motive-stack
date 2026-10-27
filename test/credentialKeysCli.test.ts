/**
 * End-to-end test of the REAL operator entry point (src/credentialKeys.ts), run as a child process.
 *
 * Isolation, all of it checked here:
 *  - the child's working directory is a fresh temporary directory, so the `.env.local` it loads is the one in THAT directory (a decoy,
 *    or none), never the repository's;
 *  - its environment is built from scratch (no inherited variables except what node needs to start), and holds only random throwaway keys;
 *  - the database is a temporary file created and seeded by this test; nothing persistent is opened;
 *  - a preload script makes any network, DNS or fetch attempt throw and leaves a trace; the trace must stay empty.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWorkspace } from "../src/app/workspaces.js";
import { userActor, type AuthzContext } from "../src/auth/authz.js";
import { KEY_BYTES } from "../src/credentials/crypto.js";
import { LocalKeyring } from "../src/credentials/keys.js";
import { CredentialVault, type CredentialKind } from "../src/credentials/vault.js";
import { migrate, openDb } from "../src/db/db.js";

vi.setConfig({ testTimeout: 180_000 });

const REPO = resolve(__dirname, "..");
const TSX = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const ENTRY = join(REPO, "src", "credentialKeys.ts");
const fwd = (p: string) => p.replace(/\\/g, "/");

const KOLD = randomBytes(KEY_BYTES);
const KNEW = randomBytes(KEY_BYTES);
const b64 = (k: Buffer) => k.toString("base64");
const secretOf = (i: number) => `FIXTURE-SECRET-NUMBER-${i}-0123456789abcdef`;

let root: string;
let cwd: string;
let traceFile: string;
let loadedFile: string;
let preload: string;
const now = () => new Date("2026-10-19T12:00:00.000Z");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ms-cli-test-"));
  cwd = join(root, "cwd");
  traceFile = join(root, "network-trace.txt");
  loadedFile = join(root, "preload-loaded.txt");
  preload = join(root, "block-network.cjs");
  require("node:fs").mkdirSync(cwd);
  writeFileSync(
    preload,
    `const fs = require("fs");
const note = (f, w) => { try { fs.appendFileSync(f, w + "\\n"); } catch {} };
note(${JSON.stringify(loadedFile)}, "loaded");
const trace = (w) => note(${JSON.stringify(traceFile)}, w);
const net = require("net");
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) {
  // node passes (options, callback) either directly or as one normalized array; tsx's own child-process plumbing connects to a local pipe path
  const first = Array.isArray(a[0]) ? a[0][0] : a[0];
  const local = typeof first === "string" || (first && typeof first === "object" && typeof first.path === "string" && first.host === undefined && first.port === undefined);
  if (!local) { trace("net.connect"); throw new Error("network blocked"); }
  return connect.apply(this, a);
};
const dns = require("dns");
dns.lookup = function () { trace("dns.lookup"); throw new Error("network blocked"); };
dns.promises.lookup = async function () { trace("dns.promises.lookup"); throw new Error("network blocked"); };
globalThis.fetch = async function () { trace("fetch"); throw new Error("network blocked"); };
for (const m of ["http", "https"]) { const mod = require(m); mod.request = mod.get = function () { trace(m); throw new Error("network blocked"); }; }
`,
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A fresh temporary database with two workspaces and five live credentials wrapped under the given key set. */
async function seedDb(name: string, journal: "wal" | "delete" = "wal") {
  const file = join(root, name);
  const db = openDb(file);
  migrate(db);
  const core = { db, now };
  const w1 = createWorkspace(core, "CLI Fixture One").workspace.id;
  const w2 = createWorkspace(core, "CLI Fixture Two").workspace.id;
  const vault = new CredentialVault(core, new LocalKeyring({ old: KOLD }, "old"));
  const az = (workspaceId: string): AuthzContext => ({ workspaceId, role: "owner", actor: userActor("usr_cli") });
  const items: Array<{ ws: string; kind: CredentialKind; secret: string }> = [
    { ws: w1, kind: "openai", secret: secretOf(1) }, { ws: w1, kind: "anthropic", secret: secretOf(2) }, { ws: w1, kind: "ghl", secret: secretOf(3) },
    { ws: w2, kind: "openai", secret: secretOf(4) }, { ws: w2, kind: "meta_graph", secret: secretOf(5) },
  ];
  for (const it of items) await vault.store(az(it.ws), { kind: it.kind, secret: it.secret });
  if (journal === "delete") db.pragma("journal_mode = DELETE");
  else db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  return { file, items };
}

/** Everything that could change, read through a separate read-only connection. */
function snapshot(file: string) {
  const db = openDb(file, { readonly: true });
  try {
    return JSON.stringify({
      credentials: db.prepare("SELECT * FROM workspace_credentials ORDER BY id").all(),
      audit: db.prepare("SELECT COUNT(*) n FROM audit_events").get(),
    });
  } finally {
    db.close();
  }
}
/** The database file itself, byte for byte, plus the size of its write-ahead log. A read-only SQLite connection to a WAL database may leave an EMPTY -wal and a small -shm index beside it; it must never change the database file or leave log content. */
const fileState = (file: string) => ({
  sha: createHash("sha256").update(readFileSync(file)).digest("hex"),
  wal: existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0,
});
const keyIdCounts = (file: string) => {
  const db = openDb(file, { readonly: true });
  try {
    return Object.fromEntries((db.prepare("SELECT key_id, COUNT(*) n FROM workspace_credentials WHERE status = 'active' GROUP BY key_id").all() as Array<{ key_id: string; n: number }>).map((r) => [r.key_id, r.n]));
  } finally {
    db.close();
  }
};

const keyring = (ids: Array<[string, Buffer]>, active: string, over: Record<string, string> = {}): Record<string, string> => ({
  DEPLOYMENT_ENV: "test",
  CREDENTIAL_ALLOW_LOCAL_KEYRING: "true",
  CREDENTIAL_KEYRING: ids.map(([i, k]) => `${i}:${b64(k)}`).join(","),
  CREDENTIAL_ACTIVE_KEY: active,
  ...over,
});
const OLD = keyring([["old", KOLD]], "old");
const ROTATED = keyring([["old", KOLD], ["new", KNEW]], "new");
const NEW_ONLY = keyring([["new", KNEW]], "new");

interface Run { code: number | null; out: string; err: string }
/** Runs the real entry point. The environment is built from scratch: nothing is inherited from this process. */
function cli(args: string[], env: Record<string, string>, opts: { cwd?: string; block?: boolean } = {}): Run {
  const base: Record<string, string> = {};
  for (const k of ["PATH", "Path", "SystemRoot", "windir", "TEMP", "TMP", "TMPDIR", "ComSpec"]) if (process.env[k]) base[k] = process.env[k]!;
  const r = spawnSync(process.execPath, [TSX, ENTRY, ...args], {
    cwd: opts.cwd ?? cwd,
    env: { ...base, ...(opts.block === false ? {} : { NODE_OPTIONS: `--require=${fwd(preload)}` }), ...env },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const forbiddenFor = (file: string, items: Array<{ secret: string }>): string[] => {
  const db = openDb(file, { readonly: true });
  const rows = db.prepare("SELECT sealed, wrapped_dek FROM workspace_credentials WHERE sealed IS NOT NULL").all() as Array<{ sealed: Buffer; wrapped_dek: Buffer }>;
  db.close();
  return [
    ...items.map((i) => i.secret),
    "CLI Fixture One", "CLI Fixture Two",
    ...[KOLD, KNEW].flatMap((k) => [k.toString("hex"), k.toString("base64"), k.toString("base64url")]),
    ...rows.flatMap((r) => [r.sealed, r.wrapped_dek].flatMap((b) => [b.toString("hex"), b.toString("base64")])),
  ];
};
const noLeak = (runs: Run[], forbidden: string[]) => {
  const all = runs.map((r) => `${r.out}\n${r.err}`).join("\n");
  for (const f of forbidden) expect(all.includes(f), `output contains ${f.slice(0, 20)}...`).toBe(false);
};

describe("the network blocker used for these runs", () => {
  it("really stops and records network attempts (so an empty trace later means something)", () => {
    const r = spawnSync(process.execPath, ["-e", "fetch('https://example.invalid/').catch(()=>{}); require('dns').lookup('example.invalid',()=>{})"], {
      cwd, env: { NODE_OPTIONS: `--require=${fwd(preload)}`, PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" }, encoding: "utf8", timeout: 60_000,
    });
    expect(r.status === 0 || r.status === 1).toBe(true);
    const trace = existsSync(traceFile) ? readFileSync(traceFile, "utf8") : "";
    expect(trace).toMatch(/fetch/);
    rmSync(traceFile, { force: true });
    rmSync(loadedFile, { force: true });
  });
});

describe("the read-only database opener the CLI relies on", () => {
  it("lets SQLite itself refuse every write, and never creates a file that is missing", async () => {
    const { file } = await seedDb("ro-opener.db");
    const db = openDb(file, { readonly: true });
    expect(() => db.prepare("UPDATE workspace_credentials SET label = 'x'").run()).toThrow(/readonly/i);
    expect(() => db.exec("CREATE TABLE sneaky (x INTEGER)")).toThrow(/readonly/i);
    expect(() => db.prepare("DELETE FROM audit_events").run()).toThrow(/readonly/i);
    expect(db.prepare("SELECT COUNT(*) n FROM workspace_credentials").get()).toEqual({ n: 5 }); // reads work
    db.close();
    const missing = join(root, "ro-missing", "none.db");
    expect(() => openDb(missing, { readonly: true })).toThrow();
    expect(existsSync(join(root, "ro-missing"))).toBe(false);
  });
});

describe("credentialKeys CLI (real entry point, isolated)", () => {
  it("rejects a wrong command line with exit 2 and a usage message on stderr, without opening or creating any database", () => {
    const missing = join(root, "never-created", "x.db");
    for (const args of [[], ["nope"], ["report", "--dry-run"], ["rewrap", "--limit"], ["rewrap", "--limit", "0"], ["rewrap", "--limit", "abc"], ["rewrap", "--force"], ["probe", "--limit", "2"], ["rewrap", "--provider", "managed"]]) {
      const r = cli(args, { ...ROTATED, DATABASE_PATH: missing });
      expect([args.join(" "), r.code, r.out]).toEqual([args.join(" "), 2, ""]);
      expect(r.err).toMatch(/Usage: credentialKeys/);
      expect(r.err).not.toContain(b64(KNEW));
    }
    expect(existsSync(join(root, "never-created"))).toBe(false);
  });

  it("database problems fail safely with exit 2, a fixed message on stderr, and nothing created or changed", async () => {
    // no file at the configured path
    const gone = join(root, "no-such-dir", "gone.db");
    const a = cli(["report"], { ...ROTATED, DATABASE_PATH: gone });
    expect([a.code, a.out]).toEqual([2, ""]);
    expect(a.err).toContain("No database was found");
    expect(existsSync(join(root, "no-such-dir"))).toBe(false);
    // a file that is not a database
    const junk = join(root, "junk.db");
    writeFileSync(junk, "this is not a sqlite file, and it contains PLANTED-CONTENT");
    const before = readFileSync(junk);
    const b = cli(["rewrap"], { ...ROTATED, DATABASE_PATH: junk });
    expect([b.code, b.out]).toEqual([2, ""]);
    expect(b.err.trim()).toBe("The database could not be opened. Nothing was changed.");
    expect(readFileSync(junk).equals(before)).toBe(true);
    expect(b.err).not.toContain(junk);
    expect(b.err).not.toContain("PLANTED-CONTENT");
    // a real database that never had the credential table
    const bare = join(root, "bare.db");
    const bareDb = openDb(bare);
    bareDb.exec("CREATE TABLE unrelated (x INTEGER)");
    bareDb.pragma("wal_checkpoint(TRUNCATE)");
    bareDb.close();
    const beforeBare = fileState(bare);
    const c = cli(["report"], { ...ROTATED, DATABASE_PATH: bare });
    expect([c.code, c.out]).toEqual([2, ""]);
    expect(c.err).toContain("no credential table");
    expect(fileState(bare)).toEqual({ ...beforeBare, wal: 0 }); // the database file is byte-identical and no log content was left
  });

  it("report is read-only: exit 0, results on stdout, nothing on stderr, no data change, no journal-mode change, no leak", async () => {
    const { file, items } = await seedDb("report.db", "delete"); // a rollback-journal database: opening it for writing would convert it to WAL
    const before = snapshot(file);
    const files = readdirSync(root).filter((f) => f.startsWith("report.db")).sort();
    const r = cli(["report"], { ...OLD, DATABASE_PATH: file });
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toContain("Key provider: local_keyring (not a managed key service)");
    expect(r.out).toContain("Live credentials: 5; needing a rewrap: 0; depending on a key the server does not hold: 0");
    expect(snapshot(file)).toBe(before);
    expect(readdirSync(root).filter((f) => f.startsWith("report.db")).sort()).toEqual(files);
    const check = openDb(file, { readonly: true });
    expect(check.pragma("journal_mode", { simple: true })).toBe("delete");
    check.close();
    noLeak([r], forbiddenFor(file, items));
  });

  it("probe and a dry run are enforced read-only by the database itself: a rollback-journal database is not converted, byte for byte", async () => {
    const { file } = await seedDb("readonly-enforced.db", "delete");
    const before = fileState(file);
    const rows = snapshot(file);
    for (const args of [["probe"], ["rewrap", "--dry-run"], ["report"]]) {
      const r = cli(args, { ...ROTATED, DATABASE_PATH: file });
      expect([args.join(" "), r.code, r.err]).toEqual([args.join(" "), 0, ""]);
    }
    expect(fileState(file)).toEqual(before);
    expect(snapshot(file)).toBe(rows);
    const check = openDb(file, { readonly: true });
    expect(check.pragma("journal_mode", { simple: true })).toBe("delete"); // a writable open would have switched it to WAL
    check.close();
    expect(readdirSync(root).filter((f) => f.startsWith("readonly-enforced.db")).sort()).toEqual(["readonly-enforced.db"]); // no sidecar files either
    // and a real rewrap, which does write, is the only command that opens it for writing
    const real = cli(["rewrap"], { ...ROTATED, DATABASE_PATH: file });
    expect(real.code).toBe(0);
    expect(keyIdCounts(file)).toEqual({ new: 5 });
  });

  it("probe checks key availability without decrypting any secret, and changes nothing", async () => {
    const { file, items } = await seedDb("probe.db");
    // damage one stored secret: a command that decrypted secrets would notice; a key-only probe cannot
    const db = openDb(file);
    db.prepare("UPDATE workspace_credentials SET sealed = X'00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF' WHERE id = (SELECT id FROM workspace_credentials ORDER BY id LIMIT 1)").run();
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    const before = snapshot(file);
    const beforeFile = fileState(file);
    const ok = cli(["probe"], { ...ROTATED, DATABASE_PATH: file });
    expect([ok.code, ok.err]).toEqual([0, ""]);
    expect(ok.out).toContain("Checked 5 live credential(s): 5 data key(s) unwrapped, 0 failed.");
    const missing = cli(["probe"], { ...NEW_ONLY, DATABASE_PATH: file });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("5 failed (master key not available: 5)");
    expect(snapshot(file)).toBe(before);
    expect(fileState(file)).toEqual(beforeFile);
    noLeak([ok, missing], forbiddenFor(file, items));
  });

  it("a dry run exercises the provider but persists nothing; a limited rewrap moves some, and runs can be resumed to completion", async () => {
    const { file, items } = await seedDb("rotate.db");
    const original = snapshot(file);
    const originalFile = fileState(file);
    const runs: Run[] = [];
    const run = (args: string[]) => { const r = cli(args, { ...ROTATED, DATABASE_PATH: file }); runs.push(r); return r; };

    const report = run(["report"]);
    expect([report.code, report.err]).toEqual([0, ""]);
    expect(report.out).toContain("needing a rewrap: 5");
    expect(run(["probe"]).code).toBe(0);
    const dry = run(["rewrap", "--dry-run"]);
    expect([dry.code, dry.err]).toEqual([0, ""]);
    expect(dry.out).toContain("Dry run: 5 credential(s) would be rewrapped under new");
    expect(dry.out).toContain("Nothing was written.");
    expect(snapshot(file)).toBe(original); // report, probe and the dry run left the database exactly as it was
    expect(fileState(file)).toEqual(originalFile); // ...down to the bytes of the file, with an empty log

    const first = run(["rewrap", "--limit", "2"]);
    expect([first.code, first.err]).toEqual([0, ""]);
    expect(first.out).toContain("Rewrapped 2 credential(s) under new");
    expect(first.out).toContain("Still on an older master key: 3.");
    expect(first.out).toContain("Run again to continue");
    expect(keyIdCounts(file)).toEqual({ new: 2, old: 3 });

    const second = run(["rewrap", "--limit", "2"]);
    expect(second.out).toContain("Rewrapped 2 credential(s)");
    expect(keyIdCounts(file)).toEqual({ new: 4, old: 1 });

    const rest = run(["rewrap"]);
    expect([rest.code, rest.err]).toEqual([0, ""]);
    expect(rest.out).toContain("Rewrapped 1 credential(s)");
    expect(rest.out).toContain("Every live credential is now under the active key.");
    expect(keyIdCounts(file)).toEqual({ new: 5 });

    const again = run(["rewrap"]);
    expect(again.out).toContain("Rewrapped 0 credential(s)");
    expect(again.code).toBe(0);

    // the work is real: with ONLY the new key, every credential still decrypts to its original value
    const db = openDb(file);
    const vault = new CredentialVault({ db, now }, new LocalKeyring({ new: KNEW }, "new"));
    for (const it of items) expect(await vault.use(it.ws, it.kind, (s) => s.toString("utf8"))).toBe(it.secret);
    expect((db.prepare("SELECT COUNT(*) n FROM audit_events WHERE type = 'credential.rewrapped'").get() as { n: number }).n).toBe(5);
    db.close();
    noLeak(runs, forbiddenFor(file, items));
  });

  it("a missing key is reported with exit 1 and changes nothing; the failed credentials keep working under the old key", async () => {
    const { file, items } = await seedDb("missing.db");
    const before = snapshot(file);
    const report = cli(["report"], { ...NEW_ONLY, DATABASE_PATH: file });
    expect(report.code).toBe(1);
    expect(report.out).toContain("PROBLEM:");
    expect(report.err).toBe("");
    const rewrap = cli(["rewrap"], { ...NEW_ONLY, DATABASE_PATH: file });
    expect(rewrap.code).toBe(1);
    expect(rewrap.out).toMatch(/5 failed \(master key not available: 5\)/);
    expect(rewrap.out).toContain("left exactly as they were");
    const dbAfter = openDb(file);
    const stillOld = new CredentialVault({ db: dbAfter, now }, new LocalKeyring({ old: KOLD }, "old"));
    for (const it of items) expect(await stillOld.use(it.ws, it.kind, (s) => s.toString("utf8"))).toBe(it.secret);
    dbAfter.close();
    expect(keyIdCounts(file)).toEqual({ old: 5 });
    expect(snapshot(file).replace(/"audit":\{"n":\d+\}/, "")).toBe(before.replace(/"audit":\{"n":\d+\}/, "")); // only audit rows (failure records) may differ
    noLeak([report, rewrap], forbiddenFor(file, items));
  });

  it("the active key missing from the keyring is a configuration error (exit 2, stderr), and no key material is printed", async () => {
    const { file, items } = await seedDb("active.db");
    const r = cli(["rewrap"], { ...keyring([["old", KOLD]], "zzz"), DATABASE_PATH: file });
    expect([r.code, r.out]).toEqual([2, ""]);
    expect(r.err).toMatch(/CREDENTIAL_ACTIVE_KEY/);
    noLeak([r], forbiddenFor(file, items));
    expect(keyIdCounts(file)).toEqual({ old: 5 });
  });

  it("the production guard cannot be bypassed from the command line: no provider, nothing checked or changed", async () => {
    const { file, items } = await seedDb("prod.db");
    const before = snapshot(file);
    const cases: Array<[string, Record<string, string>, string]> = [
      ["production with a keyring and the opt-in", { ...ROTATED, DEPLOYMENT_ENV: "production" }, "production_requires_managed_provider"],
      ["DEPLOYMENT_ENV unset", (() => { const e = { ...ROTATED }; delete (e as Record<string, string | undefined>).DEPLOYMENT_ENV; return e; })(), "local_keyring_not_allowed"],
      ["development without the opt-in", { ...ROTATED, DEPLOYMENT_ENV: "development", CREDENTIAL_ALLOW_LOCAL_KEYRING: "" }, "local_keyring_not_allowed"],
    ];
    const runs: Run[] = [];
    for (const [what, env, why] of cases) {
      for (const cmd of ["rewrap", "probe"]) {
        const r = cli([cmd], { ...env, DATABASE_PATH: file });
        runs.push(r);
        expect([what, cmd, r.code, r.out]).toEqual([what, cmd, 1, ""]);
        expect(r.err).toContain(`No key provider is available (${why}). Nothing was checked or changed.`);
      }
      const rep = cli(["report"], { ...env, DATABASE_PATH: file });
      runs.push(rep);
      expect(rep.out).toContain(`Key provider: none (${why})`);
      expect(rep.code).toBe(1);
    }
    // an invalid value stops the command, naming the variable and never the value
    const bad = cli(["report"], { ...ROTATED, DEPLOYMENT_ENV: "Prod-VALUE-123", DATABASE_PATH: file });
    runs.push(bad);
    expect([bad.code, bad.out]).toEqual([2, ""]);
    expect(bad.err).toContain("DEPLOYMENT_ENV");
    expect(bad.err).not.toContain("Prod-VALUE-123");
    expect(snapshot(file)).toBe(before);
    noLeak(runs, forbiddenFor(file, items));
  });

  it("loads .env.local from its own working directory only, which is how these runs stay clear of the repository's", async () => {
    const { file } = await seedDb("decoy.db");
    const own = join(root, "cwd-with-decoy");
    require("node:fs").mkdirSync(own);
    // a decoy that, if (and only if) it is read, turns the guard to production
    writeFileSync(join(own, ".env.local"), "DEPLOYMENT_ENV=production\n");
    const withDecoy = cli(["report"], { ...Object.fromEntries(Object.entries(ROTATED).filter(([k]) => k !== "DEPLOYMENT_ENV")), DATABASE_PATH: file }, { cwd: own });
    expect(withDecoy.out).toContain("Key provider: none (production_requires_managed_provider)");
    const without = cli(["report"], { ...ROTATED, DATABASE_PATH: file }, { cwd });
    expect(without.out).toContain("Key provider: local_keyring");
    expect(existsSync(join(cwd, ".env.local"))).toBe(false);
    expect(resolve(cwd).startsWith(resolve(REPO))).toBe(false); // the working directory is outside the repository
    const source = readFileSync(ENTRY, "utf8");
    expect([...source.matchAll(/"(\.env[^"]*)"/g)].map((m) => m[1])).toEqual([".env.local"]); // the only file name it ever refers to, resolved against the cwd
  });

  it("makes no network, DNS or fetch attempt in any of the runs above", () => {
    expect(existsSync(loadedFile)).toBe(true); // the blocker really was loaded into the CLI runs
    expect(readFileSync(loadedFile, "utf8").trim().split("\n").length).toBeGreaterThan(5);
    const trace = existsSync(traceFile) ? readFileSync(traceFile, "utf8") : "";
    expect(trace).toBe("");
  });
});
