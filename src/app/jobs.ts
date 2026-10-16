import { iso } from "./core.js";
import type { AppContext } from "./context.js";
import { newId } from "./util.js";

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
  const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
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
