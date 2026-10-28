# Brand Kit and the asset library (Master PRD Phase 2)

Generation stays mocked: nothing here calls an image or video provider, and no cloud storage is used.

## Business facts and brand preferences are different things

- The **Business Brain** holds facts about the business and where each came from. A claim may appear in an ad only if it is a reviewed Business Brain fact.
- The **Brand Kit** holds preferences: voice words, words to avoid, call-to-action style, colours, typography and image guidance, logo rules, the owner's own description of audiences, channel notes and disclaimer wording. It is a strict schema: it **cannot carry** services, credentials, prices or other business facts (such fields are rejected), and it never makes a claim usable. Audience text is the owner's hypothesis, not evidence about real customers. Disclaimer text is wording to show, not a fact.
- The two are stored in separate tables and edited in separate places (My business, Brand). Saving one never touches the other.
- **Not wired into generation yet.** The campaign prompt does not read the Brand Kit in this phase (the pinned prompt is unchanged). Only an approved Brand Kit version may be used for that later.

## Brand Kit lifecycle

`PUT /brand-kit` saves a new immutable **version** and returns the kit to `draft` (saving identical content changes nothing). A person submits a version for review. Approving or rejecting names the **exact version**: if the kit changed since the reviewer opened it the decision is refused as stale. Editing after approval creates a newer draft; the approved version and its content remain available as `approved`, and the newer draft needs its own review. Rejection needs a reason. Separation of duties uses the same rule as proposals: with the workspace policy on, the person who submitted cannot approve; the shared local token cannot be told apart from itself, so there the approval is allowed and recorded as `not_enforceable_token_mode`.

Permissions: `brandkit.read` (viewer), `brandkit.write` (operator), `brandkit.approve` (admin). Custom roles may include them.

## Assets

- An **asset** (logo, image, poster, template, reference) has immutable **versions**. Each version has its own file, size, dimensions, SHA-256, source (`uploaded` or `imported`; `generated` is reserved for a later phase), rights (`owned`, `licensed`, `stock`, `client_supplied`, `unknown`, with licence note, usage restrictions and an optional expiry date), lineage (`parentVersion`), and review status (`draft`, `needs_review`, `approved`, `rejected`, `superseded`).
- An **imported** file must say where it came from (`sourceNote`).
- **Approval** of a version needs stated rights (not `unknown`), an unexpired licence, a version that was submitted, a second person when separation is on, and no newer version already approved. Approving a version marks the previously approved one `superseded`; its file stays retrievable, so anything approved earlier is reproducible. A new draft version never replaces the approved one: consumers use `approvedVersion`.
- Identical bytes already in the workspace are **reported** (`duplicateOf`), not blocked.
- Archiving hides an asset from the default list and blocks further changes; files are kept.
- Permissions: `assets.read` (viewer), `assets.write` (operator: upload, add a version, submit), `assets.review` (admin: approve or reject), `assets.archive` (admin).

### What an upload must pass

- PNG, JPEG or WebP only, decided from the **file's own bytes** (not its name or declared type). SVG, GIF, HTML and scripts are refused. Dimensions come from the header; zero or over 12,000 pixels per side is refused.
- Size: 5 MB per file, 200 MB and 500 assets per workspace (defaults; `assetLimits` in the context). The size is checked on the encoded text before it is decoded.
- The body is JSON (base64) so no new dependency is needed. Unknown or unsafe fields are rejected; names cannot contain control characters and are never used in a path.

### Storage

- Behind `AssetStore` (`src/storage/assetStore.ts`). The default for tests is in memory. The server uses a local folder, `data/assets/` (override with `ASSET_DIR`), which is git-ignored.
- Keys are built only from validated ids and a fixed extension (`workspace/asset/vN.ext`); anything else is refused. The resolved path must stay inside the folder. A version's file is never overwritten (`wx`). If the database write fails the just-written file is removed.
- Serving: `GET /assets/:aid/versions/:v/file` needs `assets.read`, finds the row **in the caller's workspace first**, checks the stored bytes still match their SHA-256 (else `asset_integrity`), and sends the type read at upload with `nosniff`, `no-store` and `Content-Security-Policy: default-src 'none'; sandbox`. The response never includes a storage path.
- The page previews images by fetching the file with its own credentials and drawing it on a canvas, so the page's content policy (no `blob:` or `data:` images) is unchanged.
- **Not production storage.** There is no backup, retention, encryption at rest, malware scanning, or object-store access control. Those are Phase 9 prerequisites.

## Known gaps

- The browser has no sign-in, so the Brand and asset screens run with the shared local token (admin-equivalent); separation of duties is therefore not enforceable there and is recorded as such.
- Saved Business Brain items are labelled website / owner / demo / default. They are not yet labelled "AI-inferred" or "imported", and the fill ledger still relies on the browser's report of what it added (reconciled on save). Both stay open from the Master PRD Phase 2 list.
- No video, carousel or document files, no campaign linking (Phase 4), and no use of the Brand Kit in generation.
