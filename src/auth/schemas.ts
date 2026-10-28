import { z } from "zod";
import { ACCOUNT_ID_RE } from "../app/metaAccounts.js";
import { ROLES } from "./authz.js";

/** Request bodies for membership management. Strict: unknown fields are rejected, so no client field can sneak in a user id, role or workspace. */
export const MemberAddSchema = z.object({ userId: z.string().trim().min(1).max(64), role: z.enum(ROLES) }).strict();
/** Either a built-in role or a custom role id: exactly one. */
export const MemberRoleSchema = z.object({ role: z.enum(ROLES).optional(), customRoleId: z.string().trim().min(1).max(64).optional() }).strict()
  .refine((b) => (b.role !== undefined) !== (b.customRoleId !== undefined), { message: "Choose either a built-in role or a custom role" });
export const MetaAccountSchema = z.object({ accountId: z.string().regex(ACCOUNT_ID_RE) }).strict();
/** Body of PUT /credentials/:kind. Strict: any other field is rejected. The vault does the real validation of the values. */
export const CredentialPutSchema = z.object({ secret: z.string(), label: z.string().nullable().optional() }).strict();
/** Revoke and delete take no body (an empty object is accepted). */
export const EmptyBodySchema = z.object({}).strict();
export const ClaimSchema = z.object({ workspaceId: z.string().trim().min(1).max(64), token: z.string().min(1).max(256) }).strict();
