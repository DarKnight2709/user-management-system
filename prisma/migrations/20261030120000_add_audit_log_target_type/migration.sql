-- Allow audit-log reads to be recorded as auditable access events.
ALTER TYPE "AuditTargetType" ADD VALUE 'AUDIT_LOG';
