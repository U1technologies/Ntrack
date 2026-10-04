-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "conversion_tracking" TEXT NOT NULL DEFAULT 'server_postback';

-- AlterTable
ALTER TABLE "conversions" ADD COLUMN     "app_name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "gaid" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "idfa" TEXT NOT NULL DEFAULT '';

