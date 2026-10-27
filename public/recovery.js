// Pure helpers with no DOM access (so they can be unit tested): the workspace recovery code, and the clearly fictional demo business.

/**
 * A recovery code is "<workspace id>:<access token>". The token alone cannot identify a workspace (every route names the workspace), so the
 * code carries both, and opening an existing workspace needs only this one value. Shapes match what the server generates:
 *   workspace id: ws_ + 20 hex characters;  token: msw_ + 32 base64url characters.
 * The check is deliberately a little looser on the token length so a future token format change does not lock people out; the SERVER decides
 * whether the code is valid.
 */
const RECOVERY_RE = /^(ws_[0-9a-f]{20}):(msw_[A-Za-z0-9_-]{20,128})$/;

export const formatRecoveryCode = (workspaceId, token) => `${workspaceId}:${token}`;

/** The workspace id and token inside a pasted recovery code, or null if it is not shaped like one. Surrounding whitespace is ignored. */
export function parseRecoveryCode(text) {
  const m = RECOVERY_RE.exec(String(text ?? "").trim());
  return m ? { workspaceId: m[1], token: m[2] } : null;
}

/**
 * Fictional demonstration data for the Business Brain form. Every free-text field says DEMO, nothing here is a real business, and loading
 * it only fills the form: the person reviews it and presses Save. Claims are phrased as obviously fictional facts.
 */
export const DEMO_BUSINESS = Object.freeze({
  businessName: "Lone Star Comfort Heating & Air (DEMO)",
  industry: "HVAC (heating and air conditioning)",
  services: ["Air conditioner repair", "Furnace repair", "Seasonal system tune-ups", "New system installation"],
  serviceArea: "Round Rock, TX and nearby (fictional)",
  targetCustomer: "Homeowners whose heating or cooling system has stopped working or is getting old",
  offer: "Free in-home estimate on a new system",
  tone: "friendly, plain-spoken and professional",
  differentiators: ["Licensed and insured (DEMO claim)", "Same-day service calls (DEMO claim)"],
  verifiedFacts: ["Family owned since 2009 (DEMO fact)", "NATE-certified technicians (DEMO fact)"],
  approvedPricing: "",
  unverifiedClaims: ["Lowest prices in town"],
  prohibitedClaims: ["Guaranteed lowest price", "Free repairs"],
  description: "DEMO DATA: a fictional business created by the 'Load demo business' button. It is not a real company, and nothing in it has been verified.",
  maxDailyBudgetCents: 2500,
});

/** True for text that is only demo data (the fictional business from "Load demo business"), so real findings may replace it. */
export function isDemoText(value) {
  const v = String(value ?? "").trim();
  if (!v) return false;
  if (/\(DEMO\b|DEMO DATA|DEMO claim|DEMO fact|\(fictional\)/i.test(v)) return true;
  const all = new Set();
  for (const x of Object.values(DEMO_BUSINESS)) { if (Array.isArray(x)) x.forEach((i) => all.add(i)); else if (typeof x === "string" && x) all.add(x); }
  return all.has(v);
}
