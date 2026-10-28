# Experiments, the Marketing Brain and recommendations (Master PRD Phase 7)

Everything here is a **record or a decision**. Nothing in this phase changes a budget, edits a campaign, switches a creative, publishes anything or contacts an outside service, and a test checks that the code has no path to do so. This app measures **no performance**: results are entered or imported by people and labelled with their source.

## Experiments

An experiment plan holds a **hypothesis**, the **one principal variable** that differs (headline, primary text, call to action, creative image, audience, placement, offer, other) and how, the audience and placement, a **success measure**, a **planned duration**, the **minimum data per variant**, and a **decision rule written before the data**. Each variant is pinned to an **exact campaign version** (and optionally a creative version), so the comparison stays reproducible. There must be exactly **one control**, labels must differ, two variants may not point at the same version, and a creative-image test needs creative versions on every variant. The app flags design problems it can see (variants from different campaigns; variable kinds it cannot check) and relies on your note for the rest.

**Lifecycle:** draft (editable) → running → concluded or abandoned. **Starting freezes the plan**: the hypothesis, variants and decision rule cannot be changed to suit the data. Start a new experiment instead.

**What is recorded while running**
- **What was actually used**, by variant and dates, separately from the plan. A plan is not a record of what ran, and the analysis says when no record exists.
- **Results**, entered or imported by a person: either successes out of trials or a plain value, with a required source note and a source type: *entered by your team*, *imported*, or *synthetic*. Synthetic numbers are labelled and add nothing to the sample.

**Analysis** (computed on every read)
- Leads are counted **by exact campaign version** (and creative version when named) and **by origin**; leads with no recorded version are reported as not counted (an import can state the version it was captured under).
- Warnings that **block a conclusion**: planned duration not reached, data below the planned minimum, only synthetic data, the success measure not entered (cost per lead, click-through rate and conversion rate are never computed by the app). Warnings to keep in mind: no record of use, mixed sources (shown separately, never added), leads without a version, and always: **assignment to variants cannot be verified**.
- **No claim of statistical significance.** A pooled two-proportion test is shown only for two variants, with at least the planned minimum, at least 5 successes and 5 failures per group, from one non-synthetic source, and then only as **INDICATIVE ONLY**, because the app cannot check random assignment or equal exposure. Otherwise it says why no test was run.
- "Readiness" means the plan's time and data are met. It does not mean the result is true.

**Concluding** (admin) records a decision (*variant better*, *control better*, *no clear difference*) and a rationale. Picking a winner while the data warnings block requires an explicit acknowledgement, and the warnings standing at that moment are stored with the decision. Concluding changes nothing else. A concluded experiment's results are locked.

## The Marketing Brain (learnings)

A learning records a statement, its **kind**, **source** (an experiment, an approved or rejected creative, campaign history, a note or an import, traced to a record that must exist), the **date observed**, a **confidence**, and what it **does not show** (required). It states whether it was **written by a person** or **suggested by a rule**, and whether a person has confirmed it.

- Every learning starts as a **suggestion**; an admin **confirms**, **rejects** (with a reason) or **retires** (with a reason) it. With separation of duties on, the person who wrote a learning cannot confirm it. A rule-made suggestion has no human author, so its confirmation records `machine_suggested`.
- **Suggestions come from plain rules, not a model**, once each (running it again adds nothing): a concluded experiment's outcome (as "judged", with the data warnings as limits), a rejected creative's review reason, an approved creative's headline ("approval is a judgement about fit, not evidence it performs"). All are low confidence.
- **A learning is never a business fact.** It cannot enter the Business Brain, and the claim checks read the Business Brain and nothing here: confirming "we are the cheapest" does not make that claim usable in a creative (a test proves it).

## Recommendations

Derived from records **on every read**; only a person's decision about one is stored. Each names its **evidence** (the records behind it), its **uncertainty**, and that it **needs a person's decision**: test one change on a campaign that has an approved creative and no experiment; an experiment that still needs data (and why); one that has met its plan; one whose only data is synthetic; a concluded experiment with no recorded learning; learnings waiting for confirmation. **Accepting** records the decision and nothing else; dismissing needs a reason.

## Permissions and data

`experiments.read` / `learnings.read` / `recommendations.read` (viewer); `experiments.write` and `learnings.write` (operator: plan, start, record, write, generate suggestions); `experiments.decide`, `learnings.confirm` and `recommendations.decide` (admin). Custom roles may include them. Waiting suggestions and an experiment past its planned end appear in the Phase 5 inbox. Everything is workspace-private.

Migration `021_experiments_learnings.sql` (additive): `experiments`, `experiment_variants`, `experiment_usage`, `experiment_observations`, `learnings`, `recommendation_decisions`. The lead import also gained an optional `campaignVersion` (the importer's statement) so imported leads can be assigned to a variant.

## Known gaps

| Gap | State |
|---|---|
| Real performance data | Not measured; no import of impressions, clicks or spend exists, so those success measures rely on numbers a person enters. |
| Random assignment, equal exposure, audience splits | Not controlled or verified by the app; the analysis says so every time. |
| More than two variants | Shown but not statistically compared. |
| Sequential or Bayesian methods, multiple-testing corrections, power calculations | Not built. The minimum data per variant is the owner's own number. |
| Acting on a result | Deliberately not built: no budget shift, campaign edit or publishing, with or without approval, in this release. |
| Learning supersession and linking to a campaign brief | A retired learning is kept; learnings are not yet shown inside campaign drafting. |
| AI-written suggestions | Not built; suggestions are plain rules. |
