import { audit, iso } from "./core.js";
import { conflict, notFound } from "./errors.js";
import type { AppContext } from "./context.js";
import { newId, safeError } from "./util.js";

export interface Job {
  id: string;
  workspaceId: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

/** Throw from a handler to say "nothing irreversible happened; retry later". */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

interface JobRow {
  id: string;
  workspace_id: string;
  type: string;
  payload: string;
  attempts: number;
  max_attempts: number;
}

/** Persistent, de-duplicated queue. A second enqueue with the same dedupe key is ignored. Returns true if newly queued. */
export function enqueueJob(c: AppContext, wsId: string, type: string, payload: unknown, dedupeKey: string): boolean {
  const at = iso(c);
  const r = c.db
    .prepare(
      `INSERT OR IGNORE INTO jobs (id, workspace_id, type, payload, dedupe_key, status, attempts, max_attempts, run_at, created_at, updated_at)
       VALUES (?,?,?,?,?,'queued',0,?,?,?,?)`,
    )
    .run(newId("job"), wsId, type, JSON.stringify(payload), dedupeKey, c.jobMaxAttempts, at, at, at);
  return r.changes === 1;
}

export function claimJob(c: AppContext): Job | null {
  const at = iso(c);
  const r = c.db
    .prepare(
      `UPDATE jobs SET status = 'running', locked_at = ?, attempts = attempts + 1, updated_at = ?
       WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= ? ORDER BY run_at, created_at LIMIT 1)
       RETURNING *`,
    )
    .get(at, at, at) as JobRow | undefined;
  if (!r) return null;
  return { id: r.id, workspaceId: r.workspace_id, type: r.type, payload: JSON.parse(r.payload), attempts: r.attempts, maxAttempts: r.max_attempts };
}

export function completeJob(c: AppContext, id: string): void {
  c.db.prepare("UPDATE jobs SET status = 'done', locked_at = NULL, updated_at = ? WHERE id = ?").run(iso(c), id);
}

/** Retry with exponential backoff, or mark dead after the last attempt. */
export function failJob(c: AppContext, job: Job, err: unknown): "retry" | "dead" {
  const msg = safeError(err, 500);
  const dead = job.attempts >= job.maxAttempts;
  const runAt = new Date(c.now().getTime() + c.backoffMs(job.attempts)).toISOString();
  c.db
    .prepare("UPDATE jobs SET status = ?, locked_at = NULL, last_error = ?, run_at = ?, updated_at = ? WHERE id = ?")
    .run(dead ? "dead" : "queued", msg, runAt, iso(c), job.id);
  return dead ? "dead" : "retry";
}

/** After a crash/restart, jobs left "running" are orphaned. Re-queue them; handlers are idempotent. */
export function recoverOrphanedJobs(c: AppContext): number {
  return c.db.prepare("UPDATE jobs SET status = 'queued', locked_at = NULL, updated_at = ? WHERE status = 'running'").run(iso(c)).changes;
}

/** Job types a person may re-queue after they gave up: the handler is idempotent (the lead and its CRM sync are stored once). Never an execution job. */
export const RETRYABLE_JOB_TYPES = ["process_lead"];
export const MAX_MANUAL_RETRIES = 2;

export function jobRetryState(r: { type: string; status: string; manual_retries: number }): { eligible: boolean; reason: string } {
  if (r.status !== "dead") return { eligible: false, reason: r.status === "done" ? "Completed: nothing to retry." : "Not failed: the worker is still handling it." };
  if (!RETRYABLE_JOB_TYPES.includes(r.type)) return { eligible: false, reason: "Not retried from here: its result may be unconfirmed outside this app. Open the proposal and follow its recovery steps." };
  if (r.manual_retries >= MAX_MANUAL_RETRIES) return { eligible: false, reason: "Retried " + MAX_MANUAL_RETRIES + " times already. Check the cause before trying again." };
  return { eligible: true, reason: "Safe to retry: it will not create a duplicate." };
}

/** Put one job that gave up back in the queue, at most MAX_MANUAL_RETRIES times. Audited with the server-derived actor. */
export function retryDeadJob(c: AppContext, wsId: string, jobId: string, actor: string): { status: string; manualRetries: number } {
  const r = c.db.prepare("SELECT id, type, status, manual_retries FROM jobs WHERE id = ? AND workspace_id = ?").get(jobId, wsId) as { id: string; type: string; status: string; manual_retries: number } | undefined;
  if (!r) throw notFound("Job");
  const s = jobRetryState(r);
  if (!s.eligible) throw conflict("job_not_retryable", s.reason);
  const res = c.db.prepare("UPDATE jobs SET status = 'queued', attempts = 0, locked_at = NULL, run_at = ?, updated_at = ?, manual_retries = manual_retries + 1 WHERE id = ? AND workspace_id = ? AND status = 'dead' AND manual_retries < ?")
    .run(iso(c), iso(c), jobId, wsId, MAX_MANUAL_RETRIES);
  if (res.changes !== 1) throw conflict("job_not_retryable", "This job changed while you were looking at it. Reload and check its state.");
  audit(c, wsId, actor, "job.retried", "job", jobId, { type: r.type, manualRetries: r.manual_retries + 1 });
  return { status: "queued", manualRetries: r.manual_retries + 1 };
}

export type JobHandler = (c: AppContext, job: Job) => Promise<void>;

export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly c: AppContext,
    private readonly handlers: Record<string, JobHandler>,
  ) {}

  /** Process every currently-due job. Returns how many ran. */
  async runUntilIdle(max = 200): Promise<number> {
    let n = 0;
    while (n < max) {
      const job = claimJob(this.c);
      if (!job) break;
      n++;
      const h = this.handlers[job.type];
      try {
        if (!h) throw new Error(`No handler for job type "${job.type}"`);
        await h(this.c, job);
        completeJob(this.c, job.id);
      } catch (e) {
        failJob(this.c, job, e);
      }
    }
    return n;
  }

  /** Start background polling. Recovers orphaned jobs first. */
  start(intervalMs = 500): void {
    recoverOrphanedJobs(this.c);
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.runUntilIdle();
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
