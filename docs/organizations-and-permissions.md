# Organizations, custom permissions, separation of duties and the approve/run split (Master PRD Phase 1)

## Authentication limits (read first)

- Identity sits behind the auth runtime that `buildServer(ctx, auth)` takes. Two runtimes exist: the local **workspace token** (one shared secret per workspace, admin-equivalent, never a person) and an **OIDC verifier** for signed-in people.
- OIDC is **not configured for the browser**: this app has no sign-in page. Everything that needs a person (organizations, custom roles, member management, owner-only policy) is therefore exercised with **test identities** (in-memory keys and a simulated identity provider in `test/support/`). Production sign-in is not built, so none of this is a claim of production authentication.
- No temporary local account system was added.

## Organizations

- Every workspace belongs to exactly one organization (`workspaces.organization_id`). A direct business gets a **personal** organization automatically; nobody has to set one up or see it. An **agency** organization is created by a signed-in person and owns many client workspaces.
- Migration `015` creates a personal organization for every existing workspace (id `org_<workspace id>`) and keeps every workspace id and row. The backfill is idempotent, and the application re-runs a guarded version at start (it only fills in what is missing).
- **Organization membership never grants access to a workspace's data.** Workspace access is always an explicit workspace membership. Organization roles (`member`, `admin`, `owner`) only govern managing the organization: its people, its role templates and creating client workspaces.
- The creator of a client workspace becomes that workspace's owner. An organization **owner** can grant an organization member access to selected or all of the organization's workspaces as a built-in role (never `owner`) or a custom role. This writes ordinary workspace memberships; an existing owner is never downgraded, and a workspace in another organization looks like one that does not exist.
- The last owner of an organization or a workspace cannot be removed or demoted, and moving the last workspace owner to a custom role counts as demoting them.
- Organization-level changes have their own append-only trail (`organization_audit_events`, `GET /api/organizations/:oid/audit`); workspace-level effects also appear in the workspace Activity.
- **Not built:** agency-wide implicit sharing of templates or data, and automatic org-wide access for future workspaces. Access is by explicit, materialized membership.

## Custom roles

- A role template belongs to one organization and lists **exactly** the permissions it grants. A member with a custom role is judged by that set alone; it replaces the built-in set. Changes apply on the next request.
- Owner-only permissions can never be put in a custom role: `members.manage`, `roles.manage`, `policy.manage`, `credentials.read`, `credentials.manage`, `meta_accounts.manage`, `legacy_token.disable`. A custom role therefore cannot create owners or change policy.
- A role that is archived, deleted or from another organization grants **nothing**, never more. A role in use cannot be archived.
- `POST /api/organizations/:oid/role-preview` answers "what can this role do?" in plain language (grouped can / cannot, plus warnings such as a role that can both submit and approve) without saving anything.
- There is **no browser editor** for roles: the browser cannot sign in as a person. They are managed through the organization API by a signed-in owner. Settings shows a member's custom role read-only.

## Approving never runs anything

- `POST /proposals/:pid/approve` only records the decision. It no longer queues a job. The proposal stays `approved` and the dashboard lists it under "Needs your attention".
- `POST /proposals/:pid/execute` runs an approved action. It needs the new permission **`proposals.execute`** (admin by default, so the local token keeps working for simulated actions). It is idempotent (one job per proposal) and refuses a proposal that is not approved, whose approval expired, or whose approver no longer holds an approving role. The executor still re-checks everything before doing anything.
- Live (external) execution is unchanged and stays off unless the server is configured for it; nothing in this phase enables it.
- Approving and running are separate permissions in custom roles, so a role can approve without running or run without approving.

## Separation of duties

- Workspace policy `prevent_self_approval` is **on by default** and only an owner who is a signed-in person can change it (audited: `policy.changed`).
- A person cannot approve a proposal they proposed (`403 self_approval_not_allowed`). If who proposed it was never recorded, a person's approval is refused too (`separation_unprovable`) because separation cannot be proven. Rejecting your own proposal is allowed.
- **Local token mode cannot enforce it.** Everyone using the shared workspace token is the same identity. Approval there is allowed and recorded as `not_enforceable_token_mode` (in the approval row, the audit entry and the proposal card). It is never described as separation of duties.
- Each approval records how separation stood: `enforced`, `not_enforceable_token_mode` or `policy_off`.

## Compatibility notes

- Existing campaigns, proposals, leads and audit rows are untouched. Existing approvals have no `separation` value.
- Approval used to queue execution. Tests that approved and then expected the action to run now also call execute right after approving. A few tests where one person proposes and approves (about attribution, executor gates or Meta accounts) turn the policy off first; separation has its own tests.
- Campaign lifecycle vocabulary and campaign plans are **not** part of this phase.
