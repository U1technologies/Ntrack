import { z } from 'zod';
import type { ImportBatch, Prisma } from '@ntrack/db';
import { IMPORT_ENTITIES, IMPORT_FIELDS, autoMapColumns, parseCsv, type ImportEntity } from '@ntrack/shared';
import { AppError } from '../../lib/errors';
import { paginated } from '../../lib/response';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';
import { HANDLERS, SOURCE, type ImportContext } from './import-handlers';

const MAX_ROWS = 20_000;

export const CreateImportBody = z.object({
  entity: z.enum(IMPORT_ENTITIES),
  fileName: z.string().trim().max(200).default(''),
  csv: z.string().min(1).max(1_000_000),
  /** {fieldKey: csvHeader}; omitted fields are auto-mapped from Trackier's usual column names. */
  mapping: z.record(z.string(), z.string()).optional(),
  activateCampaigns: z.boolean().default(false),
});

export const ImportRowsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  match: z.enum(['new', 'already_imported', 'possible_duplicate', 'existing', 'invalid', 'undecided']).optional(),
});

export const RowDecisionBody = z.object({ decision: z.enum(['create', 'link', 'skip']) });

type Totals = Record<string, number>;

const summarise = (rows: Array<{ match: string; decision: string | null; result?: string }>): Totals => {
  const totals: Totals = { rows: rows.length, undecided: 0 };
  for (const row of rows) {
    totals[row.match] = (totals[row.match] ?? 0) + 1;
    if (row.decision === null) totals.undecided! += 1;
    if (row.decision) totals[`decision_${row.decision}`] = (totals[`decision_${row.decision}`] ?? 0) + 1;
    if (row.result) {
      const key = row.result.startsWith('failed') ? 'failed' : row.result;
      totals[`result_${key}`] = (totals[`result_${key}`] ?? 0) + 1;
    }
  }
  return totals;
};

/**
 * Migration imports from Trackier. Upload → every row validated and matched (dry run) → user
 * resolves possible duplicates → commit through the normal services (same validation, audit
 * trail and tracker updates) → optional undo of records the batch created. Existing NTrack
 * records are linked, never modified.
 */
