import type { Db } from "../db/db.js";
import { KeyUnavailableError, type KeyProvider } from "./keys.js";
import { selectKeyProvider, type KeySelectionReason } from "./provider.js";
import { CredentialVault } from "./vault.js";

/**
 * Operator tooling for master keys: a read-only dependency report, a probe that checks every live credential's data key can still be
 * unwrapped, and a safe, resumable rewrap. All of it works through the existing vault and key-provider abstractions.
 *
 * What it never does: decrypt or print a secret, print a key or a wrapped key, generate master key material, change a provider's
 * configuration, or write anything except the re-wrapped key of a record. Output holds only fixed text, numbers and key IDS (and only
 * ids that look like ids). Nothing from a provider's error message is ever repeated.
 */

export interface KeyReport {
  provider: string | null;
  managed: boolean | null;
  /** Why there is (or is not) a provider. */
  providerState: KeySelectionReason;
  activeKeyId: string | null;
  totalActive: number;
  /** Live credentials wrapped under a key other than the active one: what a rewrap would move. */
  needsRewrap: number;
  /** Live credentials that depend on a master key the provider does not hold (they cannot be read until it is restored). */
  unreadable: number;
  keys: Array<{ keyId: string; credentials: number; active: boolean; available: boolean | null; retirable: boolean }>;
}

const ID = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const shown = (id: string | null): string => (id !== null && ID.test(id) ? id : id === null ? "(none)" : "(unrecognized id)");

/** Read-only. Asks the provider only whether it holds a key (hasKey); never unwraps anything. */
export function buildKeyReport(vault: CredentialVault, providerState: KeySelectionReason): KeyReport {
  const deps = vault.keyDependencies();
  const active = vault.activeKeyId;
  const keys = deps.map((d) => ({ keyId: d.keyId, credentials: d.credentials, active: d.keyId === active, available: d.available, retirable: vault.canRetire(d.keyId) }));
  return {
    provider: vault.providerName,
    managed: vault.managedProvider,
    providerState,
    activeKeyId: active,
    totalActive: keys.reduce((n, k) => n + k.credentials, 0),
    needsRewrap: keys.filter((k) => !k.active).reduce((n, k) => n + k.credentials, 0),
    unreadable: keys.filter((k) => k.available === false).reduce((n, k) => n + k.credentials, 0),
    keys,
  };
}

export function formatKeyReport(r: KeyReport): string[] {
  const out: string[] = [];
  out.push(`Key provider: ${r.provider === null ? `none (${r.providerState})` : `${r.provider}${r.managed ? " (managed)" : " (not a managed key service)"}`}`);
  out.push(`Active master key: ${shown(r.activeKeyId)}`);
  out.push(`Live credentials: ${r.totalActive}; needing a rewrap: ${r.needsRewrap}; depending on a key the server does not hold: ${r.unreadable}`);
  for (const k of r.keys) {
    out.push(`  key ${shown(k.keyId)}: ${k.credentials} credential(s); ${k.active ? "ACTIVE; " : ""}${k.available === null ? "availability unknown" : k.available ? "held by the provider" : "NOT held by the provider"}; ${k.retirable ? "can be retired" : "cannot be retired yet"}`);
  }
  if (r.keys.length === 0) out.push("  (no live credentials depend on any key)");
  return out;
}

export interface KeyCommandOptions {
  /** report | probe | rewrap, then flags. */
  argv: string[];
  env: Record<string, string | undefined>;
  db: Db;
  now?: () => Date;
  /** Tests (and later an approved managed adapter) supply a provider in code; otherwise the guarded selection from the environment is used. */
  keyProvider?: KeyProvider | null;
}
export interface KeyCommandResult {
  /** 0 ok; 1 the check found a problem (or the provider is missing); 2 the command itself was wrong or could not run. */
  code: 0 | 1 | 2;
  lines: string[];
  /** True when the lines are an error message (for stderr) rather than a result (for stdout). */
  stderr: boolean;
}

export type ParsedKeyArgs = { ok: true; command: "report" | "probe" | "rewrap"; dryRun: boolean; limit?: number; writes: boolean } | { ok: false; result: KeyCommandResult };

const USAGE = [
  "Usage: credentialKeys <report | probe | rewrap> [--dry-run] [--limit N]",
  "  report   read-only: which master keys live credentials depend on, and whether the provider still holds them",
  "  probe    asks the provider to unwrap every live credential's data key (the secret is never decrypted); changes nothing",
  "  rewrap   moves live credentials from older master keys to the active one; safe to stop and run again",
  "           --dry-run  do everything except the write       --limit N  examine at most N credentials in this run",
];
const FAIL_WORDS: Record<string, string> = { key_unavailable: "master key not available", authentication_failed: "could not be authenticated", busy: "database busy", provider_error: "provider error" };
const reasonText = (r: Record<string, number>): string =>
  Object.entries(r)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, n]) => `${FAIL_WORDS[k] ?? "other"}: ${n}`)
    .join("; ");

