# ClickHouse for NTrack on Render (private service with a persistent disk).
# The stock image's first-start init (CLICKHOUSE_DB / initdb scripts) starts and kills a temporary
# server, which Render's sandbox does not allow, so it is not used: the API's deploy step creates the
# database and tables (packages/analytics migrations). The default user's password comes from the
# CLICKHOUSE_PASSWORD environment variable (handled by the stock entrypoint without a temp server).
FROM clickhouse/clickhouse-server:25.8
COPY config.d/ /etc/clickhouse-server/config.d/
