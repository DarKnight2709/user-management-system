-- CreateIndex
CREATE INDEX "users_active_created_at_id_idx" ON "users"("created_at" DESC, "id") WHERE ("deleted_at" IS NULL);