const failure = (code: 1 | 2, ...lines: string[]): KeyCommandResult => ({ code, lines, stderr: true });

/** Validates the command line without touching anything. `writes` says whether the command may change the database. */
export function parseKeyArgs(argv: string[]): ParsedKeyArgs {
  const [command, ...rest] = argv;
  if (command !== "report" && command !== "probe" && command !== "rewrap") return { ok: false, result: failure(2, ...USAGE) };
  let dryRun = false;
  let limit: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--dry-run" && command === "rewrap") dryRun = true;
    else if (a === "--limit" && command === "rewrap") {
      const v = rest[++i];
      if (!v || !/^[1-9][0-9]{0,8}$/.test(v)) return { ok: false, result: failure(2, "--limit needs a positive whole number", ...USAGE) };
      limit = Number(v);
    } else return { ok: false, result: failure(2, `Unknown option for ${command}`, ...USAGE) };
  }
  return { ok: true, command, dryRun, limit, writes: command === "rewrap" && !dryRun };
}

export async function executeKeyCommand(o: KeyCommandOptions): Promise<KeyCommandResult> {
  const parsed = parseKeyArgs(o.argv);
  if (!parsed.ok) return parsed.result;
  const { command, dryRun, limit } = parsed;

  let selection: { provider: KeyProvider | null; reason: KeySelectionReason };
  try {
    selection = o.keyProvider !== undefined ? selectKeyProvider(o.env, o.keyProvider) : selectKeyProvider(o.env);
  } catch (e) {
    // Configuration errors name the variable and never its value (see deployment.ts and keys.ts).
    return failure(2, `Configuration error: ${(e as Error).message}`);
  }
  const present = o.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_credentials'").get();
  if (!present) return failure(2, "This database has no credential table. Run the server once against it so migrations apply, then retry.");
  const vault = new CredentialVault({ db: o.db, now: o.now ?? (() => new Date()) }, selection.provider);

  if (command === "report") {
    const r = buildKeyReport(vault, selection.reason);
    const lines = formatKeyReport(r);
    if (r.unreadable > 0) lines.push("PROBLEM: some credentials depend on a master key the provider does not hold. Restore that key; never delete a master key while credentials depend on it.");
    return { code: r.unreadable > 0 ? 1 : 0, lines, stderr: false };
  }

  if (!vault.available) {
    return failure(1, `No key provider is available (${selection.reason}). Nothing was checked or changed.`, "Production never uses a local keyring; an approved managed key provider is required there.");
  }

  try {
    if (command === "probe") {
      const p = await vault.probeKeys();
      const lines = [`Checked ${p.checked} live credential(s): ${p.ok} data key(s) unwrapped, ${p.failed} failed${p.failed ? ` (${reasonText(p.byReason)})` : ""}.`];
      for (const k of p.byKey) lines.push(`  key ${shown(k.keyId)}: ${k.ok} ok, ${k.failed} failed`);
      return { code: p.failed > 0 ? 1 : 0, lines, stderr: false };
    }
    const r = await vault.rewrap({ dryRun, limit });
    const lines = [
      dryRun
        ? `Dry run: ${r.wouldRewrap} credential(s) would be rewrapped under ${shown(vault.activeKeyId)}; ${r.skipped} skipped; ${r.failed} could not be (${r.failed ? reasonText(r.failures) : "none"}). Nothing was written.`
        : `Rewrapped ${r.rewrapped} credential(s) under ${shown(vault.activeKeyId)}; ${r.skipped} skipped (changed meanwhile); ${r.failed} failed${r.failed ? ` (${reasonText(r.failures)})` : ""}.`,
      `Still on an older master key: ${r.remaining}.`,
    ];
    if (r.failed > 0) lines.push("Failed credentials were left exactly as they were and still work under their old key. Fix the cause (usually a missing key) and run again.");
    else if (r.remaining > 0 && !dryRun) lines.push("Run again to continue (a --limit was reached, or credentials changed during the run).");
    else if (r.remaining === 0 && !dryRun) lines.push("Every live credential is now under the active key. Re-run 'report' before retiring an old key.");
    return { code: r.failed > 0 ? 1 : 0, lines, stderr: false };
  } catch (e) {
    if (e instanceof KeyUnavailableError) return failure(1, "The key provider could not be used. Nothing was changed.");
    return failure(1, "The operation could not complete. Nothing further was changed."); // fixed text: nothing from the error is repeated
  }
}
