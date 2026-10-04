-- Mobile app identifiers passed in on the click (?gaid=, ?idfa=, ?app_name=); empty for web traffic.
ALTER TABLE clicks ADD COLUMN IF NOT EXISTS gaid String DEFAULT '' AFTER source;
ALTER TABLE clicks ADD COLUMN IF NOT EXISTS idfa String DEFAULT '' AFTER gaid;
ALTER TABLE clicks ADD COLUMN IF NOT EXISTS app_name String DEFAULT '' AFTER idfa;
