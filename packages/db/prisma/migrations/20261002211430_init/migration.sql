-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "IpStorageMode" AS ENUM ('truncated', 'hashed', 'none');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'invited', 'disabled');

-- CreateEnum
CREATE TYPE "RoleScope" AS ENUM ('organization', 'advertiser', 'publisher', 'managed');

-- CreateEnum
CREATE TYPE "PartnerStatus" AS ENUM ('pending', 'active', 'suspended', 'rejected');

-- CreateEnum
CREATE TYPE "PaymentTerms" AS ENUM ('NET7', 'NET15', 'NET30', 'NET45', 'NET60', 'CUSTOM');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'pending', 'active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "CampaignVisibility" AS ENUM ('public', 'approval_required', 'private');

-- CreateEnum
CREATE TYPE "PayoutModel" AS ENUM ('CPA', 'CPL', 'CPS', 'CPI', 'CPC', 'CPM', 'REVSHARE', 'HYBRID');

-- CreateEnum
CREATE TYPE "RedirectMode" AS ENUM ('standard', 'transparent');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('pending', 'approved', 'rejected', 'blocked');

-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('pending_verification', 'active', 'inactive', 'failed');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'active',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_settings" (
    "organization_id" UUID NOT NULL,
    "ip_storage" "IpStorageMode" NOT NULL DEFAULT 'truncated',
    "collect_referrer" BOOLEAN NOT NULL DEFAULT true,
    "referrer_policy" TEXT NOT NULL DEFAULT 'strict-origin-when-cross-origin',
    "require_https_destinations" BOOLEAN NOT NULL DEFAULT true,
    "param_map" JSONB NOT NULL,
    "default_attribution_window_hours" INTEGER NOT NULL DEFAULT 720,
    "unique_click_window_hours" INTEGER NOT NULL DEFAULT 24,
    "duplicate_click_window_seconds" INTEGER NOT NULL DEFAULT 10,
    "click_retention_days" INTEGER NOT NULL DEFAULT 395,
    "mfa_required" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "is_platform_admin" BOOLEAN NOT NULL DEFAULT false,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_secret_encrypted" TEXT,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "key" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "scope" "RoleScope" NOT NULL DEFAULT 'organization',
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_key")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "advertiser_id" UUID,
    "publisher_id" UUID,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manager_assignments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "advertiser_id" UUID,
    "publisher_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manager_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "active_organization_id" UUID,
    "mfa_verified" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT NOT NULL DEFAULT '',
    "user_agent" TEXT NOT NULL DEFAULT '',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "actor_user_id" UUID,
    "actor_email" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT NOT NULL DEFAULT '',
    "user_agent" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advertisers" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "company_name" TEXT NOT NULL,
    "contact_name" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "country" VARCHAR(2) NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "tax_id" TEXT NOT NULL DEFAULT '',
    "status" "PartnerStatus" NOT NULL DEFAULT 'pending',
    "payment_terms" "PaymentTerms" NOT NULL DEFAULT 'NET30',
    "custom_payment_days" INTEGER,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "advertisers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publishers" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "company_name" TEXT NOT NULL,
    "contact_name" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "country" VARCHAR(2) NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "tax_info_encrypted" TEXT,
    "payment_details_encrypted" TEXT,
    "traffic_sources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "marketing_methods" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "promotional_channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "monthly_traffic" TEXT NOT NULL DEFAULT '',
    "business_category" TEXT NOT NULL DEFAULT '',
    "status" "PartnerStatus" NOT NULL DEFAULT 'pending',
    "payment_terms" "PaymentTerms" NOT NULL DEFAULT 'NET30',
    "custom_payment_days" INTEGER,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publishers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traffic_sources" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "traffic_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "advertiser_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "vertical" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL,
    "preview_url" TEXT NOT NULL DEFAULT '',
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "visibility" "CampaignVisibility" NOT NULL DEFAULT 'approval_required',
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "geo_allowed" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "geo_blocked" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "devices" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "operating_systems" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "browsers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_traffic_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "restricted_traffic_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conversion_goal" TEXT NOT NULL DEFAULT 'sale',
    "attribution_model" TEXT NOT NULL DEFAULT 'last_click',
    "attribution_window_hours" INTEGER NOT NULL DEFAULT 720,
    "payout_model" "PayoutModel" NOT NULL DEFAULT 'CPA',
    "revenue_model" "PayoutModel" NOT NULL DEFAULT 'CPA',
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "default_revenue" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "default_payout" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "daily_click_cap" INTEGER,
    "daily_conversion_cap" INTEGER,
    "monthly_budget" DECIMAL(18,2),
    "total_budget" DECIMAL(18,2),
    "frequency_cap" INTEGER,
    "redirect_mode" "RedirectMode" NOT NULL DEFAULT 'standard',
    "destination_param" TEXT NOT NULL DEFAULT 'url',
    "transparent_click_id_param" TEXT NOT NULL DEFAULT '',
    "allow_deep_links" BOOLEAN NOT NULL DEFAULT false,
    "allowed_hosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "require_https" BOOLEAN NOT NULL DEFAULT true,
    "fallback_url" TEXT,
    "referrer_policy" TEXT,
    "approved_at" TIMESTAMP(3),
    "approved_by_id" UUID,
    "archived_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "landing_pages" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "landing_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_publishers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "publisher_id" UUID NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'pending',
    "application_note" TEXT NOT NULL DEFAULT '',
    "decision_note" TEXT NOT NULL DEFAULT '',
    "decided_at" TIMESTAMP(3),
    "decided_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_publishers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_payouts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "publisher_id" UUID,
    "traffic_source_id" UUID,
    "country" VARCHAR(2),
    "device_type" TEXT,
    "event" TEXT,
    "payout" DECIMAL(18,6) NOT NULL,
    "revenue" DECIMAL(18,6) NOT NULL,
    "is_percentage" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_change_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "campaign_payout_id" UUID,
    "changed_by_id" UUID,
    "change_type" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_domains" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'affiliate',
    "advertiser_id" UUID,
    "status" "DomainStatus" NOT NULL DEFAULT 'pending_verification',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "verification_token" TEXT NOT NULL,
    "verified_at" TIMESTAMP(3),
    "ssl_status" TEXT NOT NULL DEFAULT 'unknown',
    "ssl_expires_at" TIMESTAMP(3),
    "domain_expires_at" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),
    "last_check_ok" BOOLEAN,
    "last_latency_ms" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tracking_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_health_checks" (
    "id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,
    "dns_ok" BOOLEAN NOT NULL,
    "https_ok" BOOLEAN NOT NULL,
    "status_code" INTEGER,
    "latency_ms" INTEGER,
    "ssl_expires_at" TIMESTAMP(3),
    "error" TEXT,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_health_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_domains" (
    "campaign_id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,

    CONSTRAINT "campaign_domains_pkey" PRIMARY KEY ("campaign_id","domain_id")
);

