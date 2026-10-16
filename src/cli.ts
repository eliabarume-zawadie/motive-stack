import { config as loadEnv } from "dotenv";
import { loadConfig } from "./config.js";
import { GraphClient } from "./connector/meta/graphClient.js";
import { MetaConnector } from "./connector/meta/MetaConnector.js";
import { MetaApiError } from "./connector/meta/errors.js";

// READ-ONLY command line. Writes are available only through the library API with an ApprovalGrant.
const USAGE = `Usage: npm run cli -- <command> [id]
  accounts                 ad accounts visible to the token
  account <act_id>         account details
  campaigns <act_id>       campaigns on an account
  campaign <campaign_id>   one campaign's real state
  forms <page_id>          lead forms of a Page   (needs a Page-capable token)
  lead <lead_id>           one lead               (needs leads_retrieval)`;

async function main(): Promise<void> {
  loadEnv({ path: ".env.local" });
  const [cmd, id] = process.argv.slice(2);
  if (!cmd) {
    console.log(USAGE);
    return;
  }
  const cfg = loadConfig(process.env);
  const client = new GraphClient({ token: cfg.accessToken, version: cfg.graphVersion, timeoutMs: cfg.timeoutMs });
  const meta = new MetaConnector(client, { writeAllowlist: cfg.writeAllowlist });
  const need = (): string => {
    if (!id) throw new Error(`"${cmd}" needs an id.\n${USAGE}`);
    return id;
  };

  let out: unknown;
  switch (cmd) {
    case "accounts": out = await meta.getAuthorizedAccounts(); break;
    case "account": out = await meta.getAdAccountDetails(need()); break;
    case "campaigns": out = await meta.listCampaigns(need()); break;
    case "campaign": out = await meta.getCampaignStatus(need()); break;
    case "forms": out = await meta.listLeadForms(need()); break;
    case "lead": out = await meta.retrieveLead(need()); break;
    default: console.log(USAGE); process.exitCode = 1; return;
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  if (e instanceof MetaApiError) {
    console.error(`${e.kind}: ${e.message}${e.code ? ` (code ${e.code}${e.subcode ? `/${e.subcode}` : ""})` : ""}`);
  } else {
    console.error(e instanceof Error ? e.message : "Unknown error");
  }
  process.exitCode = 1;
});
