-- CreateEnum
CREATE TYPE "DataRequestType" AS ENUM ('export', 'erasure');

-- CreateEnum
CREATE TYPE "DataRequestStatus" AS ENUM ('pending_review', 'approved', 'processing', 'completed', 'rejected', 'failed');

-- CreateEnum
CREATE TYPE "DataSubjectType" AS ENUM ('user', 'publisher', 'advertiser', 'organization');

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "billing_snapshot" JSONB;

-- CreateTable
CREATE TABLE "data_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "type" "DataRequestType" NOT NULL,
    "subject_type" "DataSubjectType" NOT NULL,
    "subject_id" UUID NOT NULL,
    "subject_label" TEXT NOT NULL DEFAULT '',
    "self_service" BOOLEAN NOT NULL DEFAULT false,
    "status" "DataRequestStatus" NOT NULL DEFAULT 'pending_review',
    "reason" TEXT NOT NULL DEFAULT '',
    "requested_by_id" UUID NOT NULL,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT NOT NULL DEFAULT '',
    "completed_at" TIMESTAMP(3),
    "file_key" TEXT,
    "file_size" INTEGER,
    "file_expires_at" TIMESTAMP(3),
    "summary" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "data_requests_organization_id_created_at_idx" ON "data_requests"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "data_requests_requested_by_id_idx" ON "data_requests"("requested_by_id");

-- AddForeignKey
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

