-- CreateEnum
CREATE TYPE "RedirectResponse" AS ENUM ('redirect_302', 'html_200');

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "redirect_response" "RedirectResponse";

-- AlterTable
ALTER TABLE "organization_settings" ADD COLUMN     "redirect_response" "RedirectResponse" NOT NULL DEFAULT 'redirect_302';

