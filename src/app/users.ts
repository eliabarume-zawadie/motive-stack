import type { Identity } from "../auth/types.js";
import { iso, type Core } from "./core.js";
import { newId } from "./util.js";

export interface User {
  id: string;
  issuer: string;
  subject: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
  lastSeenAt: string;
}

interface UserRow {
  id: string;
  issuer: string;
  subject: string;
  email: string | null;
  display_name: string | null;
  created_at: string;
  last_seen_at: string;
}

const toUser = (r: UserRow): User => ({ id: r.id, issuer: r.issuer, subject: r.subject, email: r.email, displayName: r.display_name, createdAt: r.created_at, lastSeenAt: r.last_seen_at });

/** Read-only: the user for a verified identity, or null. Never creates or updates anything. */
export function findUser(c: Core, identity: Identity): User | null {
  const r = c.db.prepare("SELECT * FROM users WHERE issuer = ? AND subject = ?").get(identity.issuer, identity.subject) as UserRow | undefined;
  return r ? toUser(r) : null;
}

/**
 * Find or create the internal user for a VERIFIED identity. The key is (issuer, subject): never the email address, which a person can
 * change and which another account could later claim. A user row proves who someone is; it grants access to no workspace (Milestone 4.2).
 */
export function upsertUser(c: Core, identity: Identity): User {
  const at = iso(c);
  const r = c.db
    .prepare(
      `INSERT INTO users (id, issuer, subject, email, display_name, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(issuer, subject) DO UPDATE SET email = excluded.email, display_name = excluded.display_name, last_seen_at = excluded.last_seen_at
       RETURNING *`,
    )
    .get(newId("usr"), identity.issuer, identity.subject, identity.email, identity.displayName, at, at) as UserRow;
  return toUser(r);
}
