import { MetaApiError } from "./meta/errors.js";
import type { AdAccount, AdPlatformConnector, ApprovalGrant, Campaign, CampaignDraftInput, Lead, LeadForm } from "./AdPlatformConnector.js";

export interface WorkspaceScope {
  workspaceId: string;
  /** Is this workspace CURRENTLY authorized for this account? Asked on every call, never cached. */
  isAuthorized(accountId: string): boolean;
  /** The accounts this workspace is currently authorized for. */
  authorizedAccountIds(): string[];
  /** Operational restriction that applies to every workspace, on top of the workspace's own authorization (writes only). */
  writeAllowlist: readonly string[];
  /** campaign id -> the account it was seen under, for this workspace. Lets a campaign id be read only if it came from an authorized account. */
  knownCampaigns: Map<string, string>;
}

const ACCOUNT = /^act_[1-9][0-9]{0,19}$/;

/**
 * Wraps the real (shared-token) Meta connector so a workspace can reach ONLY the ad accounts it is currently authorized for.
 *
 * The shared token can see every account it was granted, so the platform cannot be relied on to keep tenants apart: this wrapper
 * is the boundary. Every call that names an account is checked first, against the database, and refused BEFORE the inner connector
 * is touched. Calls that cannot be tied to an authorized account are refused outright.
 */
export class WorkspaceScopedConnector implements AdPlatformConnector {
  constructor(
    private readonly inner: AdPlatformConnector,
    private readonly scope: WorkspaceScope,
  ) {}

  private deny(why = "This ad account is not authorized for this workspace"): never {
    // Deliberately says nothing about whether the account exists or who else may hold it.
    throw new MetaApiError("permission", why);
  }

  private need(accountId: string): void {
    if (typeof accountId !== "string" || !ACCOUNT.test(accountId) || !this.scope.isAuthorized(accountId)) this.deny();
  }

  async getAuthorizedAccounts(): Promise<AdAccount[]> {
    const mine = new Set(this.scope.authorizedAccountIds());
    if (mine.size === 0) return []; // nothing authorized: do not even ask the platform
    return (await this.inner.getAuthorizedAccounts()).filter((a) => mine.has(a.id)); // the token sees other tenants' accounts: never return them
  }

  async getAdAccountDetails(accountId: string): Promise<AdAccount> {
    this.need(accountId);
    return this.inner.getAdAccountDetails(accountId);
  }

  async listCampaigns(accountId: string): Promise<Campaign[]> {
    this.need(accountId);
    const found = await this.inner.listCampaigns(accountId);
    for (const c of found) this.scope.knownCampaigns.set(c.id, accountId);
    return found;
  }

  async createCampaignDraft(input: CampaignDraftInput, approval: ApprovalGrant): Promise<Campaign> {
    this.need(input?.accountId);
    if (input.workspaceId !== this.scope.workspaceId || approval?.workspaceId !== this.scope.workspaceId) this.deny("Write refused: approval or request is for a different workspace");
    if (approval.accountId !== input.accountId) this.deny("Write refused: approval is for a different ad account");
    if (!this.scope.writeAllowlist.includes(input.accountId)) this.deny("Write refused: ad account is not on the operator's write allow-list");
    const created = await this.inner.createCampaignDraft(input, approval);
    this.scope.knownCampaigns.set(created.id, input.accountId);
    return created;
  }

  async getCampaignStatus(campaignId: string): Promise<Campaign> {
    const account = this.scope.knownCampaigns.get(campaignId);
    if (!account) this.deny("Campaign is not known to this workspace");
    this.need(account as string); // the account that campaign lives under must still be authorized
    return this.inner.getCampaignStatus(campaignId);
  }

  // These take a page id or a lead id, so they cannot be tied to an authorized ad account. They are not available to workspaces.
  async listLeadForms(_pageId: string): Promise<LeadForm[]> {
    return this.deny("Not available through a workspace connector");
  }
  async retrieveLead(_leadId: string): Promise<Lead> {
    return this.deny("Not available through a workspace connector");
  }
}
