-- Allow unauthenticated account registration to be attributed accurately.
ALTER TYPE "AuditActorType" ADD VALUE 'ANONYMOUS';
