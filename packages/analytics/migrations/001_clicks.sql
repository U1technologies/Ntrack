-- Raw click events. One row per tracker click (valid and invalid). Partitioned monthly,
-- ordered for the dominant query shape: one organization, a date range, grouped by campaign.
-- Ingestion is idempotent: workers pass an insert_deduplication_token per stream batch, and
-- non_replicated_deduplication_window makes ClickHouse drop a replayed batch.
CREATE TABLE IF NOT EXISTS clicks
(
    click_id          String,
    ts                DateTime64(3, 'UTC'),
    organization_id   UUID,
    campaign_id       UUID,
    publisher_id      UUID,
    advertiser_id     UUID,
    link_id           UUID,
    domain_id         UUID,
    landing_page_id   String,
    sub1              String,
    sub2              String,
    sub3              String,
    sub4              String,
    sub5              String,
    source            LowCardinality(String),
    external_click_id String,
    utm_source        String,
    utm_medium        String,
    utm_campaign      String,
    utm_term          String,
    utm_content       String,
    country           LowCardinality(String),
    region            String,
    city              String,
    device_type       LowCardinality(String),
    os                LowCardinality(String),
    browser           LowCardinality(String),
    user_agent        String,
    ip                String,
    referrer          String,
    referrer_domain   String,
    destination_url   String,
    is_unique         UInt8,
    is_valid          UInt8,
    invalid_reason    LowCardinality(String),
    redirect_mode     LowCardinality(String),
    latency_ms        UInt32,
    inserted_at       DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (organization_id, toDate(ts), campaign_id, publisher_id, ts)
TTL toDateTime(ts) + INTERVAL 400 DAY
SETTINGS non_replicated_deduplication_window = 10000, index_granularity = 8192;
