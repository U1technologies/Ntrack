-- CreateEnum
CREATE TYPE "LedgerAccount" AS ENUM ('advertiser_receivable', 'publisher_payable', 'network_revenue', 'network_cost', 'cash');

-- CreateEnum
CREATE TYPE "InvoiceType" AS ENUM ('invoice', 'credit_note');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'issued', 'paid', 'void');

-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('incoming', 'outgoing');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('requested', 'approved', 'paid', 'rejected');

-- CreateEnum
CREATE TYPE "FraudStatus" AS ENUM ('open', 'confirmed', 'dismissed', 'appealed');

-- AlterTable
ALTER TABLE "conversions" ADD COLUMN     "booked_payout" DECIMAL(18,6) NOT NULL DEFAULT 0,
ADD COLUMN     "booked_revenue" DECIMAL(18,6) NOT NULL DEFAULT 0,
ADD COLUMN     "invoice_id" UUID,
ADD COLUMN     "payout_id" UUID;

-- CreateTable
CREATE TABLE "ledger_journals" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "reference" TEXT NOT NULL DEFAULT '',
    "memo" TEXT NOT NULL DEFAULT '',
    "currency" CHAR(3) NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_journals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "journal_id" UUID NOT NULL,
    "account" "LedgerAccount" NOT NULL,
    "advertiser_id" UUID,
    "publisher_id" UUID,
    "campaign_id" UUID,
    "conversion_id" UUID,
    "amount" DECIMAL(18,6) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "advertiser_id" UUID NOT NULL,
    "type" "InvoiceType" NOT NULL DEFAULT 'invoice',
    "number" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "currency" CHAR(3) NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL,
    "amount_paid" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "issued_at" TIMESTAMP(3),
    "due_date" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "voided_at" TIMESTAMP(3),
    "notes" TEXT NOT NULL DEFAULT '',
    "credit_for_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "campaign_id" UUID,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "direction" "PaymentDirection" NOT NULL,
    "advertiser_id" UUID,
    "publisher_id" UUID,
    "invoice_id" UUID,
    "payout_id" UUID,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "method" TEXT NOT NULL DEFAULT '',
    "reference" TEXT NOT NULL DEFAULT '',
    "paid_at" TIMESTAMP(3) NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publisher_payouts" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "publisher_id" UUID NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'requested',
    "currency" CHAR(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "conversion_count" INTEGER NOT NULL DEFAULT 0,
    "period_end" TIMESTAMP(3) NOT NULL,
    "requested_by_id" UUID,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "rejection_reason" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publisher_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "rate_to_base" DECIMAL(18,8) NOT NULL,
    "effective_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fraud_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "threshold" DECIMAL(18,6) NOT NULL,
    "window_minutes" INTEGER NOT NULL DEFAULT 60,
    "min_volume" INTEGER NOT NULL DEFAULT 0,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "action" TEXT NOT NULL DEFAULT 'flag',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fraud_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fraud_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "rule_id" UUID,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "risk_score" INTEGER NOT NULL,
    "publisher_id" UUID,
    "campaign_id" UUID,
    "click_id" TEXT,
    "conversion_id" UUID,
    "reason" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "status" "FraudStatus" NOT NULL DEFAULT 'open',
    "review_note" TEXT NOT NULL DEFAULT '',
    "appeal_note" TEXT NOT NULL DEFAULT '',
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "dedupe_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fraud_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_partners" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "adapter" TEXT NOT NULL DEFAULT 'csv',
    "revenue_share_percent" DECIMAL(5,2) NOT NULL DEFAULT 100,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "contact_email" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "search_partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_feeds" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "external_code" TEXT NOT NULL,
    "campaign_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_feeds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_revenue_records" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "feed_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "country" TEXT NOT NULL DEFAULT '',
    "searches" INTEGER NOT NULL DEFAULT 0,
    "paid_clicks" INTEGER NOT NULL DEFAULT 0,
    "gross_revenue" DECIMAL(18,6) NOT NULL,
    "net_revenue" DECIMAL(18,6) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'csv',
    "import_batch" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "search_revenue_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traffic_costs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "campaign_id" UUID,
    "feed_id" UUID,
    "source" TEXT NOT NULL,
    "cost" DECIMAL(18,6) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "clicks_purchased" INTEGER,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "traffic_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "travel_partners" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "product_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "adapter" TEXT NOT NULL DEFAULT 'generic',
    "commission_percent" DECIMAL(5,2),
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "campaign_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "travel_partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "travel_bookings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "conversion_id" UUID,
    "click_id" TEXT,
    "booking_ref" TEXT NOT NULL,
    "product_type" TEXT NOT NULL,
    "destination" TEXT NOT NULL DEFAULT '',
    "start_date" DATE,
    "end_date" DATE,
    "travelers" INTEGER,
    "booking_value" DECIMAL(18,2) NOT NULL,
    "commission" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'booked',
    "source" TEXT NOT NULL DEFAULT 'import',
    "reconciliation" TEXT NOT NULL DEFAULT 'unmatched',
    "discrepancy" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "travel_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "link" TEXT NOT NULL DEFAULT '',
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_reports" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "weekday" INTEGER,
    "hour_local" INTEGER NOT NULL DEFAULT 8,
    "config" JSONB NOT NULL,
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "last_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ledger_journals_organization_id_created_at_idx" ON "ledger_journals"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ledger_entries_organization_id_account_advertiser_id_idx" ON "ledger_entries"("organization_id", "account", "advertiser_id");

-- CreateIndex
CREATE INDEX "ledger_entries_organization_id_account_publisher_id_idx" ON "ledger_entries"("organization_id", "account", "publisher_id");

-- CreateIndex
CREATE INDEX "ledger_entries_conversion_id_idx" ON "ledger_entries"("conversion_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_public_id_key" ON "invoices"("public_id");

-- CreateIndex
CREATE INDEX "invoices_organization_id_status_idx" ON "invoices"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_organization_id_number_key" ON "invoices"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "payments_public_id_key" ON "payments"("public_id");

-- CreateIndex
CREATE INDEX "payments_organization_id_paid_at_idx" ON "payments"("organization_id", "paid_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "publisher_payouts_public_id_key" ON "publisher_payouts"("public_id");

-- CreateIndex
CREATE INDEX "publisher_payouts_organization_id_status_idx" ON "publisher_payouts"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_organization_id_currency_effective_date_key" ON "exchange_rates"("organization_id", "currency", "effective_date");

-- CreateIndex
CREATE INDEX "fraud_events_organization_id_status_created_at_idx" ON "fraud_events"("organization_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "fraud_events_publisher_id_idx" ON "fraud_events"("publisher_id");

-- CreateIndex
CREATE UNIQUE INDEX "fraud_events_organization_id_dedupe_key_key" ON "fraud_events"("organization_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "search_partners_public_id_key" ON "search_partners"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "search_feeds_partner_id_external_code_key" ON "search_feeds"("partner_id", "external_code");

-- CreateIndex
CREATE INDEX "search_revenue_records_organization_id_date_idx" ON "search_revenue_records"("organization_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "search_revenue_records_feed_id_date_country_key" ON "search_revenue_records"("feed_id", "date", "country");

-- CreateIndex
CREATE INDEX "traffic_costs_organization_id_date_idx" ON "traffic_costs"("organization_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "travel_partners_public_id_key" ON "travel_partners"("public_id");

-- CreateIndex
CREATE INDEX "travel_bookings_organization_id_reconciliation_idx" ON "travel_bookings"("organization_id", "reconciliation");

-- CreateIndex
CREATE UNIQUE INDEX "travel_bookings_partner_id_booking_ref_key" ON "travel_bookings"("partner_id", "booking_ref");

-- CreateIndex
CREATE INDEX "notifications_user_id_organization_id_read_at_idx" ON "notifications"("user_id", "organization_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_organization_id_user_id_type_key" ON "notification_preferences"("organization_id", "user_id", "type");

-- AddForeignKey
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "publisher_payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "ledger_journals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_advertiser_id_fkey" FOREIGN KEY ("advertiser_id") REFERENCES "advertisers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_advertiser_id_fkey" FOREIGN KEY ("advertiser_id") REFERENCES "advertisers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "publishers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "publisher_payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publisher_payouts" ADD CONSTRAINT "publisher_payouts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publisher_payouts" ADD CONSTRAINT "publisher_payouts_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "publishers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fraud_rules" ADD CONSTRAINT "fraud_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fraud_events" ADD CONSTRAINT "fraud_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fraud_events" ADD CONSTRAINT "fraud_events_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "fraud_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_partners" ADD CONSTRAINT "search_partners_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_feeds" ADD CONSTRAINT "search_feeds_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "search_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_revenue_records" ADD CONSTRAINT "search_revenue_records_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "search_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_revenue_records" ADD CONSTRAINT "search_revenue_records_feed_id_fkey" FOREIGN KEY ("feed_id") REFERENCES "search_feeds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traffic_costs" ADD CONSTRAINT "traffic_costs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_partners" ADD CONSTRAINT "travel_partners_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_bookings" ADD CONSTRAINT "travel_bookings_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "travel_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_reports" ADD CONSTRAINT "scheduled_reports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

