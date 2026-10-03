-- Click log searches by click ID (support/debugging) without scanning the partition.
ALTER TABLE clicks ADD INDEX IF NOT EXISTS idx_click_id click_id TYPE bloom_filter(0.01) GRANULARITY 4;
