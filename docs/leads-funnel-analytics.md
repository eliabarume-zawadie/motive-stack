# Leads, funnel foundations and truthful analytics (Master PRD Phase 6)

All of this runs in mock mode. No lead is ever sent to a CRM by the features below, nothing is sent to any lead, there is no tracking pixel, no public form and no advertising-platform event transmission. The reporting shows only what this database holds.

## What a lead record says now

| Field | Meaning |
|---|---|
| **Origin** | `synthetic` (made by this app's simulator or a form test), `imported` (a person brought it in), `real` (captured by a verified integration: **nothing creates these yet**), `unknown` (older records that cannot be classified). |
| **Campaign and version** | The source campaign, and the campaign **version** in force when the lead was captured, when known. An import does not know it, so it says "version not recorded". A later campaign edit never rewrites it. |
| **Creative, format, form** | The creative version and format, and the form version, a test lead came through, validated against the campaign. |
| **UTM** | `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, as given. A campaign's own tag is its id. |
| **Attribution** | `observed` (a verified integration reported it: none exists; the simulator is marked observed only because this app generated the lead, and the lead is labelled synthetic), `inferred` (assigned or matched by a stated rule), `unknown` (the evidence does not support the link). The **basis** is stored and shown. |
| **Consent** | `given` or `not_recorded`, with a note. For imports it is the importer's statement, not verified here. |
| **Captured / stored** | When it was captured at its source (an import may carry a date, otherwise "not recorded") and when this app stored it. |
| **Follow-up** | A due date, note and done flag: **a reminder for the team**. This app has no e-mail, text or call capability. |

Attribution rules for an imported lead: no UTM tag → inferred (*assigned by the importer*); `utm_campaign` equals the chosen campaign → inferred (*utm matches campaign*); `utm_campaign` names another campaign → **unknown** (*the tag names another campaign*). A lead arriving after a campaign is never treated as proof the campaign caused it.

## Importing

Paste a CSV (header row; `fullName` or `name` required, then `email`, `phone`, `externalId`, `capturedAt`, `utm_*`) or a JSON list, up to 200 rows, into one campaign, with a required note saying where the leads came from and an optional consent statement. Each row is checked on its own: a bad row is rejected by number and the rest are stored. Imports are **idempotent** (an external id, or the same name and contact, is one lead) and each batch is recorded with who, when, the source note and counts. Imported leads get CRM status `not_synced`, queue **no job**, and are never contacted. The same email or phone on several leads is **shown, never merged**.

## Forms (architecture only)

A form is a definition: which of email and phone it asks for (at least one required), the privacy notice, consent wording, purpose and retention note (all required), versioned so an old version stays readable. It is **not published or hosted**: there is no public endpoint and no way for a visitor to submit it. A **test submission** (mock mode, `leads.simulate`) is validated against the current version (required fields, consent must be given), recorded as a **synthetic** lead tied to the form version, campaign version and any UTM or creative, and sent nowhere.

## Reporting (Results)

Each origin is counted **on its own**; there is no combined total. Per campaign and origin: leads, then the statuses the team set by hand. Attribution coverage (observed, inferred, unknown) is shown next to every count. Open, overdue and done follow-ups and imported-consent counts are shown.

Every metric carries its **source type**: actual, imported, entered by your team, synthetic, planned/estimate, or not known. What cannot be measured is listed as **Not measured** with a reason, never as zero and never with a figure: real leads, impressions, clicks, actual spend, cost per lead, click-through rate, conversion rate, return on ad spend. The only budget figure is the planned (approved) daily commitment, labelled intent, not spend. No performance chart exists because no verified performance data does.

## Permissions and data

`leads.import` (operator), `forms.read` (viewer), `forms.write` (operator), `analytics.read` (viewer). Existing `leads.read`, `leads.update` and `leads.simulate` are unchanged. Everything is workspace-private.

Migration `020_lead_lineage_forms.sql` (additive): new columns on `leads` (existing values untouched; the two existing synthetic leads were classified `synthetic` / `observed` / `simulator`), and tables `lead_import_batches`, `lead_forms`, `lead_form_versions`.

## Known gaps

| Gap | State |
|---|---|
| A lead with no campaign | Cannot be stored: `leads.campaign_id` and `lead_events.campaign_id` are NOT NULL. Needs a table rebuild migration, deferred to the Phase 9 data-model review. |
| Real lead capture, a public form, a tracking pixel | Not built and disabled by design; needs consent/privacy review and separate authorization. |
| Importing performance data (impressions, clicks, spend) or manual entry | Not built. Until then those metrics are "not measured". |
| Verified attribution | No integration reports it, so nothing is "observed" except what the simulator generated. |
| Consent verification, retention enforcement, deletion and export of a person's data | Recorded as text only; enforcement belongs to Phase 9 (privacy). |
| Merging duplicate contacts | Duplicates are shown, not merged. |
| Opportunity or revenue outcomes beyond won/lost | Not modelled; no sales value is stored, so no revenue figure exists. |
