import { z } from 'zod';
import { Prisma } from '@ntrack/db';
import { CURRENCIES, generatePublicId, isClickId, parseCsv, parseReportDate, parseReportNumber } from '@ntrack/shared';
import { AppError } from '../../lib/errors';
import { paginated } from '../../lib/response';
import { serialize } from '../../lib/serialize';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';
import { findAdapter, TRAVEL_ADAPTERS, type BookingColumnMapping } from './travel.adapters';

export const PRODUCT_TYPES = ['hotel', 'flight', 'car_rental', 'package', 'insurance', 'activity'] as const;

export const TravelPartnerBody = z.object({
  name: z.string().trim().min(2).max(120),
  productTypes: z.array(z.enum(PRODUCT_TYPES)).min(1),
  adapter: z.enum(TRAVEL_ADAPTERS.map((a) => a.key) as [string, ...string[]]).default('generic'),
  commissionPercent: z.coerce.number().min(0).max(100).nullish(),
  currency: z.enum(CURRENCIES).default('USD'),
  campaignId: z.string().uuid().nullish(),
  active: z.boolean().default(true),
  notes: z.string().trim().max(2000).default(''),
});

const column = z.string().trim().toLowerCase().min(1).optional();

export const BookingImportBody = z.object({
  csv: z.string().min(1).max(1_000_000),
  dateFormat: z.enum(['ymd', 'mdy', 'dmy']).default('ymd'),
  productType: z.enum(PRODUCT_TYPES).default('hotel'),
  mapping: z
    .object({
      bookingRef: z.string().trim().toLowerCase().min(1),
      bookingValue: z.string().trim().toLowerCase().min(1),
      commission: column,
      currency: column,
      status: column,
      productType: column,
      destination: column,
      startDate: column,
      endDate: column,
      travelers: column,
      clickId: column,
    })
    .optional(),
});

