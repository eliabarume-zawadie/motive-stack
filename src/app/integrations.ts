import { z } from "zod";
import { checkPng } from "../creative/png.js";
import { RATIO_SIZE } from "../creative/image.js";
import { assertCreativesStillApproved } from "./creatives.js";
import { budgetPosition } from "./budgetCommitments.js";
import { getCampaignRow } from "./campaigns.js";
import type { AppContext } from "./context.js";
import { audit, iso } from "./core.js";
import { lastAiTest } from "./dashboard.js";
import { AppError, notFound } from "./errors.js";
import { approverMayAuthorize } from "./memberships.js";
import { liveAccountDenied } from "./metaAccounts.js";
import { getProposalRow, hashPayload, ProposalPayloadSchema } from "./proposals.js";
import { newId, safeError } from "./util.js";
import { getBrain } from "./workspaces.js";
import { normalizeEmail, normalizePhone } from "../integrations/crm.js";

/**
 * Integrations, described honestly. Every adapter says what state it is in, exactly which actions it supports and which of those could affect the outside world, what
 * limits and failure behaviour it has, where its data comes from and how that data is labelled. NOTHING here switches anything on, contacts a service or changes a
 * setting: it is a read-only description, plus SIMULATED self-tests of the built-in stand-ins.
 *
 * States: mock (a built-in stand-in), configured_unverified (set up but never tested live), verified (a live test passed: impossible in this release), limited (works,
 * with stated restrictions), disabled, unavailable, not_built (declared for the future, no code).
 *
 * The scopes listed in the action contracts are INDICATIVE: a starting point for the future integration review, to be checked against the vendor's current documentation.
 * Nothing is requested from any vendor in this release.
 */
export type AdapterState = "mock" | "configured_unverified" | "verified" | "limited" | "disabled" | "unavailable" | "not_built";
export type CapabilityState = "simulated" | "available" | "disabled" | "not_built";
export interface Capability { id: string; label: string; effect: "read" | "internal_write" | "external_effect"; state: CapabilityState; approvalRequired: boolean; note: string }
const cap = (id: string, label: string, effect: Capability["effect"], state: CapabilityState, approvalRequired: boolean, note: string): Capability => ({ id, label, effect, state, approvalRequired, note });

const STATE_LABEL: Record<AdapterState, string> = { mock: "SIMULATED", configured_unverified: "CONFIGURED, NOT VERIFIED", verified: "VERIFIED", limited: "LIMITED", disabled: "DISABLED", unavailable: "UNAVAILABLE", not_built: "NOT BUILT" };
const LIVE_ENABLE = "Separate explicit authorization and an integration-specific review of permissions, privacy and failure behaviour. Not requested in this release.";

export interface AdapterDescriptor {
  id: string; label: string; group: "core" | "channel" | "future"; state: AdapterState; stateLabel: string; mode: "simulated" | "live" | "local" | "none"; reason: string;
  capabilities: Capability[]; limits: string[]; dataProvenance: string; failureBehavior: string; setupGuidance: string[]; permissionLimits: string;
  lastTest: { at: string; ok: boolean; simulated: true; detail: string } | null; testable: "simulated" | "ai_route" | "none";
  /** True only when a call from this adapter could leave this computer RIGHT NOW. In this release it is false for every adapter. */
  canAffectOutsideWorldNow: boolean;
}

