# Creative Studio: still images (Master PRD Phase 4)

Everything here is mock. The only image provider is an offline placeholder drawn on this computer. No image service is contacted, nothing is published, nothing costs money, and no live media call exists in the code.

## The flow

brief → concept → pictures → automatic checks → revision → approval → link to the campaign's proposal.

1. **Brief and concept.** A creative belongs to one campaign. It holds a structured brief (objective, main message, audience note, look and feel), a concept (headline up to 40 characters, supporting line up to 125, call to action, what the picture should show, three colours), alt text and the formats it needs: `1:1`, `4:5`, `9:16`, `1.91:1`. "Start from an idea" offers rule-based suggestions built from the campaign's own headlines and primary text and the approved Brand Kit colours. They are **not AI**, and every field stays editable.
2. **Pictures.** "Make the pictures" queues one persisted job per format (`render_image`, the same queue as other background work). Jobs survive a restart, retry on a temporary provider failure (bounded, with backoff), can be cancelled, and can be retried by hand at most twice. A workspace can make 40 pictures a day.
3. **Complete means validated and stored.** A render is `succeeded` only after its bytes passed a strict PNG check (signature, every chunk checksum, header, end marker, exact pixel-data size), matched the format's shape, and were stored as an asset version. A cut-short file, a non-image or a wrong-shaped picture is thrown away: no asset, no picture attached, the render shows `failed` with what to do. Progress shows as queued, making, checking, saving.
4. **Checks.** See below.
5. **Revision.** Saving never changes an existing version: it adds one. Pictures are carried over when the look (description and colours) did not change, so fixing a word does not remake them.
6. **Approval.** Send for review needs every automatic check to pass. Approval re-runs them against the **current** Business Brain and approved Brand Kit and reads each stored picture back (hash verified). With separation of duties on, someone other than the submitter approves (the shared local token records `not_enforceable_token_mode`, as for proposals). Approving a creative approves its own generated pictures with it. An imported picture must already be approved on its own.
7. **Link to the campaign.** A proposal for a campaign lists its approved creatives in the proposal payload, pinned to exact versions and picture hashes, so the approval covers exactly those pictures. Approving or running the proposal is refused (`creative_changed`) if a listed creative was archived or its pictures changed. A campaign without an approved creative proposes exactly as before.

**What the link does not do.** Nothing sends a picture to an ad platform: the executor still creates a paused simulated draft only. The proposal records which pictures the approval covered.

## Imported pictures

An **approved** library image of the right shape (within 1%) can be attached to a format. Cropping is not built: a wrong-shaped image is refused with a reason. An attached image keeps its own rights and provenance. Generated pictures are stored as assets with source `generated`, rights `generated`, and provider and model recorded.

## The quality gate

Three different things are kept apart and labelled:

| Kind | In this release |
|---|---|
| **Deterministic checks** | Run. Same input, same answer. Each failure carries repair guidance. |
| **AI-assisted critique** | **Not performed.** Always shown as "not performed", never as a pass. |
| **Human approval** | A person approves one exact version. |

Checks: copy length; a stored, readable, correctly shaped picture per format; placeholder art called out as a warning; words the approved Brand Kit says to avoid; Brand Kit colours (warning); claims against the Business Brain using the same grounding rules as campaign copy; no invented testimonials or ratings; rights (stated, unexpired, not archived, imported picture approved); alt text; text and accent colour contrast. Without an approved Brand Kit the brand checks say they are limited. The score is the share of automatic checks passed: a review aid, **not a prediction** of results.

Not checked, and said so: words drawn inside a picture (the mock draws none), and whether a picture is actually good.

## Providers and video

`src/creative/image.ts` defines a capability-aware `ImageProvider` (formats, ratios, mock or not, offline, renders text, deterministic). Only `MockImageProvider` exists; it supports test-only failure injection. `src/creative/video.ts` declares what a video provider must say about itself and lists video as **not built**: no storyboard or video job exists and the database accepts only static images. Mock storyboard/video jobs follow only after the image flow is stable, through the same job, validate, check and approval path.

## Permissions and data

`creatives.read` (viewer), `creatives.write` (operator: make, edit, render, cancel, attach, send for review, archive), `creatives.review` (admin: approve or reject). Custom roles may include them. Everything is workspace-private; another workspace cannot see a creative, picture or render (404).

Migration `018_creative_studio.sql` (additive): `creatives`, `creative_versions`, `creative_renders`, `creative_variants`. No existing table changed.

## Known gaps

| Gap | State |
|---|---|
| Real image generation | Not built; needs separate explicit authorization, a provider and a safety review. |
| Video, storyboards, carousels | Declared in code only. |
| AI critique | Not performed. |
| Cropping or resizing an imported image | Not built. |
| Words in the picture | The mock draws none; text is not checked inside pictures. |
| Proposal screen | The payload pins the pictures; the proposal card does not list them yet. |
| Sending pictures to a platform | Not built; the executor is unchanged. |
| Picture storage | Local development folder, no backup or retention. |
