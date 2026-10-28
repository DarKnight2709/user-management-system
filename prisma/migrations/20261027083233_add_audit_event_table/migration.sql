-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditTargetType" AS ENUM ('USER', 'ORGANIZATION', 'ORGANIZATION_MEMBER', 'ROLE', 'ORGANIZATION_INVITATION');

-- CreateTable
CREATE TABLE "audit_events" (
    "event_id" UUID NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_type" "AuditActorType" NOT NULL,
    "target_id" TEXT NOT NULL,
    "target_type" "AuditTargetType" NOT NULL,
    "organization_id" TEXT,
    "request_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "audit_events_actor_id_occurred_at_event_id_idx" ON "audit_events"("actor_id", "occurred_at", "event_id");

-- CreateIndex
CREATE INDEX "audit_events_target_type_target_id_occurred_at_event_id_idx" ON "audit_events"("target_type", "target_id", "occurred_at", "event_id");

-- CreateIndex
CREATE INDEX "audit_events_action_occurred_at_event_id_idx" ON "audit_events"("action", "occurred_at", "event_id");

-- CreateIndex
CREATE INDEX "audit_events_organization_id_occurred_at_event_id_idx" ON "audit_events"("organization_id", "occurred_at", "event_id");
