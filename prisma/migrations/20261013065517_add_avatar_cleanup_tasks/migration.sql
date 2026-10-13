-- CreateTable
CREATE TABLE "avatar_cleanup_tasks" (
    "id" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" TEXT,
    "lease_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "avatar_cleanup_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "avatar_cleanup_tasks_object_key_key" ON "avatar_cleanup_tasks"("object_key");

-- CreateIndex
CREATE INDEX "avatar_cleanup_tasks_next_attempt_at_idx" ON "avatar_cleanup_tasks"("next_attempt_at");
