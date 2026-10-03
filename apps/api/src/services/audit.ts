import type { Prisma, PrismaClient } from '@ntrack/db';
import { serialize } from '../lib/serialize';
import type { AuthContext, RequestMeta } from '../types';

type Db = PrismaClient | Prisma.TransactionClient;

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
  organizationId?: string | null;
}

const SENSITIVE_KEYS = /password|secret|token|encrypted|taxinfo|paymentdetails/i;

/** Strips credentials and encrypted blobs so audit logs never become a secondary secret store. */
const redact = (value: unknown): Prisma.InputJsonValue | undefined => {
  if (value === undefined || value === null) return undefined;
  const plain = serialize(value) as unknown;
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, v]) => [key, SENSITIVE_KEYS.test(key) ? '[redacted]' : walk(v)]));
    }
    return item;
  };
  return walk(plain) as Prisma.InputJsonValue;
};

/** Writes an audit log row. Pass the transaction client so the log commits with the change. */
export const writeAudit = (db: Db, auth: AuthContext | null, meta: RequestMeta, entry: AuditEntry) =>
  db.auditLog.create({
    data: {
      organizationId: entry.organizationId !== undefined ? entry.organizationId : (auth?.organizationId ?? null),
      actorUserId: auth?.user.id ?? null,
      actorEmail: auth?.user.email ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      summary: entry.summary ?? '',
      before: redact(entry.before),
      after: redact(entry.after),
      ip: meta.ip,
      userAgent: meta.userAgent,
    },
  });
