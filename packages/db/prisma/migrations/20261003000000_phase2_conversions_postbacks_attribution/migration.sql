-- CreateEnum
CREATE TYPE "ConversionStatus" AS ENUM ('pending', 'approved', 'rejected', 'reversed');

-- CreateEnum
CREATE TYPE "ConversionSource" AS ENUM ('s2s', 'pixel', 'javascript', 'api', 'manual');

-- CreateEnum
CREATE TYPE "PostbackMethod" AS ENUM ('GET', 'POST');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('pending', 'success', 'failed', 'retrying');

-- AlterTable
ALTER TABLE "advertisers" ADD COLUMN     "postback_token_encrypted" TEXT,
ADD COLUMN     "postback_token_hash" TEXT;

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "allow_multiple_conversions" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "auto_approve_conversions" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "organization_settings" ADD COLUMN     "click_cookie_days" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "conversions" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "publisher_id" UUID NOT NULL,
    "advertiser_id" UUID NOT NULL,
    "click_id" TEXT NOT NULL,
    "link_id" UUID,
    "domain_id" UUID,
    "event" TEXT NOT NULL DEFAULT 'sale',
    "transaction_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "source" "ConversionSource" NOT NULL,
    "status" "ConversionStatus" NOT NULL DEFAULT 'pending',
    "status_reason" TEXT NOT NULL DEFAULT '',
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "sale_amount" DECIMAL(18,6),
    "revenue" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "payout" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "campaign_payout_id" UUID,
    "attribution_model" TEXT NOT NULL,
    "sub1" TEXT NOT NULL DEFAULT '',
    "sub2" TEXT NOT NULL DEFAULT '',
    "sub3" TEXT NOT NULL DEFAULT '',
    "sub4" TEXT NOT NULL DEFAULT '',
    "sub5" TEXT NOT NULL DEFAULT '',
    "traffic_source" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "device_type" TEXT NOT NULL DEFAULT '',
    "custom_params" JSONB NOT NULL DEFAULT '{}',
    "clicked_at" TIMESTAMP(3) NOT NULL,
    "converted_at" TIMESTAMP(3) NOT NULL,
    "click_invalid" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversion_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "conversion_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actor_user_id" UUID,
    "note" TEXT NOT NULL DEFAULT '',
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversion_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribution_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "conversion_id" UUID NOT NULL,
    "click_id" TEXT NOT NULL,
    "publisher_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "credit" DECIMAL(7,6) NOT NULL,
    "clicked_at" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attribution_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "postbacks" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "publisher_id" UUID,
    "campaign_id" UUID,
    "name" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY['conversion.created']::TEXT[],
    "method" "PostbackMethod" NOT NULL DEFAULT 'GET',
    "url_template" TEXT NOT NULL,
    "body_template" JSONB,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "auth_token_encrypted" TEXT,
    "hmac_secret_encrypted" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "postbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "postback_id" UUID NOT NULL,
    "conversion_id" UUID,
    "event_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "request_method" TEXT NOT NULL,
    "request_url" TEXT NOT NULL,
    "request_body" TEXT,
    "response_status" INTEGER,
    "response_body" TEXT,
    "duration_ms" INTEGER,
    "error" TEXT,
    "is_test" BOOLEAN NOT NULL DEFAULT false,
    "last_attempt_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversions_public_id_key" ON "conversions"("public_id");

-- CreateIndex
CREATE INDEX "conversions_organization_id_converted_at_idx" ON "conversions"("organization_id", "converted_at" DESC);

-- CreateIndex
CREATE INDEX "conversions_organization_id_status_idx" ON "conversions"("organization_id", "status");

-- CreateIndex
CREATE INDEX "conversions_campaign_id_converted_at_idx" ON "conversions"("campaign_id", "converted_at");

-- CreateIndex
CREATE INDEX "conversions_publisher_id_converted_at_idx" ON "conversions"("publisher_id", "converted_at");

-- CreateIndex
CREATE INDEX "conversions_click_id_idx" ON "conversions"("click_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversions_organization_id_idempotency_key_key" ON "conversions"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "conversion_events_conversion_id_created_at_idx" ON "conversion_events"("conversion_id", "created_at");

-- CreateIndex
CREATE INDEX "attribution_events_conversion_id_version_idx" ON "attribution_events"("conversion_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "postbacks_public_id_key" ON "postbacks"("public_id");

-- CreateIndex
CREATE INDEX "postbacks_organization_id_active_idx" ON "postbacks"("organization_id", "active");

-- CreateIndex
CREATE INDEX "webhook_deliveries_organization_id_created_at_idx" ON "webhook_deliveries"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_postback_id_created_at_idx" ON "webhook_deliveries"("postback_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "advertisers_postback_token_hash_key" ON "advertisers"("postback_token_hash");

-- AddForeignKey
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "publishers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_advertiser_id_fkey" FOREIGN KEY ("advertiser_id") REFERENCES "advertisers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_conversion_id_fkey" FOREIGN KEY ("conversion_id") REFERENCES "conversions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_events" ADD CONSTRAINT "attribution_events_conversion_id_fkey" FOREIGN KEY ("conversion_id") REFERENCES "conversions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postbacks" ADD CONSTRAINT "postbacks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postbacks" ADD CONSTRAINT "postbacks_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "publishers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postbacks" ADD CONSTRAINT "postbacks_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_postback_id_fkey" FOREIGN KEY ("postback_id") REFERENCES "postbacks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_conversion_id_fkey" FOREIGN KEY ("conversion_id") REFERENCES "conversions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

