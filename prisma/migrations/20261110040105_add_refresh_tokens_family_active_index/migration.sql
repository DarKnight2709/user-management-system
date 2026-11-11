-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_active_idx" ON "refresh_tokens"("family_id") WHERE ("revoked_at" IS NULL);
