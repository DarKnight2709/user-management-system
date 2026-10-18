-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "InvitationDeliveryStatus" AS ENUM ('NOT_QUEUED', 'QUEUED', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "organization_invitations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "invited_by_id" TEXT NOT NULL,
    "accepted_by_id" TEXT,
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "last_requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resend_count" INTEGER NOT NULL DEFAULT 0,
    "delivery_version" INTEGER NOT NULL DEFAULT 1,
    "delivery_status" "InvitationDeliveryStatus" NOT NULL DEFAULT 'NOT_QUEUED',
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_invitations_token_hash_key" ON "organization_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "organization_invitations_organization_id_created_at_idx" ON "organization_invitations"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "organization_invitations_pending_email_key" ON "organization_invitations"("organization_id", "email") WHERE ("status" = 'PENDING');

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Canonical email and nonnegative counters also protect direct database writes.
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_email_check"
CHECK ("email" = lower(btrim("email")) AND length("email") > 0);
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_counters_check"
CHECK ("resend_count" >= 0 AND "delivery_version" >= 1);
