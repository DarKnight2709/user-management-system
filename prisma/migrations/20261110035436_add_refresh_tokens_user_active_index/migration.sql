-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_active_idx" ON "refresh_tokens"("user_id") WHERE ("revoked_at" IS NULL);
