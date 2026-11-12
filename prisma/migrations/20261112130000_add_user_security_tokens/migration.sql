-- CreateEnum
CREATE TYPE "UserSecurityTokenType" AS ENUM ('PASSWORD_RESET');

-- CreateTable
CREATE TABLE "user_security_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "UserSecurityTokenType" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_security_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_security_tokens_token_hash_key" ON "user_security_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "user_security_tokens_user_id_type_idx" ON "user_security_tokens"("user_id", "type");

-- AddForeignKey
ALTER TABLE "user_security_tokens" ADD CONSTRAINT "user_security_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
