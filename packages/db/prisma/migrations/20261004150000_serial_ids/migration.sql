-- Serial numbers per organization for advertisers, publishers and campaigns (1, 2, 3...).
-- Existing records are numbered in creation order; new ones take the next value from
-- organization_counters. Additive: nothing is removed or renamed.

ALTER TABLE "advertisers" ADD COLUMN "number" INTEGER;
ALTER TABLE "publishers" ADD COLUMN "number" INTEGER;
ALTER TABLE "campaigns" ADD COLUMN "number" INTEGER;

UPDATE "advertisers" AS t SET "number" = r.n
FROM (SELECT "id", ROW_NUMBER() OVER (PARTITION BY "organization_id" ORDER BY "created_at", "id") AS n FROM "advertisers") AS r
WHERE t."id" = r."id";

UPDATE "publishers" AS t SET "number" = r.n
FROM (SELECT "id", ROW_NUMBER() OVER (PARTITION BY "organization_id" ORDER BY "created_at", "id") AS n FROM "publishers") AS r
WHERE t."id" = r."id";

UPDATE "campaigns" AS t SET "number" = r.n
FROM (SELECT "id", ROW_NUMBER() OVER (PARTITION BY "organization_id" ORDER BY "created_at", "id") AS n FROM "campaigns") AS r
WHERE t."id" = r."id";

ALTER TABLE "advertisers" ALTER COLUMN "number" SET NOT NULL;
ALTER TABLE "publishers" ALTER COLUMN "number" SET NOT NULL;
ALTER TABLE "campaigns" ALTER COLUMN "number" SET NOT NULL;

CREATE UNIQUE INDEX "advertisers_organization_id_number_key" ON "advertisers"("organization_id", "number");
CREATE UNIQUE INDEX "publishers_organization_id_number_key" ON "publishers"("organization_id", "number");
CREATE UNIQUE INDEX "campaigns_organization_id_number_key" ON "campaigns"("organization_id", "number");

CREATE TABLE "organization_counters" (
    "organization_id" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "organization_counters_pkey" PRIMARY KEY ("organization_id", "entity")
);

INSERT INTO "organization_counters" ("organization_id", "entity", "value")
SELECT "organization_id", 'advertiser', MAX("number") FROM "advertisers" GROUP BY "organization_id"
UNION ALL
SELECT "organization_id", 'publisher', MAX("number") FROM "publishers" GROUP BY "organization_id"
UNION ALL
SELECT "organization_id", 'campaign', MAX("number") FROM "campaigns" GROUP BY "organization_id";
