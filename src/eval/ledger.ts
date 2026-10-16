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

export const committedMicros = (l: Ledger): number => l.entries.reduce((s, e) => s + (e.status === "finished" ? (e.chargedMicros ?? 0) + 0 : e.reservedMicros), 0);
export const committedRequests = (l: Ledger): number => l.entries.reduce((s, e) => s + e.requests, 0);

/** May another invocation start? It may not if it could pass the aggregate ceiling or the request cap, or if an earlier one halted unacknowledged. */
export function canStart(l: Ledger, next: { reservedMicros: number; requests: number }, acknowledgeHalt = false): { ok: true } | { ok: false; reason: string } {
  const halted = l.entries.find((e) => e.halted);
  if (halted && !acknowledgeHalt) return { ok: false, reason: `an earlier invocation ("${halted.label}") halted: ${halted.halted}. Review it, then pass --acknowledge-halt to continue.` };
  const unfinished = l.entries.find((e) => e.status === "started");
  if (unfinished && !acknowledgeHalt) return { ok: false, reason: `an earlier invocation ("${unfinished.label}") never finished (a crash or an interrupt), so what it spent is unknown and is counted at its full reserve. Review it, then pass --acknowledge-halt to continue.` };
  if (committedMicros(l) + next.reservedMicros > l.aggregateCeilingMicros) {
    return { ok: false, reason: `committed ${committedMicros(l)} + this invocation's reserve ${next.reservedMicros} would pass the aggregate ceiling of ${l.aggregateCeilingMicros} micro-USD` };
  }
  if (committedRequests(l) + next.requests > l.maxTotalRequests) {
    return { ok: false, reason: `${committedRequests(l)} requests recorded + ${next.requests} planned would pass the cap of ${l.maxTotalRequests}` };
  }
  return { ok: true };
}
