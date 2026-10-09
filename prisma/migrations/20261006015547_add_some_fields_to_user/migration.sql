/*
  Warnings:

  - You are about to drop the column `age` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `hashedPassword` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `users` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[username]` on the table `users` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `birth_date` to the `users` table without a default value. This is not possible if the table is not empty.
  - Added the required column `first_name` to the `users` table without a default value. This is not possible if the table is not empty.
  - Added the required column `hashed_password` to the `users` table without a default value. This is not possible if the table is not empty.
  - Added the required column `last_name` to the `users` table without a default value. This is not possible if the table is not empty.
  - Added the required column `username` to the `users` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "users" DROP COLUMN "age",
DROP COLUMN "hashedPassword",
DROP COLUMN "name",
ADD COLUMN     "birth_date" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "first_name" TEXT NOT NULL,
ADD COLUMN     "hashed_password" TEXT NOT NULL,
ADD COLUMN     "last_name" TEXT NOT NULL,
ADD COLUMN     "username" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
