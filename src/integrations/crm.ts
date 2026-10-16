import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";

export type CrmErrorKind = "transient" | "permission" | "validation";

export class CrmError extends Error {
  constructor(
    readonly kind: CrmErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CrmError";
  }
}

export interface CrmContactInput {
  workspaceId: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  source: string;
}

export interface CrmConnector {
  readonly platform: "ghl";
  readonly simulated: boolean;
  /** Create the contact, or update the existing one matched by email or phone. Never creates duplicates. */
  upsertContact(input: CrmContactInput): Promise<{ contactId: string; created: boolean }>;
}

export interface CrmFaults {
  transientFailuresRemaining?: number;
  permissionDenied?: boolean;
}

export const normalizeEmail = (e?: string | null): string | null => (e && e.trim() ? e.trim().toLowerCase() : null);
export const normalizePhone = (p?: string | null): string | null => {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 7 ? d : null;
};

interface ContactRow {
  id: string;
  email: string | null;
  phone: string | null;
}

/** Simulated GoHighLevel. Deduplicates on normalized email, then phone. */
export class MockGhlConnector implements CrmConnector {
  readonly platform = "ghl" as const;
  readonly simulated = true;

  constructor(
    private readonly db: Db,
    private readonly faults: CrmFaults,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async upsertContact(input: CrmContactInput): Promise<{ contactId: string; created: boolean }> {
    if (this.faults.permissionDenied) throw new CrmError("permission", "Simulated CRM permission error");
    if ((this.faults.transientFailuresRemaining ?? 0) > 0) {
      this.faults.transientFailuresRemaining = (this.faults.transientFailuresRemaining ?? 0) - 1;
      throw new CrmError("transient", "Simulated CRM outage");
    }
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);
    if (!email && !phone) throw new CrmError("validation", "A contact needs an email or phone");

    const at = this.now().toISOString();
    const find = (col: "email" | "phone", v: string | null) =>
      v ? (this.db.prepare(`SELECT id, email, phone FROM sim_crm_contacts WHERE workspace_id = ? AND ${col} = ?`).get(input.workspaceId, v) as ContactRow | undefined) : undefined;

    const existing = find("email", email) ?? find("phone", phone);
    if (existing) {
      // Fill gaps only when that value is not already owned by another contact.
      const newEmail = existing.email ?? (email && !find("email", email) ? email : null);
      const newPhone = existing.phone ?? (phone && !find("phone", phone) ? phone : null);
      this.db
        .prepare("UPDATE sim_crm_contacts SET email = ?, phone = ?, updated_at = ? WHERE id = ?")
        .run(newEmail, newPhone, at, existing.id);
      return { contactId: existing.id, created: false };
    }
    const id = `sim_ct_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.db
      .prepare("INSERT INTO sim_crm_contacts (id, workspace_id, email, phone, full_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, input.workspaceId, email, phone, input.fullName, at, at);
    return { contactId: id, created: true };
  }
}