-- CreateTable
CREATE TABLE "tracking_links" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "publisher_id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,
    "landing_page_id" UUID,
    "name" TEXT NOT NULL DEFAULT '',
    "sub1" TEXT NOT NULL DEFAULT '',
    "sub2" TEXT NOT NULL DEFAULT '',
    "sub3" TEXT NOT NULL DEFAULT '',
    "sub4" TEXT NOT NULL DEFAULT '',
    "sub5" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT '',
    "extra_params" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tracking_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "link_templates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "link_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_public_id_key" ON "organizations"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_organization_id_slug_key" ON "roles"("organization_id", "slug");

-- CreateIndex
CREATE INDEX "user_roles_user_id_idx" ON "user_roles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_organization_id_user_id_key" ON "user_roles"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "manager_assignments_organization_id_user_id_idx" ON "manager_assignments"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "advertisers_public_id_key" ON "advertisers"("public_id");

-- CreateIndex
CREATE INDEX "advertisers_organization_id_status_idx" ON "advertisers"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "publishers_public_id_key" ON "publishers"("public_id");

-- CreateIndex
CREATE INDEX "publishers_organization_id_status_idx" ON "publishers"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "traffic_sources_organization_id_name_key" ON "traffic_sources"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_public_id_key" ON "campaigns"("public_id");

