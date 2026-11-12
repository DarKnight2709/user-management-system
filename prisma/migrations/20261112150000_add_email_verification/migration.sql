-- AlterEnum
ALTER TYPE "UserSecurityTokenType" ADD VALUE 'EMAIL_VERIFICATION';

-- AlterTable
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMP(3);
