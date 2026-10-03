-- API key request log (usage and debugging). Kept 90 days.
CREATE TABLE IF NOT EXISTS api_requests
(
    ts              DateTime64(3, 'UTC'),
    organization_id UUID,
    api_key_id      UUID,
    method          LowCardinality(String),
    path            String,
    status          UInt16,
    latency_ms      UInt32,
    ip              String,
    user_agent      String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (organization_id, api_key_id, ts)
TTL toDateTime(ts) + INTERVAL 90 DAY;
