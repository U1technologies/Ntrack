import { hostname } from 'node:os';
import type { Redis } from 'ioredis';
import UAParser from 'ua-parser-js';
import { insertClickBatch, toClickRow, type ClickHouseClient, type ClickRow } from '@ntrack/analytics';
import { REDIS_KEYS, type ClickEvent } from '@ntrack/shared';
import type { Logger } from '../logger';

const GROUP = 'clickhouse-ingest';
const DEAD_LETTER = `${REDIS_KEYS.clickStream}:dead`;
const CLAIM_IDLE_MS = 60_000;

type StreamEntry = [id: string, fields: string[]];

export interface CapHit {
  organizationId: string;
  campaignId: string;
  advertiserId: string;
  /** UTC day of the first capped click in the batch; used for alert dedupe. */
  day: string;
}

/** Distinct campaigns whose daily click cap blocked at least one click in the batch. */
export const capHitsFromRows = (rows: ClickRow[]): CapHit[] => {
  const hits = new Map<string, CapHit>();
  for (const row of rows) {
    if (row.invalid_reason !== 'click_cap_reached' || hits.has(row.campaign_id)) continue;
    hits.set(row.campaign_id, { organizationId: row.organization_id, campaignId: row.campaign_id, advertiserId: row.advertiser_id, day: row.ts.slice(0, 10) });
  }
  return [...hits.values()];
};

export const parseUserAgent = (userAgent: string): { os: string; browser: string } => {
  if (!userAgent) return { os: '', browser: '' };
  const result = new UAParser(userAgent).getResult();
  return { os: result.os.name ?? '', browser: result.browser.name ?? '' };
};

/** Converts stream entries to rows; entries that cannot be parsed are returned separately. */
export const entriesToRows = (entries: StreamEntry[]): { rows: ClickRow[]; invalid: StreamEntry[] } => {
  const rows: ClickRow[] = [];
  const invalid: StreamEntry[] = [];
  for (const entry of entries) {
    const [, fields] = entry;
    const payload = fields[fields.indexOf('e') + 1];
    try {
      const event = JSON.parse(payload ?? '') as ClickEvent;
      if (!event.clickId || !event.organizationId) throw new Error('missing ids');
      rows.push(toClickRow(event, parseUserAgent(event.userAgent)));
    } catch {
      invalid.push(entry);
    }
  }
  return { rows, invalid };
};

/**
 * Consumes the tracker's click stream in batches and writes them to ClickHouse. A batch is only
 * acknowledged after a successful insert; the dedup token (first-last entry IDs) makes a retried
 * batch idempotent. Entries left pending by a crashed consumer are reclaimed after a minute.
 */
export class ClickIngestor {
  private running = false;
  private readonly consumer = `${hostname()}-${process.pid}`;

  constructor(
    private readonly redis: Redis,
    private readonly clickhouse: ClickHouseClient,
    private readonly log: Logger,
    private readonly batchSize: number,
    private readonly onCapHits?: (hits: CapHit[]) => void
  ) {}

  async start(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', REDIS_KEYS.clickStream, GROUP, '0', 'MKSTREAM');
    } catch (error) {
      if (!(error as Error).message.includes('BUSYGROUP')) throw error;
    }
    this.running = true;
    this.log.info({ consumer: this.consumer }, 'click ingestor started');
    while (this.running) {
      try {
        const reclaimed = await this.reclaimStale();
        const entries = reclaimed.length > 0 ? reclaimed : await this.readNew();
        if (entries.length > 0) await this.processBatch(entries);
      } catch (error) {
        this.log.error({ err: error }, 'click ingest batch failed; retrying');
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private async readNew(): Promise<StreamEntry[]> {
    const response = (await this.redis.xreadgroup(
      'GROUP',
      GROUP,
      this.consumer,
      'COUNT',
      this.batchSize,
      'BLOCK',
      2000,
      'STREAMS',
      REDIS_KEYS.clickStream,
      '>'
    )) as Array<[string, StreamEntry[]]> | null;
    return response?.[0]?.[1] ?? [];
  }

  private async reclaimStale(): Promise<StreamEntry[]> {
    const result = (await this.redis.xautoclaim(REDIS_KEYS.clickStream, GROUP, this.consumer, CLAIM_IDLE_MS, '0-0', 'COUNT', this.batchSize)) as [
      string,
      StreamEntry[],
    ];
    return (result?.[1] ?? []).filter((entry) => Array.isArray(entry?.[1]));
  }

  private async processBatch(entries: StreamEntry[]): Promise<void> {
    const { rows, invalid } = entriesToRows(entries);
    const dedupToken = `${entries[0]![0]}-${entries[entries.length - 1]![0]}`;
    await insertClickBatch(this.clickhouse, rows, dedupToken);
    if (this.onCapHits) {
      const hits = capHitsFromRows(rows);
      if (hits.length > 0) this.onCapHits(hits);
    }

    if (invalid.length > 0) {
      const pipeline = this.redis.pipeline();
      invalid.forEach(([id, fields]) => pipeline.xadd(DEAD_LETTER, '*', 'source_id', id, ...fields));
      await pipeline.exec();
      this.log.warn({ count: invalid.length }, 'moved unparseable click events to dead letter stream');
    }

    const ids = entries.map(([id]) => id);
    await this.redis.multi().xack(REDIS_KEYS.clickStream, GROUP, ...ids).xdel(REDIS_KEYS.clickStream, ...ids).exec();
    this.log.debug({ inserted: rows.length }, 'click batch ingested');
  }
}