export class ImportsService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }

  private assertOrgWide(auth: OrgAuthContext) {
    if (auth.scope.restricted) throw AppError.forbidden('Imports need an organization-wide role');
  }

  private context(auth: OrgAuthContext, meta: RequestMeta, options: { activateCampaigns: boolean }): ImportContext {
    const cache = new Map<string, string | null>();
    return {
      deps: this.deps,
      auth,
      meta,
      options,
      resolve: async (entityType, externalId) => {
        if (!externalId) return null;
        const key = `${entityType}:${externalId}`;
        if (!cache.has(key)) {
          const ref = await this.prisma.externalRef.findUnique({
            where: { organizationId_source_entityType_externalId: { organizationId: auth.organizationId, source: SOURCE, entityType, externalId } },
            select: { entityId: true },
          });
          cache.set(key, ref?.entityId ?? null);
        }
        return cache.get(key) ?? null;
      },
    };
  }

  templates() {
    return IMPORT_ENTITIES.map((entity) => ({ entity, fields: IMPORT_FIELDS[entity] }));
  }

  async create(auth: OrgAuthContext, input: z.infer<typeof CreateImportBody>, meta: RequestMeta) {
    this.assertOrgWide(auth);
    let parsed;
    try {
      parsed = parseCsv(input.csv);
    } catch (error) {
      throw AppError.badRequest((error as Error).message);
    }
    if (parsed.records.length === 0) throw AppError.badRequest('The file has no data rows');
    if (parsed.records.length > MAX_ROWS) throw AppError.badRequest(`Split the file: at most ${MAX_ROWS} rows per import`);
    const entity = input.entity as ImportEntity;
    const mapping = { ...autoMapColumns(entity, parsed.headers), ...(input.mapping ?? {}) };
    const missing = IMPORT_FIELDS[entity].filter((f) => f.required && (!mapping[f.key] || !parsed.headers.map((h) => h.toLowerCase()).includes(mapping[f.key]!.toLowerCase())));
    if (missing.length) {
      throw AppError.badRequest(`Map these required columns: ${missing.map((f) => f.label).join(', ')}`, { headers: parsed.headers, mapping, missing: missing.map((f) => f.key) });
    }

    const handler = HANDLERS[entity];
    const ctx = this.context(auth, meta, { activateCampaigns: input.activateCampaigns });
    const headerFor = (key: string) => parsed.headers.find((h) => h.toLowerCase() === mapping[key]?.toLowerCase());
    const seen = new Map<string, number>();
    const rows: Prisma.ImportRowCreateManyBatchInput[] = [];
    for (const record of parsed.records) {
      const values = Object.fromEntries(IMPORT_FIELDS[entity].map((f) => [f.key, record.values[headerFor(f.key) ?? ''] ?? '']));
      const built = await handler.build(values, ctx);
      if (built.externalId && seen.has(built.externalId)) built.errors.push(`Same record as row ${seen.get(built.externalId)}`);
      if (built.externalId) seen.set(built.externalId, record.line);
      const matched = built.errors.length || !built.input ? { match: 'invalid' as const, decision: 'skip' as const } : await handler.match(built, ctx);
      rows.push({
        rowNumber: record.line,
        externalId: built.externalId.slice(0, 200),
        raw: record.values as Prisma.InputJsonValue,
        input: (built.input ?? {}) as Prisma.InputJsonValue,
        errors: built.errors.slice(0, 20),
        warnings: built.warnings.slice(0, 20),
        match: matched.match,
        matchedId: 'matchedId' in matched ? (matched.matchedId ?? null) : null,
        matchedLabel: 'matchedLabel' in matched ? (matched.matchedLabel ?? '') : '',
        decision: matched.decision,
      });
    }
    const batch = await this.prisma.importBatch.create({
      data: {
        organizationId: auth.organizationId,
        source: SOURCE,
        entity,
        fileName: input.fileName,
        headers: parsed.headers,
        mapping,
        options: { activateCampaigns: input.activateCampaigns },
        totals: summarise(rows.map((r) => ({ match: r.match, decision: r.decision ?? null }))),
        createdById: auth.user.id,
        rows: { createMany: { data: rows } },
      },
    });
    await writeAudit(this.prisma, auth, meta, { action: 'import.validated', entityType: 'import_batch', entityId: batch.id, summary: `${entity}: ${rows.length} rows from ${input.fileName || 'upload'}` });
    return batch;
  }

  async list(auth: OrgAuthContext) {
    this.assertOrgWide(auth);
    return this.prisma.importBatch.findMany({ where: { organizationId: auth.organizationId }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  private async find(auth: OrgAuthContext, id: string) {
    this.assertOrgWide(auth);
    const batch = await this.prisma.importBatch.findFirst({ where: { id, organizationId: auth.organizationId } });
    if (!batch) throw AppError.notFound('Import');
    return batch;
  }

  async get(auth: OrgAuthContext, id: string, query: z.infer<typeof ImportRowsQuery>) {
    const batch = await this.find(auth, id);
    const where: Prisma.ImportRowWhereInput = {
      batchId: id,
      ...(query.match === 'undecided' ? { decision: null } : query.match ? { match: query.match } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.importRow.findMany({ where, orderBy: { rowNumber: 'asc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.importRow.count({ where }),
    ]);
    return { batch, fields: IMPORT_FIELDS[batch.entity as ImportEntity], rows: paginated(items, total, query.page, query.pageSize) };
  }

  private async refreshTotals(batchId: string) {
    const rows = await this.prisma.importRow.findMany({ where: { batchId }, select: { match: true, decision: true, result: true } });
    await this.prisma.importBatch.update({ where: { id: batchId }, data: { totals: summarise(rows) } });
  }

  async decide(auth: OrgAuthContext, id: string, rowId: string, decision: 'create' | 'link' | 'skip') {
    const batch = await this.find(auth, id);
    if (batch.status !== 'validated') throw AppError.conflict('Decisions can only change before the import is committed');
    const row = await this.prisma.importRow.findFirst({ where: { id: rowId, batchId: id } });
    if (!row) throw AppError.notFound('Row');
    if (row.match === 'invalid' && decision !== 'skip') throw AppError.badRequest('Fix the file and upload it again to import invalid rows');
    if (decision === 'link' && (!row.matchedId || HANDLERS[batch.entity as ImportEntity].refType === null)) throw AppError.badRequest('There is no existing record to link this row to');
    if (row.match === 'existing' && decision === 'create') throw AppError.badRequest('A matching record already exists; NTrack never overwrites existing data');
    const updated = await this.prisma.importRow.update({ where: { id: rowId }, data: { decision } });
    await this.refreshTotals(id);
    return updated;
  }

  /** Commits in the background; the batch shows progress until it is "imported". */
  async commit(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const batch = await this.find(auth, id);
    if (batch.status !== 'validated') throw AppError.conflict('This import has already been committed');
    const undecided = await this.prisma.importRow.count({ where: { batchId: id, decision: null } });
    if (undecided) throw AppError.badRequest(`Decide what to do with ${undecided} possible duplicate(s) first`);
    const claimed = await this.prisma.importBatch.updateMany({ where: { id, status: 'validated' }, data: { status: 'importing' } });
    if (claimed.count !== 1) throw AppError.conflict('This import is already running');
    void this.run(auth, batch, meta);
    return { id, status: 'importing' };
  }

  private async run(auth: OrgAuthContext, batch: ImportBatch, meta: RequestMeta) {
    const entity = batch.entity as ImportEntity;
    const handler = HANDLERS[entity];
    const ctx = this.context(auth, meta, (batch.options as { activateCampaigns?: boolean }) as { activateCampaigns: boolean });
    try {
      const rows = await this.prisma.importRow.findMany({ where: { batchId: batch.id, decision: { in: ['create', 'link'] } }, orderBy: { rowNumber: 'asc' } });
      for (const [index, row] of rows.entries()) {
        let result: string;
        let createdEntityId: string | null = null;
        try {
          if (row.decision === 'link') {
            result = 'linked';
          } else {
            createdEntityId = await handler.create(row.input as Record<string, unknown>, ctx);
            result = 'created';
          }
          const entityId = createdEntityId ?? row.matchedId;
          if (handler.refType && row.externalId && entityId) {
            await this.prisma.externalRef.upsert({
              where: { organizationId_source_entityType_externalId: { organizationId: auth.organizationId, source: SOURCE, entityType: handler.refType, externalId: row.externalId } },
              create: { organizationId: auth.organizationId, source: SOURCE, entityType: handler.refType, externalId: row.externalId, entityId, batchId: batch.id },
              update: {},
            });
          }
        } catch (error) {
          result = `failed: ${(error as Error).message}`.slice(0, 300);
        }
        await this.prisma.importRow.update({ where: { id: row.id }, data: { result, createdEntityId } });
        if (index % 25 === 24) await this.refreshTotals(batch.id);
      }
      await this.prisma.importBatch.update({ where: { id: batch.id }, data: { status: 'imported', importedAt: new Date() } });
      await this.refreshTotals(batch.id);
      await writeAudit(this.prisma, auth, meta, { action: 'import.committed', entityType: 'import_batch', entityId: batch.id, summary: `${entity}: ${rows.length} rows processed` });
    } catch (error) {
      this.deps.logger.error({ err: error, batchId: batch.id }, 'import failed');
      await this.prisma.importBatch.update({ where: { id: batch.id }, data: { status: 'failed' } });
    }
  }

  /**
   * Undo: records this batch created are deleted if nothing uses them yet, otherwise archived or
   * suspended. Links to existing records are removed; existing records themselves are untouched.
   */
  async undo(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const batch = await this.find(auth, id);
    if (batch.status !== 'imported') throw AppError.conflict('Only committed imports can be undone');
    const handler = HANDLERS[batch.entity as ImportEntity];
    const ctx = this.context(auth, meta, { activateCampaigns: false });
    const created = await this.prisma.importRow.findMany({ where: { batchId: id, createdEntityId: { not: null } }, orderBy: { rowNumber: 'desc' } });
    const outcome: Totals = { deleted: 0, archived: 0, suspended: 0, failed: 0 };
    for (const row of created) {
      try {
        const result = await handler.undo(row.createdEntityId!, ctx);
        outcome[result] = (outcome[result] ?? 0) + 1;
        await this.prisma.importRow.update({ where: { id: row.id }, data: { result: `undone (${result})` } });
      } catch (error) {
        outcome.failed! += 1;
        await this.prisma.importRow.update({ where: { id: row.id }, data: { result: `undo failed: ${(error as Error).message}`.slice(0, 300) } });
      }
    }
    await this.prisma.externalRef.deleteMany({ where: { organizationId: auth.organizationId, batchId: id } });
    await this.prisma.importBatch.update({ where: { id }, data: { status: 'undone', undoneAt: new Date() } });
    await writeAudit(this.prisma, auth, meta, { action: 'import.undone', entityType: 'import_batch', entityId: id, summary: JSON.stringify(outcome) });
    return outcome;
  }
}
