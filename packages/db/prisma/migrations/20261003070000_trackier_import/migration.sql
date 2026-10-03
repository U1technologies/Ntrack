-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('validated', 'importing', 'imported', 'failed', 'undone');

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'trackier',
    "entity" TEXT NOT NULL,
    "file_name" TEXT NOT NULL DEFAULT '',
    "status" "ImportStatus" NOT NULL DEFAULT 'validated',
    "headers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "options" JSONB NOT NULL DEFAULT '{}',
    "totals" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" UUID NOT NULL,
    "imported_at" TIMESTAMP(3),
    "undone_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "external_id" TEXT NOT NULL DEFAULT '',
    "raw" JSONB NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "errors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "match" TEXT NOT NULL,
    "matched_id" UUID,
    "matched_label" TEXT NOT NULL DEFAULT '',
    "decision" TEXT,
    "result" TEXT NOT NULL DEFAULT '',
    "created_entity_id" UUID,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_refs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "batch_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_refs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_batches_organization_id_created_at_idx" ON "import_batches"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "import_rows_batch_id_row_number_idx" ON "import_rows"("batch_id", "row_number");

-- CreateIndex
CREATE INDEX "external_refs_organization_id_entity_type_entity_id_idx" ON "external_refs"("organization_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_refs_organization_id_source_entity_type_external_i_key" ON "external_refs"("organization_id", "source", "entity_type", "external_id");

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_refs" ADD CONSTRAINT "external_refs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

