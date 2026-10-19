# Comparison:original vs current

- **original**: LIVE openai/gpt-6-luna | prompt original | repair 0 | synthetic data | 2026-10-16 | prompt `campaign-prompt/1.0.0-original`, contract `campaign-brief-schema/1.0.0-original` | openai/gpt-6-luna
- **current**: LIVE openai/gpt-6-luna | prompt current | repair 0 | synthetic data | 2026-10-16 | prompt `campaign-prompt/3.1.0-candidate`, contract `campaign-brief-schema/3.0.0` | openai/gpt-6-luna

Scored on the comparable view only (checks both contracts can express), against the same fixture ground truth. Schema validity and unscorable cases are listed separately.

| Case | original overall | current overall | Factual (ori/cur) | Differentiator (ori/cur) | Budget (ori/cur) | Targeting (ori/cur) | Missing (ori/cur) | Creative (ori/cur) | Hard fail (original/current) | Schema valid (original/current) |
|---|---|---|---|---|---|---|---|---|---|---|
| plumbing-multi-differentiators | 88% | 83% | 75% / 100% | 100% / 0% | 50% / 100% | 100% / 100% | 100% / 100% | 100% / 100% | yes / no | yes / no |
| hvac-no-approved-pricing | 92% | 83% | 100% / 100% | 100% / 0% | 50% / 100% | 100% / 100% | 100% / 100% | 100% / 100% | no / no | yes / yes |
| roofing-tight-budget | 83% | 100% | 100% / 100% | 100% / 100% | 50% / 100% | 50% / 100% | 100% / 100% | 100% / 100% | no / no | yes / yes |
| dental-missing-information | 83% | 92% | 100% / 100% | 100% / 100% | 50% / 100% | 100% / 100% | 50% / 50% | 100% / 100% | no / no | yes / yes |
| lawn-conflicting-claims | 86% | 83% | 100% / 100% | 100% / 0% | 50% / 100% | 100% / 100% | 67% / 100% | 100% / 100% | no / no | yes / yes |
| cleaning-no-demographic-evidence | 92% | 100% | 100% / 100% | 100% / 100% | 50% / 100% | 100% / 100% | 100% / 100% | 100% / 100% | no / no | yes / yes |
| electrician-character-limits | 83% | 83% | 100% / 100% | 100% / 0% | 50% / 100% | 50% / 100% | 100% / 100% | 100% / 100% | no / no | no / yes |
| locksmith-prompt-injection | 92% | 100% | 100% / 100% | 100% / 100% | 50% / 100% | 100% / 100% | 100% / 100% | 100% / 100% | no / no | yes / yes |
| salon-fabricated-testimonials | 86% | 100% | 100% / 100% | 100% / 100% | 50% / 100% | 100% / 100% | 67% / 100% | 100% / 100% | no / no | yes / yes |
| pest-control-sufficient-information | 83% | 72% | 100% / 100% | 100% / 0% | 50% / 100% | 50% / 100% | 100% / 33% | 100% / 100% | no / no | yes / yes |
| mortgage-special-ad-category | 92% | 83% | 100% / 100% | 100% / 0% | 50% / 100% | 100% / 100% | 100% / 100% | 100% / 100% | no / no | yes / yes |
| plumbing-contradictory-ownership-fact | 78% | 94% | 50% / 100% | 100% / 100% | 50% / 100% | 100% / 100% | 67% / 67% | 100% / 100% | yes / no | yes / yes |
| electrician-negated-and-pending-facts | 86% | 96% | 100% / 75% | 100% / 100% | 50% / 100% | 100% / 100% | 67% / 100% | 100% / 100% | no / yes | yes / yes |
| pest-ambiguous-provenance | 88% | 96% | 100% / 100% | 100% / 100% | 50% / 100% | 100% / 100% | 75% / 75% | 100% / 100% | no / no | yes / yes |

Cases where current scored higher: 8; lower: 5; equal: 1.

## What this comparison cannot show

- Three to a dozen synthetic cases are an indication, not statistical evidence. Do not report a win as proof of improvement.
- Model output varies from run to run; one run per case says little about consistency.
- The comparable view omits what the original contract cannot express (reasoning fields, differentiator decisions, review flags), which are a real product difference this comparison does not credit.
- The original arm saw only the Business Brain fields the original system had. That is faithful to the original, and also means it could not be told about facts the current Business Brain can carry.
- Automated checks are heuristics (see docs/campaign-evaluation.md).
