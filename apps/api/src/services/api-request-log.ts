import type { ClickHouseClient } from '@ntrack/analytics';
import { toClickHouseDateTime } from '@ntrack/analytics';
import { truncateIp } from '@ntrack/shared';
import type { Logger } from '../lib/logger';

export interface ApiRequestRow {
  ts: string;
  organization_id: string;
  api_key_id: string;
  method: string;
  path: string;
  status: number;
  latency_ms: number;
  ip: string;
  user_agent: string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Path without query string, with IDs replaced so logs group by endpoint. */
export const normalisePath = (url: string): string => (url.split('?')[0] ?? '').replace(UUID, ':id').slice(0, 200);

/**
 * Buffers API key request rows and writes them to ClickHouse in batches. Logging never blocks or
 * fails a request; a failed write is logged and dropped.
 */
export class ApiRequestLog {
  private buffer: ApiRequestRow[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly clickhouse: ClickHouseClient,
    private readonly logger: Logger,
    private readonly maxBatch = 500,
    private readonly flushMs = 2000
  ) {}

  record(input: { organizationId: string; apiKeyId: string; method: string; url: string; status: number; latencyMs: number; ip: string; userAgent: string }) {
    this.buffer.push({
      ts: toClickHouseDateTime(Date.now()),
      organization_id: input.organizationId,
      api_key_id: input.apiKeyId,
      method: input.method,
      path: normalisePath(input.url),
      status: input.status,
      latency_ms: Math.max(0, Math.round(input.latencyMs)),
      ip: truncateIp(input.ip),
      user_agent: input.userAgent.slice(0, 300),
    });
    if (this.buffer.length >= this.maxBatch) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), this.flushMs);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const rows = this.buffer;
    this.buffer = [];
    if (rows.length === 0) return;
    try {
      await this.clickhouse.insert({ table: 'api_requests', values: rows, format: 'JSONEachRow' });
    } catch (error) {
      this.logger.error({ err: error, rows: rows.length }, 'failed to write API request log');
    }
  }
}
