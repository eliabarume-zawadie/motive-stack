import { randomInt } from "node:crypto";
import type {
  AdAccount,
  AdPlatformConnector,
  ApprovalGrant,
  Campaign,
  CampaignDraftInput,
  Lead,
  LeadForm,
} from "../connector/AdPlatformConnector.js";
import { MetaApiError, type ErrorKind } from "../connector/meta/errors.js";
import type { Db } from "../db/db.js";

export const SIM_ACCOUNT_ID = "act_9000000001";

/** Failure injection for deterministic tests. Plain mutable object shared with the test. */
export interface MetaFaults {
  /** Next N create calls fail BEFORE anything is created (a definite failure; retry is safe). */
  transientFailuresRemaining?: number;
  /** Next create succeeds on the "platform" but the response is lost (timeout, outcome unknown). */
  timeoutAfterSuccess?: boolean;
  /** Next create fails with this kind (e.g. "permission"). */
  failKind?: ErrorKind;
  /** The campaign comes back NOT paused (simulates a platform that ignored our request). */
  createActive?: boolean;
}

interface SimRow {
  id: string;
  name: string;
  objective: string;
  status: string;
}

const toCampaign = (r: SimRow): Campaign => ({
  id: r.id,
  name: r.name,
  status: r.status,
  effectiveStatus: r.status,
  objective: r.objective,
});

/**
 * Simulated Meta. Persists "platform" state in sim_meta_campaigns so restarts and reconciliation behave
 * like the real thing. It deliberately allows duplicate names: the app, not the simulator, must prevent duplicates.
 */
export class MockMetaConnector implements AdPlatformConnector {
  readonly simulated = true;

  constructor(
    private readonly db: Db,
    private readonly workspaceId: string,
    private readonly faults: MetaFaults,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getAuthorizedAccounts(): Promise<AdAccount[]> {
    return [{ id: SIM_ACCOUNT_ID, name: "Simulated Ad Account", status: "active", currency: "USD" }];
  }

  async getAdAccountDetails(accountId: string): Promise<AdAccount> {
    if (accountId !== SIM_ACCOUNT_ID) throw new MetaApiError("permission", "Unknown simulated ad account");
    return { id: SIM_ACCOUNT_ID, name: "Simulated Ad Account", status: "active", currency: "USD", amountSpent: "0" };
  }

  async listCampaigns(accountId: string): Promise<Campaign[]> {
    const rows = this.db
      .prepare("SELECT id, name, objective, status FROM sim_meta_campaigns WHERE workspace_id = ? AND account_id = ? ORDER BY created_at, id")
      .all(this.workspaceId, accountId) as SimRow[];
    return rows.map(toCampaign);
  }

  async getCampaignStatus(campaignId: string): Promise<Campaign> {
    const r = this.db
      .prepare("SELECT id, name, objective, status FROM sim_meta_campaigns WHERE id = ? AND workspace_id = ?")
      .get(campaignId, this.workspaceId) as SimRow | undefined;
    if (!r) throw new MetaApiError("validation", "Simulated campaign not found", { code: 100 });
    return toCampaign(r);
  }

  async createCampaignDraft(input: CampaignDraftInput, approval: ApprovalGrant): Promise<Campaign> {
    if (!approval || approval.workspaceId !== input.workspaceId || approval.accountId !== input.accountId || approval.action !== "create_campaign_draft") {
      throw new MetaApiError("approval_refused", "Write refused: approval does not match this action");
    }
    if (input.workspaceId !== this.workspaceId) throw new MetaApiError("permission", "Wrong workspace for this connector");

    if ((this.faults.transientFailuresRemaining ?? 0) > 0) {
      this.faults.transientFailuresRemaining = (this.faults.transientFailuresRemaining ?? 0) - 1;
      throw new MetaApiError("transient", "Simulated transient platform error", { code: 2 });
    }
    if (this.faults.failKind) {
      const kind = this.faults.failKind;
      this.faults.failKind = undefined;
      throw new MetaApiError(kind, `Simulated ${kind} error`, { code: kind === "permission" ? 200 : 100 });
    }

    const id = `1203${randomInt(10 ** 11, 10 ** 12)}`;
    const status = this.faults.createActive ? "ACTIVE" : "PAUSED";
    this.faults.createActive = undefined;
    this.db
      .prepare("INSERT INTO sim_meta_campaigns (id, workspace_id, account_id, name, objective, status, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, this.workspaceId, input.accountId, input.name, input.objective, status, this.now().toISOString());

    if (this.faults.timeoutAfterSuccess) {
      this.faults.timeoutAfterSuccess = false;
      throw new MetaApiError("timeout", "Simulated timeout after the platform created the campaign", { outcomeUnknown: true });
    }
    return this.getCampaignStatus(id);
  }

  async listLeadForms(): Promise<LeadForm[]> {
    return [];
  }

  async retrieveLead(): Promise<Lead> {
    throw new MetaApiError("validation", "Simulated Meta does not serve leads; leads arrive as synthetic events");
  }
}