function lastTestOf(c: AppContext, wsId: string, id: string): AdapterDescriptor["lastTest"] {
  const r = c.db.prepare("SELECT ok, detail, created_at FROM integration_tests WHERE workspace_id = ? AND adapter_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(wsId, id) as { ok: number; detail: string; created_at: string } | undefined;
  return r ? { at: r.created_at, ok: r.ok === 1, simulated: true, detail: r.detail } : null;
}
const future = (id: string, label: string, caps: Capability[], limits: string[], prov: string, fail: string): AdapterDescriptor => ({
  id, label, group: "future", state: "not_built", stateLabel: STATE_LABEL.not_built, mode: "none", reason: "Declared for the future. There is no code for it and nothing can be connected.", capabilities: caps, limits,
  dataProvenance: prov, failureBehavior: fail, setupGuidance: ["Not available. Each future channel needs its own review before any code is written."], permissionLimits: "Nobody can enable it: it does not exist.", lastTest: null, testable: "none", canAffectOutsideWorldNow: false,
});

export function integrationsView(c: AppContext, wsId: string, authMode: string) {
  const cfg = c.integrations;
  const meta = c.metaFor(wsId);
  const aiTest = lastAiTest(c.db, wsId);
  const adapters: AdapterDescriptor[] = [];

  // ---- Meta Ads
  const metaLive = cfg.liveMeta;
  adapters.push({
    id: "meta_ads", label: "Meta Ads", group: "channel", mode: metaLive ? "live" : "simulated",
    state: !metaLive ? "mock" : meta.accountId ? "configured_unverified" : "unavailable", stateLabel: "",
    reason: !metaLive ? "A built-in simulator stands in for Meta. No real ad account is connected and nothing is sent to Meta." : meta.accountId ? "Live mode is configured and an authorized account is chosen, but no live test has ever been made, so it is not verified." : "Live mode is configured but this workspace has no authorized ad account, so every write is refused.",
    capabilities: [
      cap("list_ad_accounts", "List authorized ad accounts", "read", metaLive ? "available" : "simulated", false, "Only accounts an owner authorized for this workspace."),
      cap("create_campaign_draft", "Create a PAUSED campaign draft", "external_effect", metaLive ? "available" : "simulated", true, "After an admin approves the exact payload, then a separate run step. Created paused, with no budget. Live creation is gated by the server's mode, an authorized account and a signed-in approver."),
      cap("read_campaign_status", "Read a campaign's status", "read", metaLive ? "available" : "simulated", false, "Used to verify the draft really came back paused."),
      cap("read_lead_forms_and_leads", "Read lead forms and leads", "read", "not_built", false, "No lead is ever pulled from Meta: leads here are synthetic or imported."),
      cap("create_ad_set_or_ad", "Create an ad set or an ad", "external_effect", "not_built", true, "Not built."),
      cap("set_budget_or_activate", "Set a real budget or activate a campaign", "external_effect", "not_built", true, "Not built, and not requested: nothing can spend money."),
      cap("pause_resume", "Pause or resume a live campaign", "external_effect", "not_built", true, "Not built."),
      cap("read_performance", "Read impressions, clicks and spend", "read", "not_built", false, "Not built, so no performance number exists in this app."),
    ],
    limits: ["Paused drafts only; no budget is ever sent when a draft is created.", "One approval covers one exact payload for 24 hours.", "The workspace-wide daily limit and the Business Brain ceiling are checked again at run time.", "A live write needs a signed-in approver; the shared workspace token can authorize simulated actions only."],
    dataProvenance: metaLive ? "Responses would come from Meta and would be labelled LIVE." : "Everything comes from the simulator and is labelled SIMULATED. Nothing from Meta is imported.",
    failureBehavior: "A definite failure is retried safely. If the outcome is unknown (a lost response), the proposal goes to 'needs review' and is never re-sent; the draft is looked up by its unique name instead.",
    setupGuidance: metaLive ? ["An owner authorizes the ad account for this workspace; an admin chooses it.", "Live writes also need INTEGRATION_MODE=live and LIVE_META=true on the server."] : ["Nothing to set up in mock mode.", "Going live needs a server setting change and separate authorization; it cannot be switched on from this page."],
    permissionLimits: "Choosing an account: admin. Authorizing one: owner. Approving a write: admin. Running it: admin (a separate permission).", lastTest: lastTestOf(c, wsId, "meta_ads"), testable: metaLive ? "none" : "simulated", canAffectOutsideWorldNow: false,
  });

  // ---- GoHighLevel CRM
  adapters.push({
    id: "ghl_crm", label: "GoHighLevel CRM", group: "channel", mode: "simulated", state: "mock", stateLabel: "",
    reason: "A built-in simulator stands in for GoHighLevel. There is no real GoHighLevel connector in this release, so no real contact can be created.",
    capabilities: [
      cap("upsert_contact", "Create or update a contact", "external_effect", "simulated", false, "Simulated only, and only for synthetic leads from the simulator. Imported leads and form test leads are never sent anywhere."),
      cap("read_contacts", "Read contacts", "read", "not_built", false, "Not built."), cap("create_opportunity", "Create an opportunity or pipeline entry", "external_effect", "not_built", true, "Not built."),
      cap("send_message", "Send an e-mail or text message", "external_effect", "not_built", true, "Not built and not in scope: this app never contacts a lead."), cap("receive_webhooks", "Receive inbound events", "read", "not_built", false, "Not built: no public endpoint exists."),
    ],
    limits: ["The live connector is refused at start-up (LIVE_GHL is not supported)."], dataProvenance: "Contacts exist only in the simulator and are labelled SIMULATED.",
    failureBehavior: "A temporary failure is retried with backoff up to a limit, then the lead's CRM state shows failed with a reason. A permission failure fails at once.", setupGuidance: ["Nothing to set up. A real connector is a future, separately authorized piece of work."],
    permissionLimits: "Nobody can connect a real CRM from this app.", lastTest: lastTestOf(c, wsId, "ghl_crm"), testable: "simulated", canAffectOutsideWorldNow: false,
  });

  // ---- AI text generation
  const aiMode = cfg.aiMode;
  adapters.push({
    id: "ai_text", label: "AI text generation", group: "core", mode: aiMode === "mock" ? "simulated" : aiMode === "local" ? "local" : "live",
    state: aiMode === "mock" ? "mock" : aiTest?.ok ? "limited" : "configured_unverified", stateLabel: "",
    reason: aiMode === "mock" ? "A deterministic offline model answers. Nothing is sent to any provider." : aiMode === "local" ? "A model on this computer answers; nothing leaves the machine." : "Real provider calls are enabled on the server and may be billed.",
    capabilities: [cap("generate_campaign_draft", "Write campaign drafts and plans", "internal_write", aiMode === "mock" ? "simulated" : "available", false, "Drafts only: nothing is published and every draft goes through review and approval."), cap("extract_structured", "Read a website into a Business Brain draft", "internal_write", aiMode === "mock" ? "simulated" : "available", false, "Results are suggestions a person reviews."), cap("connection_test", "Test the connection", "read", "available", false, "Uses the AI settings test; live mode makes one real request.")],
    limits: ["Spending ceilings and reservations apply to paid calls.", "Output is validated against the claim and length rules before it is stored."], dataProvenance: "Each saved draft records the provider, model and prompt version that made it.",
    failureBehavior: "A failed call is recorded and can be retried; a draft that fails validation is repaired once, then refused.", setupGuidance: ["AI settings (admin) choose routing and limits. Keys are read from the server's environment and never shown."],
    permissionLimits: "Settings and tests: admin.", lastTest: aiTest ? { at: aiTest.at, ok: aiTest.ok, simulated: true, detail: `${aiTest.provider}/${aiTest.model}${aiTest.simulated ? " (simulated)" : ""}` } : null, testable: "ai_route", canAffectOutsideWorldNow: false,
  });

  // ---- image generation (Creative Studio)
  const img = c.imageProvider.capabilities;
  adapters.push({
    id: "image_generation", label: "Image generation", group: "core", mode: "simulated", state: "mock", stateLabel: "",
    reason: `${img.label}: ${img.note}`,
    capabilities: [cap("generate_image", "Make a still image", "internal_write", "simulated", false, `Formats: ${img.ratios.join(", ")}. Output is checked and stored before it counts as complete.`), cap("generate_video", "Make a video or storyboard", "internal_write", "not_built", false, "Planned, not built."), cap("live_provider", "A real image provider", "external_effect", "not_built", true, "No live image provider exists.")],
    limits: [`A workspace can make ${c.creativeLimits.maxRendersPerDay} pictures a day.`], dataProvenance: "Pictures are placeholders labelled as such; provider and model are recorded on every asset.", failureBehavior: "Temporary failures retry within bounds; damaged or wrong-shaped output is thrown away and the render shows failed.",
    setupGuidance: ["Nothing to set up."], permissionLimits: "Making pictures: operator.", lastTest: lastTestOf(c, wsId, "image_generation"), testable: "simulated", canAffectOutsideWorldNow: false,
  });

  // ---- asset storage, identity, credential vault
  adapters.push({
    id: "asset_storage", label: "Asset storage", group: "core", mode: "local", state: "limited", stateLabel: "", reason: `Files are kept by the "${c.assetStore.kind}" store on this computer. There is no backup, retention or access-control story beyond the app's own checks.`,
    capabilities: [cap("store_files", "Store and read image files", "internal_write", "available", false, "Safe keys, no overwrite, size and quota limits, hash checked on read.")], limits: [`${Math.floor(c.assetLimits.maxFileBytes / 1048576)} MB per file, ${Math.floor(c.assetLimits.maxWorkspaceBytes / 1048576)} MB and ${c.assetLimits.maxAssets} assets per workspace.`],
    dataProvenance: "Every file records its source (uploaded, imported or generated), rights and provenance.", failureBehavior: "A write that cannot be recorded is removed; a stored file that no longer matches its hash is refused.", setupGuidance: ["Managed object storage is a future option behind the same interface."], permissionLimits: "Uploading: operator.", lastTest: null, testable: "none", canAffectOutsideWorldNow: false,
  });
  adapters.push({
    id: "identity", label: "Sign-in", group: "core", mode: "local", state: authMode === "oidc" ? "configured_unverified" : "limited", stateLabel: "",
    reason: authMode === "oidc" ? "The server expects identity-provider sign-in." : "Local development: a per-workspace access token. It is shared and is not a person, so it can have no assignments or notifications.",
    capabilities: [cap("authenticate", "Identify who is acting", "internal_write", "available", false, authMode === "oidc" ? "People are identified by the provider; roles are read fresh on every request." : "The shared token is treated as an admin-equivalent that can never manage members.")], limits: ["The shared token can authorize simulated actions only."],
    dataProvenance: "Actions are attributed to a person, the shared token, or the system, and the audit trail says which.", failureBehavior: "Unknown or expired credentials are refused; nothing is guessed.", setupGuidance: ["An identity provider is configured on the server."], permissionLimits: "Set up on the server by whoever runs it; workspace owners manage members and roles.", lastTest: null, testable: "none", canAffectOutsideWorldNow: false,
  });
  adapters.push({
    id: "credential_vault", label: "Credential vault", group: "core", mode: "local", state: c.credentials.available ? "limited" : "disabled", stateLabel: "",
    reason: c.credentials.available ? "A key provider is configured, so credentials can be stored encrypted." : "No key provider is configured: nothing is stored or read.", capabilities: [cap("store_credentials", "Store provider credentials", "internal_write", c.credentials.available ? "available" : "disabled", false, "Masked status only; a stored credential never grants the right to use any resource.")],
    limits: ["A secret is never shown."], dataProvenance: "Only masked status is ever displayed.", failureBehavior: "With no key available, storage is refused rather than falling back to plain text.", setupGuidance: ["Configured on the server with an approved key provider."], permissionLimits: "Owner (signed-in person only).", lastTest: null, testable: "none", canAffectOutsideWorldNow: false,
  });

  // ---- declared future channels: capabilities, approvals, limits, provenance and failure behaviour are part of the contract BEFORE any code exists
  const FUT_FAIL = "Must fail closed: an unknown result is never retried blindly and is shown for a person to review.";
  const futures = [
    future("google_ads", "Google Ads", [cap("create_campaign_draft", "Create a paused draft", "external_effect", "not_built", true, "Would need the same approval-first, paused-only contract as Meta."), cap("read_performance", "Read performance", "read", "not_built", false, "Would be labelled ACTUAL only when it comes from the verified integration.")], ["Would inherit the workspace-wide daily limit."], "Would label data ACTUAL (from the platform) and never blend it with synthetic data.", FUT_FAIL),
    future("tiktok_ads", "TikTok Ads", [cap("create_campaign_draft", "Create a paused draft", "external_effect", "not_built", true, "Would need its own review.")], ["Would inherit the workspace-wide daily limit."], "Would label data ACTUAL and separate it from synthetic data.", FUT_FAIL),
    future("email_sms", "E-mail and SMS", [cap("send_message", "Send a message to a lead", "external_effect", "not_built", true, "Would need consent verification, opt-out handling, rate limits and a privacy review first.")], ["Consent must be verified, not merely recorded."], "Would record who was contacted, when and on what consent.", "Must fail closed and never resend automatically."),
    future("analytics", "Web analytics", [cap("read_traffic", "Read traffic and conversions", "read", "not_built", false, "Would be labelled ACTUAL or IMPORTED and kept apart from synthetic data."), cap("send_events", "Send conversion events to a platform", "external_effect", "not_built", true, "Prohibited until a privacy and consent review.")], ["No tracking pixel exists."], "Would label every number with its source.", FUT_FAIL),
    future("calendar_tools", "Calendar tools", [cap("sync_events", "Sync dated tasks to an outside calendar", "external_effect", "not_built", true, "Would share task titles outside the app; needs a review.")], ["The in-app calendar is internal coordination only."], "Would never present an internal proposed date as a platform schedule.", FUT_FAIL),
  ];
  for (const a of [...adapters, ...futures]) a.stateLabel = STATE_LABEL[a.state];
  const all = [...adapters, ...futures];

  // ---- the lock: why nothing can reach the outside world
  const reasons: string[] = [];
  if (!cfg.liveMeta) reasons.push("Meta is simulated (INTEGRATION_MODE is not live, or LIVE_META is off): no ad platform is contacted.");
  reasons.push("GoHighLevel has no live connector: LIVE_GHL is refused at start-up.");
  if (cfg.aiMode === "mock") reasons.push("AI is simulated (AI_PROVIDER_MODE=mock): no model provider is contacted.");
  else if (cfg.aiMode === "local") reasons.push("AI runs on this computer only: nothing leaves the machine.");
  reasons.push("The image provider is an offline placeholder: no image service is contacted.");
  reasons.push("E-mail, SMS, push, tracking pixels and public forms do not exist.");
  const noneNow = !cfg.liveMeta && cfg.aiMode !== "live";

  return {
    adapters: all.filter((a) => a.group !== "future"), futureChannels: futures, states: Object.entries(STATE_LABEL).map(([id, label]) => ({ id, label })),
    actionContracts: actionContracts(c, wsId),
    executionLock: { externalEffectsPossibleNow: !noneNow, summary: noneNow ? "Nothing this app can do reaches the outside world: every integration is simulated, local, or not built." : "At least one integration is configured to reach an outside service. Every external write still needs an exact, unexpired approval and a separate run step.", reasons, enabledFromThisPage: false },
    note: "This page describes the integrations. It cannot switch one on: going live is a server setting change that needs separate authorization.",
  };
}

/** Every action that could ever affect the outside world, and what it would take. Descriptive only. */
function actionContracts(c: AppContext, wsId: string) {
  const mockMeta = !c.integrations.liveMeta;
  return [
    { id: "meta.create_campaign_draft", adapter: "meta_ads", label: "Create a paused campaign draft on Meta", status: mockMeta ? "simulated" : "gated", effect: "A paused campaign with no budget appears in an authorized ad account.", reversible: "Yes: it is paused and can be deleted in Meta.",
      requires: ["The campaign passes the claim, length and budget rules", "A proposal for the exact current campaign version", "An admin approval of the exact payload (24 hours)", "A separate run step by someone allowed to run", "The workspace-wide daily limit and ceiling still hold", "Live only: INTEGRATION_MODE=live, LIVE_META=true, an account the owner authorized, and a signed-in approver"],
      dataSent: ["Account id", "Campaign name", "Objective (leads)", "Status: paused"], indicativeScopes: ["ads_management", "business_management"], approvalPermission: "proposals.decide", runPermission: "proposals.execute" },
    { id: "meta.set_budget_or_activate", adapter: "meta_ads", label: "Set a real budget or activate a campaign", status: "not_built", effect: "Real money would be spent.", reversible: "Only by pausing; money already spent is not recoverable.", requires: ["Not built. Needs separate explicit authorization and its own review."], dataSent: ["Budget", "Schedule"], indicativeScopes: ["ads_management"], approvalPermission: "proposals.decide", runPermission: "proposals.execute" },
    { id: "ghl.upsert_contact", adapter: "ghl_crm", label: "Create or update a CRM contact", status: "simulated", effect: "A contact would be created or matched by email or phone in the CRM.", reversible: "Partly: a created contact can be deleted; a matched one may have been changed.", requires: ["Today: simulator only, synthetic leads only", "Live (future): consent verification, a privacy review, an approval step and a separate authorization"],
      dataSent: ["Name", "Email", "Phone", "Source tag"], indicativeScopes: ["contacts.write", "contacts.readonly"], approvalPermission: "n/a in this release", runPermission: "n/a in this release" },
    { id: "ghl.send_message", adapter: "ghl_crm", label: "Send an e-mail or text message to a lead", status: "not_built", effect: "A real person would be contacted.", reversible: "No: a sent message cannot be unsent.", requires: ["Not built and not in scope for this release: verified consent, opt-out handling, rate limits and a privacy review first."], dataSent: ["Message body", "Recipient"], indicativeScopes: ["conversations.write"], approvalPermission: "n/a", runPermission: "n/a" },
    { id: "ads.send_conversion_events", adapter: "analytics", label: "Send conversion events to an advertising platform", status: "not_built", effect: "Lead data would be shared with an advertising platform.", reversible: "No.", requires: ["Prohibited until a privacy and consent review."], dataSent: ["Hashed contact details", "Event"], indicativeScopes: ["ads_management"], approvalPermission: "n/a", runPermission: "n/a" },
  ].map((a) => ({ ...a, scopesNote: "Scopes are indicative and must be checked against the vendor's current documentation during the integration review. None is requested in this release.", enablementRequires: LIVE_ENABLE }));
}

/* ------------------------------------------------------------------------------------------------ simulated tests */

export const TestableSchema = z.enum(["meta_ads", "ghl_crm", "image_generation"]);
/** Exercises a built-in STAND-IN on this computer. A live service is never contacted; testing one is refused. */
export async function runSimulatedTest(c: AppContext, wsId: string, actor: string, adapterId: string) {
  const id = TestableSchema.safeParse(adapterId);
  if (!id.success) throw new AppError(400, "not_testable", "This integration has no simulated test here. The AI connection has its own test in AI settings; the others have nothing to test.");
  if (id.data === "meta_ads" && c.integrations.liveMeta) throw new AppError(409, "live_test_disabled", "A test of a live service makes a real request, and live tests are not enabled in this release. Nothing was contacted.");
  let ok = true, detail: string;
  try {
    if (id.data === "meta_ads") {
      const m = c.metaFor(wsId);
      const accounts = await m.connector.getAuthorizedAccounts();
      detail = `The simulator answered: ${accounts.length} account${accounts.length === 1 ? "" : "s"} (fixtures, not real accounts). Nothing was contacted.`;
    } else if (id.data === "ghl_crm") {
      const crm = c.crmFor(wsId);
      if (!crm.simulated) throw new Error("The CRM is not the simulator, so the test was not run");
      detail = "The CRM is the built-in simulator. No contact was created and nothing was contacted.";
    } else {
      const s = RATIO_SIZE("1:1");
      const out = await c.imageProvider.generate({ ratio: "1:1", ...s, seed: "self-test", prompt: "self-test", palette: { background: "#FFFFFF", foreground: "#000000", accent: "#1A4D8F" } });
      const chk = checkPng(out.bytes);
      if (!chk.ok) throw new Error(`The placeholder image failed its own checks (${chk.reason})`);
      detail = `The placeholder provider made a valid ${chk.width}x${chk.height} picture in memory. Nothing was stored or contacted.`;
    }
  } catch (e) { ok = false; detail = safeError(e, 240); }
  c.db.prepare("INSERT INTO integration_tests (id, workspace_id, adapter_id, ok, simulated, detail, created_at, created_by) VALUES (?,?,?,?,1,?,?,?)").run(newId("itst"), wsId, id.data, ok ? 1 : 0, detail, iso(c), actor);
  audit(c, wsId, actor, "integration.test_simulated", "integration", id.data, { ok, simulated: true });
  return { adapterId: id.data, ok, simulated: true as const, detail, note: "This was a SIMULATED test of a built-in stand-in. It says nothing about any real service." };
}

/* ------------------------------------------------------------------------------------------------ dry runs (read-only) */

interface Gate { id: string; label: string; met: boolean; detail: string }
/** What an approved proposal would send, and each precondition judged NOW, without executing, changing or queuing anything. Mirrors the executor's gate. */
export function proposalDryRun(c: AppContext, wsId: string, proposalId: string) {
  const p = getProposalRow(c, wsId, proposalId);
  const gates: Gate[] = [];
  const g = (id: string, label: string, met: boolean, detail: string) => gates.push({ id, label, met, detail });
  const camp = getCampaignRow(c, wsId, p.campaign_id);
  g("status", "The proposal has been approved", p.status === "approved", p.status === "approved" ? "Approved." : `It is ${p.status}, so it would not run.`);
  g("campaign_version", "The campaign has not changed since the proposal", camp.current_version === p.campaign_version, camp.current_version === p.campaign_version ? `Still version ${p.campaign_version}.` : `The campaign is now version ${camp.current_version}; the proposal is for ${p.campaign_version}.`);
  const a = c.db.prepare("SELECT * FROM approvals WHERE proposal_id = ? AND workspace_id = ?").get(p.id, wsId) as { decision: string; payload_hash: string; campaign_version: number; integration_mode: string; expires_at: string; approver_kind: string; approver_user_id: string | null } | undefined;
  g("approval", "An approval exists", !!a && a.decision === "approve", a ? `Decision: ${a.decision}.` : "No approval yet.");
  let payload: ReturnType<typeof ProposalPayloadSchema.parse> | null = null;
  try { payload = ProposalPayloadSchema.parse(JSON.parse(p.payload)); } catch { payload = null; }
  g("payload_hash", "The approved payload is exactly what is stored", !!a && a.payload_hash === p.payload_hash && hashPayload(JSON.parse(p.payload)) === p.payload_hash, "The approval covers this exact payload.");
  if (a) {
    g("approval_unexpired", "The approval has not expired", Date.parse(a.expires_at) > c.now().getTime(), `It ${Date.parse(a.expires_at) > c.now().getTime() ? "expires" : "expired"} ${a.expires_at.replace("T", " ").slice(0, 16)} UTC.`);
    const meta = c.metaFor(wsId);
    g("mode", "Proposal, approval and connector are the same mode", meta.mode === p.integration_mode && meta.mode === a.integration_mode && (!payload || meta.mode === payload.mode), `Connector: ${meta.mode}; proposal: ${p.integration_mode}; approval: ${a.integration_mode}.`);
    g("approver", "The approver may still authorize it", approverMayAuthorize(c, a as never, wsId, meta.mode), "Judged now, not when they clicked.");
    if (payload) {
      g("account", "The ad account is the workspace's authorized account", meta.accountId === payload.accountId && !liveAccountDenied(c, wsId, payload.accountId), `Account ${payload.accountId}${meta.mode === "mock" ? " (a simulator fixture)" : ""}.`);
      const brain = getBrain(c, wsId);
      g("ceiling", "The budget is within the Business Brain ceiling", !!brain && p.daily_budget_cents <= brain.brain.maxDailyBudgetCents, `${p.daily_budget_cents}¢ planned; ceiling ${brain ? brain.brain.maxDailyBudgetCents + "¢" : "not set"}.`);
      const pos = budgetPosition(c, wsId);
      g("daily_limit", "The workspace-wide daily limit still holds", pos.unnormalizable.length === 0 && !(pos.ceilingCents !== null && pos.overLimitCents > 0), pos.overLimitCents > 0 ? `${pos.overLimitCents}¢ over the limit.` : "Within the limit.");
      let creativesOk = true; try { assertCreativesStillApproved(c, wsId, payload.creatives); } catch { creativesOk = false; }
      g("creatives", "Every creative named in the proposal is still approved and unchanged", creativesOk, payload.creatives?.length ? `${payload.creatives.length} creative${payload.creatives.length === 1 ? "" : "s"} pinned.` : "No creative is pinned.");
    }
  }
  const mock = c.metaFor(wsId).mode === "mock";
  return {
    proposalId: p.id, status: p.status, adapter: "meta_ads", action: "create_campaign_draft",
    wouldSend: payload ? { accountId: payload.accountId, name: payload.name, objective: payload.objective, status: "PAUSED", budgetSent: false, plannedDailyBudgetCents: payload.plannedDailyBudgetCents, note: "The planned budget is NOT sent when a draft is created.", creativesPinned: payload.creatives ?? [], creativesSent: false } : null,
    whatWouldHappen: mock ? "SIMULATED: the built-in simulator would create a paused draft. Nothing leaves this computer." : "LIVE: a paused draft would be created in the authorized Meta account.",
    gates, allGatesMet: gates.every((x) => x.met),
    note: "This is a read-only preview. It changed nothing and queued nothing. Running a proposal is a separate step that checks every gate again.",
  };
}

export function leadCrmDryRun(c: AppContext, wsId: string, leadId: string) {
  const l = c.db.prepare("SELECT id, full_name, email, phone, origin, crm_status, simulated FROM leads WHERE id = ? AND workspace_id = ?").get(leadId, wsId) as { id: string; full_name: string; email: string | null; phone: string | null; origin: string; crm_status: string; simulated: number } | undefined;
  if (!l) throw notFound("Lead");
  const sim = l.origin === "synthetic" && l.crm_status !== "not_synced";
  const why = l.origin === "imported" ? "Imported leads are never sent to any CRM." : l.origin === "synthetic" && l.crm_status === "not_synced" ? "Form test leads are never sent anywhere." : l.origin === "synthetic" ? "Synthetic leads from the simulator are sent to the built-in CRM simulator only." : l.origin === "real" ? "No real lead exists in this release." : "An unclassified record is not sent anywhere.";
  return {
    leadId: l.id, adapter: "ghl_crm", action: "upsert_contact", origin: l.origin, currentCrmStatus: l.crm_status,
    wouldSend: sim ? { fullName: l.full_name, email: normalizeEmail(l.email), phone: normalizePhone(l.phone), source: "motivestack", destination: "the built-in simulator" } : null, eligibility: why,
    whatWouldHappen: sim ? "SIMULATED: the simulator would record a contact. No real CRM exists and no message would be sent." : "Nothing would be sent.",
    note: "This is a read-only preview. It changed nothing and sent nothing. This app never e-mails, texts or calls a lead.",
  };
}
