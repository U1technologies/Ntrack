-- Organization-scoped visitor key (HMAC of IP + user agent) so multi-touch attribution can find a
-- visitor's earlier clicks. Not reversible to an IP address.
ALTER TABLE clicks ADD COLUMN IF NOT EXISTS visitor_id String DEFAULT '' AFTER ip;

-- Conversions mirrored from PostgreSQL for reporting. PostgreSQL stays the source of truth; every
-- status change re-inserts the row with a higher version and ReplacingMergeTree keeps the latest.
-- Queries read with FINAL.
CREATE TABLE IF NOT EXISTS conversions
(
    conversion_id   String,
    organization_id UUID,
    campaign_id     UUID,
    publisher_id    UUID,
    advertiser_id   UUID,
    click_id        String,
    link_id         String,
    domain_id       String,
    event           LowCardinality(String),
    status          LowCardinality(String),
    source          LowCardinality(String),
    currency        LowCardinality(String),
    sale_amount     Decimal(18, 6),
    revenue         Decimal(18, 6),
    payout          Decimal(18, 6),
    sub1            String,
    sub2            String,
    sub3            String,
    sub4            String,
    sub5            String,
    traffic_source  LowCardinality(String),
    country         LowCardinality(String),
    device_type     LowCardinality(String),
    clicked_at      DateTime64(3, 'UTC'),
    converted_at    DateTime64(3, 'UTC'),
    version         UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(converted_at)
ORDER BY (organization_id, toDate(converted_at), campaign_id, conversion_id);
