-- AlterTable
ALTER TABLE "organization_settings" ADD COLUMN     "api_daily_request_limit" INTEGER NOT NULL DEFAULT 100000;

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_ips" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requests_per_minute" INTEGER NOT NULL DEFAULT 120,
    "created_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "last_used_ip" TEXT NOT NULL DEFAULT '',
    "revoked_at" TIMESTAMP(3),
    "replaced_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_secret_hash_key" ON "api_keys"("secret_hash");

-- CreateIndex
CREATE INDEX "api_keys_organization_id_created_at_idx" ON "api_keys"("organization_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

