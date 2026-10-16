import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A running record of what an experiment has spent, kept on disk across the separate command invocations that make it up.
 * Every invocation checks it BEFORE sending anything and writes to it before, during and after, so that a crash mid-run leaves
 * a pessimistic entry rather than none. It is the aggregate stop line: the per-invocation budget caps one command, this caps all of them.
 */
export interface LedgerEntry {
  label: string;
  arm: string;
  startedAt: string;
  /** started = running or crashed (counted at its full reserve); finished = counted at what was actually charged. */
  status: "started" | "finished";
  /** The most this invocation could charge: its budget plus any access-check allowance. */
  reservedMicros: number;
  /** Requests this invocation intends to send (started) or did send (finished). */
  requests: number;
  chargedMicros?: number;
  accessCheckChargedMicros?: number;
  halted?: string;
  finishedAt?: string;
  /**
   * A person has looked at a halted or unfinished invocation and decided it may be passed. Without this, such an entry blocks
   * every later invocation. The note says why; chargedMicros, if given, replaces the pessimistic charge (an unfinished entry is
   * otherwise counted at its full reserve, a halted one at what it recorded).
   */
  reconciled?: { note: string; at: string; chargedMicros?: number };
}

export interface Ledger {
  experiment: string;
  aggregateCeilingMicros: number;
  maxTotalRequests: number;
  entries: LedgerEntry[];
}

export function loadLedger(path: string, init: { experiment: string; aggregateCeilingMicros: number; maxTotalRequests: number }): Ledger {
  if (!existsSync(path)) return { ...init, entries: [] };
  const l = JSON.parse(readFileSync(path, "utf8")) as Ledger;
  // The limits are fixed when the ledger is created. Passing different ones later must not quietly loosen them.
  if (l.aggregateCeilingMicros !== init.aggregateCeilingMicros || l.maxTotalRequests !== init.maxTotalRequests || l.experiment !== init.experiment) {
    throw new Error(`the ledger ${path} was created for experiment "${l.experiment}" with a ceiling of ${l.aggregateCeilingMicros} micro-USD and ${l.maxTotalRequests} requests; the command asks for different limits. Limits cannot be changed on an existing ledger.`);
  }
  return l;
}

export function saveLedger(path: string, l: Ledger): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(l, null, 2) + "\n");
}

const entryCharge = (e: LedgerEntry): number => e.reconciled?.chargedMicros ?? (e.status === "finished" ? (e.chargedMicros ?? 0) : e.reservedMicros);
export const committedMicros = (l: Ledger): number => l.entries.reduce((s, e) => s + entryCharge(e), 0);
export const committedRequests = (l: Ledger): number => l.entries.reduce((s, e) => s + e.requests, 0);

/** Entries that stop everything until a person reconciles them: a halt, or an invocation that never finished. */
export const blockingEntries = (l: Ledger): LedgerEntry[] => l.entries.filter((e) => (e.halted || e.status === "started") && !e.reconciled);

/** May another invocation start? Not if it could pass the aggregate ceiling or the request cap, or if an earlier one halted or crashed and has not been reconciled. */
export function canStart(l: Ledger, next: { reservedMicros: number; requests: number }): { ok: true } | { ok: false; reason: string } {
  const halted = blockingEntries(l).find((e) => e.halted);
  if (halted) return { ok: false, reason: `an earlier invocation ("${halted.label}") halted: ${halted.halted}. A person must review it and reconcile the ledger (--reconcile "<what you found>") before anything else is sent.` };
  const unfinished = blockingEntries(l).find((e) => e.status === "started");
  if (unfinished) return { ok: false, reason: `an earlier invocation ("${unfinished.label}") never finished (a crash or an interrupt), so what it spent is unknown and is counted at its full reserve. A person must review it and reconcile the ledger (--reconcile "<what you found>") before anything else is sent.` };
  if (committedMicros(l) + next.reservedMicros > l.aggregateCeilingMicros) {
    return { ok: false, reason: `committed ${committedMicros(l)} + this invocation's reserve ${next.reservedMicros} would pass the aggregate ceiling of ${l.aggregateCeilingMicros} micro-USD` };
  }
  if (committedRequests(l) + next.requests > l.maxTotalRequests) {
    return { ok: false, reason: `${committedRequests(l)} requests recorded + ${next.requests} planned would pass the cap of ${l.maxTotalRequests}` };
  }
  return { ok: true };
}

/**
 * Record that a person has reviewed the halted or unfinished invocation(s) and cleared them to be passed. A real explanation is
 * required (not a bare flag). Spend is never reduced implicitly: an unfinished entry keeps its full reserve unless chargedMicros is
 * given, and that is only accepted when exactly one entry is being reconciled.
 */
export function reconcile(l: Ledger, note: string, at: string, chargedMicros?: number): string[] {
  if (note.trim().length < 15) throw new Error("a reconciliation needs a real explanation of at least 15 characters (what was reviewed and why it is safe to continue)");
  const open = blockingEntries(l);
  if (open.length === 0) throw new Error("nothing to reconcile: no invocation is halted or unfinished");
  if (chargedMicros !== undefined && (open.length !== 1 || !Number.isFinite(chargedMicros) || chargedMicros < 0)) throw new Error("--charged-micros needs exactly one entry to reconcile and a non-negative number");
  for (const e of open) e.reconciled = { note: note.trim(), at, ...(chargedMicros !== undefined ? { chargedMicros } : {}) };
  return open.map((e) => e.label);
}