export const ListBookingsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  partnerId: z.string().uuid().optional(),
  reconciliation: z.enum(['unmatched', 'matched', 'mismatch']).optional(),
  search: z.string().trim().max(120).optional(),
});

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const day = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00.000Z`) : null);
/** Booking value and the conversion sale amount may differ by rounding; beyond 1% it is a mismatch. */
const AMOUNT_TOLERANCE = 0.01;

/**
 * Travel: partners, booking imports via adapters, commission calculation and reconciliation of
 * partner bookings against NTrack conversions (matched on transaction ID = booking reference).
 */
export class TravelService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }

  adapters() {
    return TRAVEL_ADAPTERS;
  }

  listPartners(auth: OrgAuthContext) {
    return this.prisma.travelPartner.findMany({ where: { organizationId: auth.organizationId }, include: { _count: { select: { bookings: true } } }, orderBy: { name: 'asc' } }).then(serialize);
  }

  private async partner(auth: OrgAuthContext, id: string) {
    const partner = await this.prisma.travelPartner.findFirst({ where: { id, organizationId: auth.organizationId } });
    if (!partner) throw AppError.notFound('Travel partner');
    return partner;
  }

  private async assertCampaign(auth: OrgAuthContext, campaignId?: string | null) {
    if (campaignId && !(await this.prisma.campaign.findFirst({ where: { id: campaignId, organizationId: auth.organizationId } }))) throw AppError.badRequest('Unknown campaign');
  }

  async createPartner(auth: OrgAuthContext, input: z.infer<typeof TravelPartnerBody>, meta: RequestMeta) {
    await this.assertCampaign(auth, input.campaignId);
    const partner = await this.prisma.travelPartner.create({ data: { ...input, campaignId: input.campaignId ?? null, publicId: generatePublicId('tp'), organizationId: auth.organizationId } });
    await writeAudit(this.prisma, auth, meta, { action: 'travel_partner.created', entityType: 'travel_partner', entityId: partner.id, summary: partner.name });
    return serialize(partner);
  }

  async updatePartner(auth: OrgAuthContext, id: string, input: Partial<z.infer<typeof TravelPartnerBody>>, meta: RequestMeta) {
    const before = await this.partner(auth, id);
    await this.assertCampaign(auth, input.campaignId);
    const after = await this.prisma.travelPartner.update({ where: { id }, data: input });
    await writeAudit(this.prisma, auth, meta, { action: 'travel_partner.updated', entityType: 'travel_partner', entityId: id, before, after });
    return serialize(after);
  }

  /** Imports a booking report through the partner's adapter, then reconciles the imported bookings. */
  async importBookings(auth: OrgAuthContext, partnerId: string, input: z.infer<typeof BookingImportBody>, meta: RequestMeta) {
    const partner = await this.partner(auth, partnerId);
    const adapter = findAdapter(partner.adapter);
    const mapping: BookingColumnMapping = { ...adapter.defaultMapping, ...(input.mapping ?? {}) };
    let parsed;
    try {
      parsed = parseCsv(input.csv);
    } catch (error) {
      throw AppError.badRequest((error as Error).message);
    }
    const required = [mapping.bookingRef, mapping.bookingValue];
    const missing = required.filter((h) => !parsed.headers.includes(h));
    if (missing.length) throw AppError.badRequest(`Required columns not found: ${missing.join(', ')}`, { headers: parsed.headers });
    const has = (h?: string) => Boolean(h && parsed.headers.includes(h));

    const skipped: Array<{ line: number; reason: string }> = [];
    const refs: string[] = [];
    for (const { line, values } of parsed.records) {
      const bookingRef = (values[mapping.bookingRef] ?? '').slice(0, 120);
      const value = parseReportNumber(values[mapping.bookingValue]);
      if (!bookingRef) {
        skipped.push({ line, reason: 'Missing booking reference' });
        continue;
      }
      if (value === null) {
        skipped.push({ line, reason: `Unreadable booking value "${values[mapping.bookingValue]}"` });
        continue;
      }
      const reportedCommission = has(mapping.commission) ? parseReportNumber(values[mapping.commission!]) : null;
      const commission = reportedCommission ?? (partner.commissionPercent ? D(value).times(partner.commissionPercent).dividedBy(100).toFixed(2) : '0');
      const rawStatus = has(mapping.status) ? (values[mapping.status!] ?? '').trim().toLowerCase() : '';
      const status = rawStatus ? adapter.statusMap[rawStatus] : 'booked';
      if (!status) {
        skipped.push({ line, reason: `Unknown booking status "${values[mapping.status!]}"` });
        continue;
      }
      const productType = has(mapping.productType) ? (values[mapping.productType!] || input.productType).trim().toLowerCase() : input.productType;
      if (!(PRODUCT_TYPES as readonly string[]).includes(productType)) {
        skipped.push({ line, reason: `Unknown product type "${productType}" (expected ${PRODUCT_TYPES.join(', ')})` });
        continue;
      }
      const clickId = has(mapping.clickId) ? (values[mapping.clickId!] ?? '').toUpperCase() : '';
      const data = {
        productType,
        destination: has(mapping.destination) ? (values[mapping.destination!] ?? '').slice(0, 120) : '',
        startDate: has(mapping.startDate) ? day(parseReportDate(values[mapping.startDate!], input.dateFormat)) : null,
        endDate: has(mapping.endDate) ? day(parseReportDate(values[mapping.endDate!], input.dateFormat)) : null,
        travelers: has(mapping.travelers) ? Math.round(Number(parseReportNumber(values[mapping.travelers!]) ?? 0)) || null : null,
        bookingValue: value,
        commission,
        currency: has(mapping.currency) && /^[A-Za-z]{3}$/.test(values[mapping.currency!] ?? '') ? values[mapping.currency!]!.toUpperCase() : partner.currency,
        status,
        clickId: isClickId(clickId) ? clickId : null,
        source: 'import',
      };
      await this.prisma.travelBooking.upsert({
        where: { partnerId_bookingRef: { partnerId, bookingRef } },
        create: { ...data, organizationId: auth.organizationId, partnerId, bookingRef },
        update: data,
      });
      refs.push(bookingRef);
    }
    const reconciliation = await this.reconcile(auth, partnerId, refs);
    await writeAudit(this.prisma, auth, meta, {
      action: 'travel_bookings.imported',
      entityType: 'travel_partner',
      entityId: partnerId,
      summary: `${refs.length} bookings imported, ${skipped.length} skipped`,
    });
    return { imported: refs.length, skipped: skipped.slice(0, 200), skippedCount: skipped.length, reconciliation, adapter: { key: adapter.key, specConfirmed: adapter.specConfirmed } };
  }

  /** Matches bookings to conversions (transaction ID = booking reference) and records discrepancies. */
  async reconcile(auth: OrgAuthContext, partnerId: string, refs?: string[]) {
    const partner = await this.partner(auth, partnerId);
    const bookings = await this.prisma.travelBooking.findMany({ where: { partnerId, ...(refs ? { bookingRef: { in: refs } } : {}) } });
    const conversions = await this.prisma.conversion.findMany({
      where: { organizationId: auth.organizationId, transactionId: { in: bookings.map((b) => b.bookingRef) }, ...(partner.campaignId ? { campaignId: partner.campaignId } : {}) },
      select: { id: true, transactionId: true, saleAmount: true, status: true, currency: true },
    });
    const counts = { matched: 0, mismatch: 0, unmatched: 0 };
    for (const booking of bookings) {
      const conversion = conversions.find((c) => c.transactionId === booking.bookingRef);
      let state: 'matched' | 'mismatch' | 'unmatched' = 'unmatched';
      const reasons: string[] = [];
      if (conversion) {
        if (conversion.saleAmount && !conversion.saleAmount.isZero()) {
          const diff = booking.bookingValue.minus(conversion.saleAmount).abs().dividedBy(conversion.saleAmount);
          if (diff.greaterThan(AMOUNT_TOLERANCE)) reasons.push(`Value differs: partner ${booking.bookingValue.toString()} vs NTrack ${conversion.saleAmount.toString()}`);
        }
        if (conversion.currency !== booking.currency) reasons.push(`Currency differs: partner ${booking.currency} vs NTrack ${conversion.currency}`);
        if (booking.status === 'cancelled' && ['pending', 'approved'].includes(conversion.status)) reasons.push(`Partner cancelled the booking but the conversion is ${conversion.status}`);
        if (['confirmed', 'completed'].includes(booking.status) && ['rejected', 'reversed'].includes(conversion.status)) reasons.push(`Partner confirmed the booking but the conversion is ${conversion.status}`);
        state = reasons.length ? 'mismatch' : 'matched';
      }
      counts[state] += 1;
      await this.prisma.travelBooking.update({
        where: { id: booking.id },
        data: { conversionId: conversion?.id ?? null, reconciliation: state, discrepancy: reasons.length ? { reasons } : Prisma.DbNull },
      });
    }
    return counts;
  }

  async listBookings(auth: OrgAuthContext, query: z.infer<typeof ListBookingsQuery>) {
    const where: Prisma.TravelBookingWhereInput = {
      organizationId: auth.organizationId,
      ...(query.partnerId ? { partnerId: query.partnerId } : {}),
      ...(query.reconciliation ? { reconciliation: query.reconciliation } : {}),
      ...(query.search ? { OR: [{ bookingRef: { contains: query.search, mode: 'insensitive' } }, { destination: { contains: query.search, mode: 'insensitive' } }] } : {}),
    };
    const [items, total, summary] = await Promise.all([
      this.prisma.travelBooking.findMany({ where, include: { partner: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.travelBooking.count({ where }),
      this.prisma.travelBooking.groupBy({ by: ['reconciliation', 'currency'], where: { organizationId: auth.organizationId, ...(query.partnerId ? { partnerId: query.partnerId } : {}) }, _count: { _all: true }, _sum: { bookingValue: true, commission: true } }),
    ]);
    return { ...paginated(serialize(items), total, query.page, query.pageSize), summary: serialize(summary) };
  }

  /** Conversions on the partner's campaign that the partner's report does not contain (yet). */
  async missingFromPartner(auth: OrgAuthContext, partnerId: string) {
    const partner = await this.partner(auth, partnerId);
    if (!partner.campaignId) return { campaignLinked: false, items: [] };
    const refs = (await this.prisma.travelBooking.findMany({ where: { partnerId }, select: { bookingRef: true } })).map((b) => b.bookingRef);
    // Conversions without a transaction ID can never match a booking, so they count as missing too
    // (a bare NOT IN would drop them under SQL NULL semantics).
    const where = {
      organizationId: auth.organizationId,
      campaignId: partner.campaignId,
      status: { in: ['pending', 'approved'] as Array<'pending' | 'approved'> },
      OR: [{ transactionId: null }, { transactionId: { notIn: refs } }],
    };
    const [items, total] = await Promise.all([
      this.prisma.conversion.findMany({
        where,
        select: { id: true, publicId: true, transactionId: true, saleAmount: true, currency: true, status: true, convertedAt: true },
        orderBy: { convertedAt: 'desc' },
        take: 200,
      }),
      this.prisma.conversion.count({ where }),
    ]);
    return { campaignLinked: true, items: serialize(items), total };
  }
}
