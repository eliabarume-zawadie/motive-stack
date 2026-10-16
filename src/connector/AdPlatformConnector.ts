/** Platform-neutral domain types and interface. Meta specifics live under ./meta. */

export type AccountStatus = "active" | "disabled" | "unsettled" | "closed" | "other";

export interface AdAccount {
  id: string;
  name: string;
  status: AccountStatus;
  currency?: string;
  timezone?: string;
  amountSpent?: string;
}

export interface Campaign {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  objective: string;
}

export interface LeadForm {
  id: string;
  name: string;
  status: string;
}

export interface Lead {
  id: string;
  createdTime: string;
  fields: Record<string, string[]>;
}

export type CampaignObjective =
  | "OUTCOME_LEADS"
  | "OUTCOME_TRAFFIC"
  | "OUTCOME_AWARENESS"
  | "OUTCOME_ENGAGEMENT"
  | "OUTCOME_SALES"
  | "OUTCOME_APP_PROMOTION";

/** A draft never carries a budget and is always created paused. */
export interface CampaignDraftInput {
  workspaceId: string;
  accountId: string;
  name: string;
  objective: CampaignObjective;
}

/** Explicit, time-limited human approval for one external write. */
export interface ApprovalGrant {
  workspaceId: string;
  accountId: string;
  action: "create_campaign_draft";
  actionVersion: number;
  approvedBy: string;
  expiresAt: string; // ISO 8601
}

export interface AdPlatformConnector {
  getAuthorizedAccounts(): Promise<AdAccount[]>;
  getAdAccountDetails(accountId: string): Promise<AdAccount>;
  listCampaigns(accountId: string): Promise<Campaign[]>;
  createCampaignDraft(input: CampaignDraftInput, approval: ApprovalGrant): Promise<Campaign>;
  getCampaignStatus(campaignId: string): Promise<Campaign>;
  listLeadForms(pageId: string): Promise<LeadForm[]>;
  retrieveLead(leadId: string): Promise<Lead>;
}
