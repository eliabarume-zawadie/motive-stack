-- Phase 9: make the audit trail append-only IN THE DATABASE, not only by convention. Additive: no table or column changes and no data is touched.
-- Until now nothing in the code updated or deleted an audit row, but nothing STOPPED a bug, a script or a hand-typed statement from doing so. These triggers abort any
-- UPDATE or DELETE of an audit_events row. Erasing a person's data (see docs/launch-readiness.md) never edits the audit trail: audit rows carry ids, never names, e-mail
-- addresses or phone numbers. If audit retention is ever required, an owner-approved archive process must drop these triggers deliberately in its own migration.
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: rows cannot be changed');
END;

CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: rows cannot be deleted');
END;
