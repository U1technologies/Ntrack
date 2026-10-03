-- What the tracker actually sent for each click (redirect types and debugging).
ALTER TABLE clicks ADD COLUMN IF NOT EXISTS response_type LowCardinality(String) DEFAULT '' AFTER redirect_mode;
ALTER TABLE clicks ADD COLUMN IF NOT EXISTS http_status UInt16 DEFAULT 0 AFTER response_type;
ALTER TABLE clicks ADD COLUMN IF NOT EXISTS referrer_policy LowCardinality(String) DEFAULT '' AFTER http_status;
ALTER TABLE clicks ADD COLUMN IF NOT EXISTS used_fallback UInt8 DEFAULT 0 AFTER referrer_policy;
