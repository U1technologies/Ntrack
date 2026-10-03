import { hostname } from 'node:os';
import type { Redis } from 'ioredis';
import type { ConversionProcessor } from '@ntrack/conversions';
import { REDIS_KEYS, type ConversionIntake } from '@ntrack/shared';
import type { Logger } from '../logger';

const GROUP = 'conversion-processor';
const REJECTED = `${REDIS_KEYS.conversionStream}:rejected`;
const DEAD_LETTER = `${REDIS_KEYS.conversionStream}:dead`;
const ATTEMPTS_KEY = `${REDIS_KEYS.conversionStream}:attempts`;
const MAX_ATTEMPTS = 5;
const CLAIM_IDLE_MS = 60_000;

type StreamEntry = [id: string, fields: string[]];

/**
 * Processes conversions queued by the tracker (postbacks, pixels). Each entry is acknowledged only
 * after the processor finishes; failures are retried (reclaimed after a minute) up to 5 times, then
 * moved to a dead-letter stream. Business rejections (expired click, outside window) are recorded
 * in a capped "rejected" stream for inspection.
 */
export class ConversionConsumer {
  private running = false;
  private readonly consumer = `${hostname()}-${process.pid}`;

  constructor(
    private readonly redis: Redis,
    private readonly processor: ConversionProcessor,
    private readonly log: Logger
  ) {}

  async start(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', REDIS_KEYS.conversionStream, GROUP, '0', 'MKSTREAM');
    } catch (error) {
      if (!(error as Error).message.includes('BUSYGROUP')) throw error;
    }
    this.running = true;
    this.log.info({ consumer: this.consumer }, 'conversion consumer started');
    while (this.running) {
      try {
        const reclaimed = (await this.redis.xautoclaim(REDIS_KEYS.conversionStream, GROUP, this.consumer, CLAIM_IDLE_MS, '0-0', 'COUNT', 50)) as [string, StreamEntry[]];
        const stale = (reclaimed?.[1] ?? []).filter((entry) => Array.isArray(entry?.[1]));
        const entries = stale.length
          ? stale
          : (((await this.redis.xreadgroup('GROUP', GROUP, this.consumer, 'COUNT', 50, 'BLOCK', 2000, 'STREAMS', REDIS_KEYS.conversionStream, '>')) as Array<[string, StreamEntry[]]> | null)?.[0]?.[1] ?? []);
        for (const entry of entries) await this.handle(entry);
      } catch (error) {
        this.log.error({ err: error }, 'conversion consumer loop failed; retrying');
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private async ack(id: string) {
    await this.redis.multi().xack(REDIS_KEYS.conversionStream, GROUP, id).xdel(REDIS_KEYS.conversionStream, id).hdel(ATTEMPTS_KEY, id).exec();
  }

  private async handle([id, fields]: StreamEntry) {
    const raw = fields[fields.indexOf('c') + 1] ?? '';
    let intake: ConversionIntake;
    try {
      intake = JSON.parse(raw) as ConversionIntake;
    } catch {
      await this.redis.xadd(DEAD_LETTER, '*', 'source_id', id, 'reason', 'unparseable', 'c', raw.slice(0, 4000));
      await this.ack(id);
      return;
    }
    try {
      const result = await this.processor.ingest(intake);
      if (result.outcome === 'rejected') {
        await this.redis.xadd(REJECTED, 'MAXLEN', '~', '10000', '*', 'reason', result.reason, 'c', raw);
        this.log.warn({ clickId: intake.clickId, reason: result.reason }, 'conversion rejected');
      }
      await this.ack(id);
    } catch (error) {
      const attempts = await this.redis.hincrby(ATTEMPTS_KEY, id, 1);
      this.log.error({ err: error, clickId: intake.clickId, attempts }, 'conversion processing failed');
      if (attempts >= MAX_ATTEMPTS) {
        await this.redis.xadd(DEAD_LETTER, '*', 'source_id', id, 'reason', (error as Error).message.slice(0, 200), 'c', raw);
        await this.ack(id);
      }
    }
  }
}
