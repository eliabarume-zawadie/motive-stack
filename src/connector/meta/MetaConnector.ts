import type { z } from "zod";
import type {
  AccountStatus,
  AdAccount,
  AdPlatformConnector,
  ApprovalGrant,
  Campaign,
  CampaignDraftInput,
  Lead,
  LeadForm,
} from "../AdPlatformConnector.js";
import { MetaApiError } from "./errors.js";
import type { GraphClient } from "./graphClient.js";
import { AdAccountSchema, CampaignSchema, CreatedSchema, LeadFormSchema, LeadSchema, listOf } from "./schemas.js";

const ACCOUNT_ID = /^act_\d+$/;
const NUMERIC_ID = /^\d+$/;
const CAMPAIGN_FIELDS = "id,name,status,effective_status,objective";

export interface MetaConnectorOptions {
  /** Ad accounts on which writes are permitted. Empty means every write is refused. */
  writeAllowlist: string[];
  now?: () => Date;
}

export class MetaConnector implements AdPlatformConnector {
  private readonly allow: Set<string>;
  private readonly now: () => Date;

  constructor(
    private readonly client: GraphClient,
    opts: MetaConnectorOptions,
  ) {
    this.allow = new Set(opts.writeAllowlist);
    this.now = opts.now ?? (() => new Date());
  }

  async getAuthorizedAccounts(): Promise<AdAccount[]> {
    const raw = await this.client.get("me/adaccounts", {
      fields: "id,name,account_status,currency",
      limit: 100,
    });
    return this.parse(listOf(AdAccountSchema), raw).data.map(toAccount);
  }

  async getAdAccountDetails(accountId: string): Promise<AdAccount> {
    assertAccountId(accountId);
    const raw = await this.client.get(accountId, {
      fields: "id,name,account_status,currency,timezone_name,amount_spent",
    });
    return toAccount(this.parse(AdAccountSchema, raw));
  }

  async listCampaigns(accountId: string): Promise<Campaign[]> {
    assertAccountId(accountId);
    const raw = await this.client.get(`${accountId}/campaigns`, { fields: CAMPAIGN_FIELDS, limit: 100 });
    return this.parse(listOf(CampaignSchema), raw).data.map(toCampaign);
  }

  async getCampaignStatus(campaignId: string): Promise<Campaign> {
    assertNumericId(campaignId, "campaign");
    const raw = await this.client.get(campaignId, { fields: CAMPAIGN_FIELDS });
    return toCampaign(this.parse(CampaignSchema, raw));
  }

  async createCampaignDraft(input: CampaignDraftInput, approval: ApprovalGrant): Promise<Campaign> {
    assertAccountId(input.accountId);
    this.assertApproved(input, approval);

    let campaignId: string;
    try {
      const raw = await this.client.post(`${input.accountId}/campaigns`, {
        name: input.name,
        objective: input.objective,
        status: "PAUSED",
        special_ad_categories: [],
        is_adset_budget_sharing_enabled: false,
      });
      campaignId = this.parse(CreatedSchema, raw).id;
    } catch (e) {
      // A timed-out create may have succeeded. Look it up by name; never re-send the create.
      if (!(e instanceof MetaApiError) || !e.outcomeUnknown) throw e;
      const found = (await this.listCampaigns(input.accountId)).find((c) => c.name === input.name);
      if (!found) throw e;
      campaignId = found.id;
    }

    const actual = await this.getCampaignStatus(campaignId);
    if (actual.status !== "PAUSED" || actual.objective !== input.objective || actual.name !== input.name) {
      throw new MetaApiError(
        "verification_failed",
        `Campaign ${campaignId} read-back does not match the approved draft (status=${actual.status}).`,
      );
    }
    return actual;
  }

  async listLeadForms(pageId: string): Promise<LeadForm[]> {
    assertNumericId(pageId, "page");
    const raw = await this.client.get(`${pageId}/leadgen_forms`, { fields: "id,name,status", limit: 100 });
    return this.parse(listOf(LeadFormSchema), raw).data;
  }

  async retrieveLead(leadId: string): Promise<Lead> {
    assertNumericId(leadId, "lead");
    const raw = await this.client.get(leadId, { fields: "id,created_time,field_data" });
    const l = this.parse(LeadSchema, raw);
    return {
      id: l.id,
      createdTime: l.created_time,
      fields: Object.fromEntries(l.field_data.map((f) => [f.name, f.values])),
    };
  }

  private assertApproved(input: CampaignDraftInput, a: ApprovalGrant | undefined): void {
    const refuse = (why: string): never => {
      throw new MetaApiError("approval_refused", `Write refused: ${why}`);
    };
    if (!a) return refuse("no approval supplied");
    if (a.action !== "create_campaign_draft") return refuse("approval is for a different action");
    if (a.workspaceId !== input.workspaceId) return refuse("approval is for a different workspace");
    if (a.accountId !== input.accountId) return refuse("approval is for a different ad account");
    if (!a.approvedBy.trim()) return refuse("approval has no approver");
    const expires = Date.parse(a.expiresAt);
    if (Number.isNaN(expires) || expires <= this.now().getTime()) return refuse("approval expired");
    if (!this.allow.has(input.accountId)) return refuse("ad account is not on the write allow-list");
  }

  private parse<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
    const r = schema.safeParse(raw);
    if (!r.success) {
      const where = r.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
      throw new MetaApiError("invalid_response", `Unexpected response shape at: ${where}`);
    }
    return r.data;
  }
}

function assertAccountId(id: string): void {
  if (!ACCOUNT_ID.test(id)) throw new MetaApiError("validation", "Invalid ad account id");
}
function assertNumericId(id: string, what: string): void {
  if (!NUMERIC_ID.test(id)) throw new MetaApiError("validation", `Invalid ${what} id`);
}

function toStatus(n: number): AccountStatus {
  return n === 1 ? "active" : n === 2 ? "disabled" : n === 3 ? "unsettled" : n === 101 ? "closed" : "other";
}

function toAccount(a: z.infer<typeof AdAccountSchema>): AdAccount {
  return {
    id: a.id,
    name: a.name,
    status: toStatus(a.account_status),
    currency: a.currency,
    timezone: a.timezone_name,
    amountSpent: a.amount_spent,
  };
}

function toCampaign(c: z.infer<typeof CampaignSchema>): Campaign {
  return { id: c.id, name: c.name, status: c.status, effectiveStatus: c.effective_status, objective: c.objective };
}