-- CreateIndex
CREATE INDEX "campaigns_organization_id_status_idx" ON "campaigns"("organization_id", "status");

-- CreateIndex
CREATE INDEX "campaigns_organization_id_advertiser_id_idx" ON "campaigns"("organization_id", "advertiser_id");

-- CreateIndex
CREATE UNIQUE INDEX "landing_pages_public_id_key" ON "landing_pages"("public_id");

-- CreateIndex
CREATE INDEX "landing_pages_campaign_id_idx" ON "landing_pages"("campaign_id");

-- CreateIndex
CREATE INDEX "campaign_publishers_organization_id_status_idx" ON "campaign_publishers"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_publishers_campaign_id_publisher_id_key" ON "campaign_publishers"("campaign_id", "publisher_id");

-- CreateIndex
CREATE INDEX "campaign_payouts_campaign_id_active_idx" ON "campaign_payouts"("campaign_id", "active");

-- CreateIndex
CREATE INDEX "payout_change_logs_campaign_id_created_at_idx" ON "payout_change_logs"("campaign_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tracking_domains_public_id_key" ON "tracking_domains"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_domains_hostname_key" ON "tracking_domains"("hostname");

-- CreateIndex
CREATE INDEX "tracking_domains_organization_id_status_idx" ON "tracking_domains"("organization_id", "status");

-- CreateIndex
CREATE INDEX "domain_health_checks_domain_id_checked_at_idx" ON "domain_health_checks"("domain_id", "checked_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tracking_links_public_id_key" ON "tracking_links"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_links_slug_key" ON "tracking_links"("slug");

-- CreateIndex
CREATE INDEX "tracking_links_organization_id_campaign_id_publisher_id_idx" ON "tracking_links"("organization_id", "campaign_id", "publisher_id");

-- CreateIndex
CREATE INDEX "tracking_links_domain_id_idx" ON "tracking_links"("domain_id");

-- CreateIndex
CREATE UNIQUE INDEX "link_templates_organization_id_name_key" ON "link_templates"("organization_id", "name");

-- AddForeignKey
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "permissions"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_advertiser_id_fkey" FOREIGN KEY ("advertiser_id") REFERENCES "advertisers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "publishers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_assignments" ADD CONSTRAINT "manager_assignments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_assignments" ADD CONSTRAINT "manager_assignments_advertiser_id_fkey" FOREIGN KEY ("advertiser_id") REFERENCES "advertisers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_assignments" ADD CONSTRAINT "manager_assignments_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "publishers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advertisers" ADD CONSTRAINT "advertisers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishers" ADD CONSTRAINT "publishers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traffic_sources" ADD CONSTRAINT "traffic_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_advertiser_id_fkey" FOREIGN KEY ("advertiser_id") REFERENCES "advertisers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_publishers" ADD CONSTRAINT "campaign_publishers_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_publishers" ADD CONSTRAINT "campaign_publishers_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "publishers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_payouts" ADD CONSTRAINT "campaign_payouts_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_payouts" ADD CONSTRAINT "campaign_payouts_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "publishers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_payouts" ADD CONSTRAINT "campaign_payouts_traffic_source_id_fkey" FOREIGN KEY ("traffic_source_id") REFERENCES "traffic_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_change_logs" ADD CONSTRAINT "payout_change_logs_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_domains" ADD CONSTRAINT "tracking_domains_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_domains" ADD CONSTRAINT "tracking_domains_advertiser_id_fkey" FOREIGN KEY ("advertiser_id") REFERENCES "advertisers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_health_checks" ADD CONSTRAINT "domain_health_checks_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "tracking_domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_domains" ADD CONSTRAINT "campaign_domains_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_domains" ADD CONSTRAINT "campaign_domains_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "tracking_domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "publishers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "tracking_domains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_landing_page_id_fkey" FOREIGN KEY ("landing_page_id") REFERENCES "landing_pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_templates" ADD CONSTRAINT "link_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
