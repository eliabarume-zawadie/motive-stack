import { z } from "zod";
import type { AppContext } from "./context.js";
import { executeProposal } from "./executor.js";
import { Worker } from "./jobs.js";
import { processLeadEvent } from "./leads.js";

const ExecutePayload = z.object({ proposalId: z.string() });
const LeadPayload = z.object({ leadEventId: z.string() });

export function createWorker(c: AppContext): Worker {
  return new Worker(c, {
    execute_proposal: async (ctx, job) => executeProposal(ctx, job.workspaceId, ExecutePayload.parse(job.payload).proposalId),
    process_lead: async (ctx, job) =>
      processLeadEvent(ctx, job.workspaceId, LeadPayload.parse(job.payload).leadEventId, { attempts: job.attempts, maxAttempts: job.maxAttempts }),
  });
}
