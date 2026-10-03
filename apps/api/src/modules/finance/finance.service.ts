import type { z } from 'zod';
import { Prisma, type PaymentTerms } from '@ntrack/db';
import { generatePublicId } from '@ntrack/shared';
import { AppError } from '../../lib/errors';
import { paginated } from '../../lib/response';
import { serialize } from '../../lib/serialize';
import { advertiserWhere, isAdvertiserPortal, isPublisherPortal, publisherWhere } from '../../services/access-scope';
import { writeAudit } from '../../services/audit';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';
import type { CreateInvoiceBody, CreditNoteBody, ExchangeRateBody, ListInvoicesQuery, ListPaymentsQuery, ListPayoutsQuery, MarkPaidBody, PaymentBody, RequestPayoutBody } from './finance.schemas';

const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);
const TERMS_DAYS: Record<Exclude<PaymentTerms, 'CUSTOM'>, number> = { NET7: 7, NET15: 15, NET30: 30, NET45: 45, NET60: 60 };
const dayStart = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const dayEnd = (iso: string) => new Date(`${iso}T23:59:59.999Z`);
const round2 = (value: Prisma.Decimal) => value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/**
 * Finance: double-entry ledger balances, invoices and credit notes, incoming payments, publisher
 * payouts and exchange rates. Historical rows are never edited; every correction is a new
 * journal (and an audit entry).
 */
export class FinanceService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }

  private scopeFilter(auth: OrgAuthContext) {
    return {
      advertiserIds: auth.scope.restricted ? auth.scope.advertiserIds : null,
      publisherIds: auth.scope.restricted ? auth.scope.publisherIds : null,
    };
  }

  // ─── Balances ─────────────────────────────────────────────────────────────

  /** Receivables per advertiser and payables per publisher from the ledger, plus pending (unapproved) amounts. */
  async balances(auth: OrgAuthContext) {
    const { advertiserIds, publisherIds } = this.scopeFilter(auth);
    const showAdvertisers = !isPublisherPortal(auth.scope);
    const showPublishers = !isAdvertiserPortal(auth.scope);

    const [receivables, payables, pendingAdv, pendingPub, openPayouts] = await Promise.all([
      showAdvertisers
        ? this.prisma.ledgerEntry.groupBy({
            by: ['advertiserId', 'currency'],
            where: { organizationId: auth.organizationId, account: 'advertiser_receivable', ...(advertiserIds ? { advertiserId: { in: advertiserIds } } : {}) },
            _sum: { amount: true },
          })
        : [],
      showPublishers
        ? this.prisma.ledgerEntry.groupBy({
            by: ['publisherId', 'currency'],
            where: { organizationId: auth.organizationId, account: 'publisher_payable', ...(publisherIds ? { publisherId: { in: publisherIds } } : {}) },
            _sum: { amount: true },
          })
        : [],
      showAdvertisers
        ? this.prisma.conversion.groupBy({
            by: ['advertiserId', 'currency'],
            where: { organizationId: auth.organizationId, status: 'pending', ...(advertiserIds ? { advertiserId: { in: advertiserIds } } : {}) },
            _sum: { revenue: true },
          })
        : [],
      showPublishers
        ? this.prisma.conversion.groupBy({
            by: ['publisherId', 'currency'],
            where: { organizationId: auth.organizationId, status: 'pending', ...(publisherIds ? { publisherId: { in: publisherIds } } : {}) },
            _sum: { payout: true },
          })
        : [],
      showPublishers
        ? this.prisma.publisherPayout.groupBy({
            by: ['publisherId', 'currency'],
            where: { organizationId: auth.organizationId, status: { in: ['requested', 'approved'] }, ...(publisherIds ? { publisherId: { in: publisherIds } } : {}) },
            _sum: { amount: true },
          })
        : [],
    ]);

    const [advertisers, publishers] = await Promise.all([
      this.prisma.advertiser.findMany({ where: { organizationId: auth.organizationId, ...advertiserWhere(auth.scope) }, select: { id: true, companyName: true, paymentTerms: true } }),
      this.prisma.publisher.findMany({ where: { organizationId: auth.organizationId, ...publisherWhere(auth.scope) }, select: { id: true, companyName: true, paymentTerms: true } }),
    ]);

    const advertiserRows = advertisers
      .flatMap((a) => {
        const currencies = new Set([...receivables.filter((r) => r.advertiserId === a.id).map((r) => r.currency), ...pendingAdv.filter((r) => r.advertiserId === a.id).map((r) => r.currency)]);
        return [...currencies].map((currency) => ({
          advertiserId: a.id,
          name: a.companyName,
          paymentTerms: a.paymentTerms,
          currency,
          receivable: round2(D(receivables.find((r) => r.advertiserId === a.id && r.currency === currency)?._sum.amount ?? 0)).toString(),
          pending: round2(D(pendingAdv.find((r) => r.advertiserId === a.id && r.currency === currency)?._sum.revenue ?? 0)).toString(),
        }));
      })
      .sort((x, y) => Number(y.receivable) - Number(x.receivable));

    const publisherRows = publishers
      .flatMap((p) => {
        const currencies = new Set([...payables.filter((r) => r.publisherId === p.id).map((r) => r.currency), ...pendingPub.filter((r) => r.publisherId === p.id).map((r) => r.currency)]);
        return [...currencies].map((currency) => {
          const payable = D(payables.find((r) => r.publisherId === p.id && r.currency === currency)?._sum.amount ?? 0).negated();
          const inPayouts = D(openPayouts.find((r) => r.publisherId === p.id && r.currency === currency)?._sum.amount ?? 0);
          return {
            publisherId: p.id,
            name: p.companyName,
            paymentTerms: p.paymentTerms,
            currency,
            payable: round2(payable).toString(),
            inOpenPayouts: round2(inPayouts).toString(),
            available: round2(Prisma.Decimal.max(payable.minus(inPayouts), 0)).toString(),
            pending: round2(D(pendingPub.find((r) => r.publisherId === p.id && r.currency === currency)?._sum.payout ?? 0)).toString(),
          };
        });
      })
      .sort((x, y) => Number(y.payable) - Number(x.payable));

    return { advertisers: showAdvertisers ? advertiserRows : null, publishers: showPublishers ? publisherRows : null };
  }

  /** Organization totals per currency and converted to the base currency with the latest manual rates. */
  async overview(auth: OrgAuthContext) {
    if (auth.scope.restricted) throw AppError.forbidden('The finance overview is available to organization-wide finance roles');
    const organization = await this.prisma.organization.findUniqueOrThrow({ where: { id: auth.organizationId } });
    const [byAccount, pending, rates, overdue, openPayouts] = await Promise.all([
      this.prisma.ledgerEntry.groupBy({ by: ['account', 'currency'], where: { organizationId: auth.organizationId }, _sum: { amount: true } }),
      this.prisma.conversion.groupBy({ by: ['currency'], where: { organizationId: auth.organizationId, status: 'pending' }, _sum: { revenue: true, payout: true } }),
      this.latestRates(auth.organizationId),
      this.prisma.invoice.aggregate({ where: { organizationId: auth.organizationId, status: 'issued', dueDate: { lt: new Date() } }, _sum: { total: true, amountPaid: true }, _count: true }),
      this.prisma.publisherPayout.count({ where: { organizationId: auth.organizationId, status: { in: ['requested', 'approved'] } } }),
    ]);
    const currencies = [...new Set([...byAccount.map((r) => r.currency), ...pending.map((r) => r.currency)])];
    const sum = (account: string, currency: string) => D(byAccount.find((r) => r.account === account && r.currency === currency)?._sum.amount ?? 0);
    const perCurrency = currencies.map((currency) => {
      const revenue = sum('network_revenue', currency).negated();
      const cost = sum('network_cost', currency);
      return {
        currency,
        approvedRevenue: round2(revenue).toString(),
        approvedPayout: round2(cost).toString(),
        margin: round2(revenue.minus(cost)).toString(),
        receivable: round2(sum('advertiser_receivable', currency)).toString(),
        payable: round2(sum('publisher_payable', currency).negated()).toString(),
        cash: round2(sum('cash', currency)).toString(),
        pendingRevenue: round2(D(pending.find((p) => p.currency === currency)?._sum.revenue ?? 0)).toString(),
        pendingPayout: round2(D(pending.find((p) => p.currency === currency)?._sum.payout ?? 0)).toString(),
      };
    });
    const missingRates = currencies.filter((c) => c !== organization.currency && !rates.has(c));
    const convert = (field: keyof (typeof perCurrency)[number]) =>
      missingRates.length
        ? null
        : round2(perCurrency.reduce((acc, row) => acc.plus(D(row[field] as string).times(row.currency === organization.currency ? 1 : rates.get(row.currency)!)), D(0))).toString();
    return {
      baseCurrency: organization.currency,
      perCurrency,
      converted: {
        approvedRevenue: convert('approvedRevenue'),
        approvedPayout: convert('approvedPayout'),
        margin: convert('margin'),
        receivable: convert('receivable'),
        payable: convert('payable'),
      },
      missingRates,
      overdueInvoices: { count: overdue._count, outstanding: round2(D(overdue._sum.total ?? 0).minus(D(overdue._sum.amountPaid ?? 0))).toString() },
      openPayouts,
    };
  }

  private async latestRates(organizationId: string) {
    const rows = await this.prisma.exchangeRate.findMany({ where: { organizationId, effectiveDate: { lte: new Date() } }, orderBy: { effectiveDate: 'desc' } });
    const map = new Map<string, Prisma.Decimal>();
    for (const row of rows) if (!map.has(row.currency)) map.set(row.currency, row.rateToBase);
    return map;
  }

  async journals(auth: OrgAuthContext, query: { page: number; pageSize: number }) {
    if (auth.scope.restricted) throw AppError.forbidden();
    const where = { organizationId: auth.organizationId };
    const [items, total] = await Promise.all([
      this.prisma.ledgerJournal.findMany({ where, include: { entries: true }, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.ledgerJournal.count({ where }),
    ]);
    return paginated(serialize(items), total, query.page, query.pageSize);
  }

  // ─── Invoices ─────────────────────────────────────────────────────────────

  private async nextInvoiceNumber(organizationId: string, prefix: 'INV' | 'CN') {
    const year = new Date().getUTCFullYear();
    const count = await this.prisma.invoice.count({ where: { organizationId, number: { startsWith: `${prefix}-${year}-` } } });
    return `${prefix}-${year}-${String(count + 1).padStart(5, '0')}`;
  }

  async listInvoices(auth: OrgAuthContext, query: z.infer<typeof ListInvoicesQuery>) {
    if (isPublisherPortal(auth.scope)) throw AppError.forbidden();
    const where: Prisma.InvoiceWhereInput = {
      organizationId: auth.organizationId,
      ...(auth.scope.restricted ? { advertiserId: { in: auth.scope.advertiserIds } } : {}),
      ...(query.advertiserId ? { advertiserId: query.advertiserId } : {}),
      ...(query.status ? { status: query.status } : {}),
      // Advertisers never see drafts.
      ...(isAdvertiserPortal(auth.scope) ? { status: { not: 'draft' } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.invoice.findMany({ where, include: { advertiser: { select: { companyName: true } } }, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.invoice.count({ where }),
    ]);
    return paginated(serialize(items), total, query.page, query.pageSize);
  }

  private async findInvoice(auth: OrgAuthContext, id: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, organizationId: auth.organizationId, ...(auth.scope.restricted ? { advertiserId: { in: auth.scope.advertiserIds } } : {}) },
      include: { lines: true, payments: { orderBy: { paidAt: 'asc' } }, advertiser: { select: { id: true, companyName: true, address: true, country: true, taxId: true, email: true } } },
    });
    if (!invoice || (isAdvertiserPortal(auth.scope) && invoice.status === 'draft') || isPublisherPortal(auth.scope)) throw AppError.notFound('Invoice');
    return invoice;
  }

  async getInvoice(auth: OrgAuthContext, id: string) {
    const invoice = await this.findInvoice(auth, id);
    const organization = await this.prisma.organization.findUniqueOrThrow({ where: { id: auth.organizationId }, select: { name: true } });
    return serialize({ ...invoice, issuer: organization });
  }

  /** Draft invoice from approved, not-yet-invoiced conversions in the period (one line per campaign). */
  async createInvoice(auth: OrgAuthContext, input: z.infer<typeof CreateInvoiceBody>, meta: RequestMeta) {
    const advertiser = await this.prisma.advertiser.findFirst({ where: { id: input.advertiserId, organizationId: auth.organizationId } });
    if (!advertiser) throw AppError.badRequest('Unknown advertiser');
    const where: Prisma.ConversionWhereInput = {
      organizationId: auth.organizationId,
      advertiserId: advertiser.id,
      status: 'approved',
      invoiceId: null,
      currency: input.currency,
      convertedAt: { gte: dayStart(input.periodStart), lte: dayEnd(input.periodEnd) },
    };
    const grouped = await this.prisma.conversion.groupBy({ by: ['campaignId'], where, _sum: { revenue: true }, _count: { _all: true } });
    if (grouped.length === 0) throw AppError.badRequest('No approved, uninvoiced conversions in this period and currency');
    const campaigns = await this.prisma.campaign.findMany({ where: { id: { in: grouped.map((g) => g.campaignId) } }, select: { id: true, name: true } });
    const lines = grouped.map((g) => ({
      campaignId: g.campaignId,
      description: `${campaigns.find((c) => c.id === g.campaignId)?.name ?? 'Campaign'} (${input.periodStart} to ${input.periodEnd})`,
      quantity: g._count._all,
      amount: round2(D(g._sum.revenue ?? 0)),
    }));
    const subtotal = lines.reduce((acc, l) => acc.plus(l.amount), D(0));
    const taxAmount = round2(subtotal.times(input.taxRate).dividedBy(100));
    const number = await this.nextInvoiceNumber(auth.organizationId, 'INV');

    const invoice = await this.prisma.$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: {
          publicId: generatePublicId('inv'),
          organizationId: auth.organizationId,
          advertiserId: advertiser.id,
          number,
          currency: input.currency,
          periodStart: dayStart(input.periodStart),
          periodEnd: dayEnd(input.periodEnd),
          subtotal,
          taxRate: input.taxRate,
          taxAmount,
          total: subtotal.plus(taxAmount),
          notes: input.notes,
          createdById: auth.user.id,
          lines: { createMany: { data: lines } },
        },
      });
      await tx.conversion.updateMany({ where, data: { invoiceId: created.id } });
      return created;
    });
    await writeAudit(this.prisma, auth, meta, { action: 'invoice.created', entityType: 'invoice', entityId: invoice.id, summary: `${number} ${invoice.total.toString()} ${invoice.currency}` });
    return this.getInvoice(auth, invoice.id);
  }

  async issueInvoice(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const invoice = await this.findInvoice(auth, id);
    if (invoice.status !== 'draft') throw AppError.conflict('Only draft invoices can be issued');
    const advertiser = await this.prisma.advertiser.findUniqueOrThrow({ where: { id: invoice.advertiserId } });
    const days = advertiser.paymentTerms === 'CUSTOM' ? (advertiser.customPaymentDays ?? 30) : TERMS_DAYS[advertiser.paymentTerms];
    const issuedAt = new Date();
    await this.prisma.invoice.update({ where: { id }, data: { status: 'issued', issuedAt, dueDate: new Date(issuedAt.getTime() + days * 86_400_000) } });
    await writeAudit(this.prisma, auth, meta, { action: 'invoice.issued', entityType: 'invoice', entityId: id, summary: invoice.number });
    return this.getInvoice(auth, id);
  }

  async voidInvoice(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const invoice = await this.findInvoice(auth, id);
    if (invoice.status === 'paid' || invoice.status === 'void') throw AppError.conflict(`A ${invoice.status} invoice cannot be voided`);
    if (invoice.payments.length) throw AppError.conflict('Invoices with recorded payments cannot be voided; issue a credit note instead');
    await this.prisma.$transaction([
      this.prisma.conversion.updateMany({ where: { invoiceId: id }, data: { invoiceId: null } }),
      this.prisma.invoice.update({ where: { id }, data: { status: 'void', voidedAt: new Date() } }),
    ]);
    await writeAudit(this.prisma, auth, meta, { action: 'invoice.voided', entityType: 'invoice', entityId: id, summary: invoice.number });
    return this.getInvoice(auth, id);
  }

  /** Credit note: reduces the receivable and recognised revenue by the credited amount. */
  async creditNote(auth: OrgAuthContext, id: string, input: z.infer<typeof CreditNoteBody>, meta: RequestMeta) {
    const invoice = await this.findInvoice(auth, id);
    if (invoice.type !== 'invoice' || !['issued', 'paid'].includes(invoice.status)) throw AppError.conflict('Credit notes apply to issued or paid invoices');
    const value = round2(D(input.amount));
    if (value.greaterThan(invoice.total)) throw AppError.badRequest('A credit note cannot exceed the invoice total');
    const number = await this.nextInvoiceNumber(auth.organizationId, 'CN');
    const note = await this.prisma.$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: {
          publicId: generatePublicId('inv'),
          organizationId: auth.organizationId,
          advertiserId: invoice.advertiserId,
          type: 'credit_note',
          number,
          status: 'issued',
          currency: invoice.currency,
          periodStart: invoice.periodStart,
          periodEnd: invoice.periodEnd,
          subtotal: value.negated(),
          total: value.negated(),
          issuedAt: new Date(),
          notes: input.reason,
          creditForId: invoice.id,
          createdById: auth.user.id,
          lines: { create: [{ description: `Credit against ${invoice.number}: ${input.reason}`, quantity: 1, amount: value.negated() }] },
        },
      });
      await tx.ledgerJournal.create({
        data: {
          organizationId: auth.organizationId,
          type: 'credit_note',
          reference: number,
          memo: input.reason,
          currency: invoice.currency,
          createdById: auth.user.id,
          entries: {
            createMany: {
              data: [
                { organizationId: auth.organizationId, account: 'network_revenue', advertiserId: invoice.advertiserId, amount: value, currency: invoice.currency },
                { organizationId: auth.organizationId, account: 'advertiser_receivable', advertiserId: invoice.advertiserId, amount: value.negated(), currency: invoice.currency },
              ],
            },
          },
        },
      });
      return created;
    });
    await writeAudit(this.prisma, auth, meta, { action: 'invoice.credit_note', entityType: 'invoice', entityId: note.id, summary: `${number} for ${invoice.number}: ${value.toString()}` });
    return this.getInvoice(auth, note.id);
  }

  // ─── Payments ─────────────────────────────────────────────────────────────

  async listPayments(auth: OrgAuthContext, query: z.infer<typeof ListPaymentsQuery>) {
    const where: Prisma.PaymentWhereInput = {
      organizationId: auth.organizationId,
      ...(query.direction ? { direction: query.direction } : {}),
      ...(auth.scope.restricted ? { OR: [{ advertiserId: { in: auth.scope.advertiserIds } }, { publisherId: { in: auth.scope.publisherIds } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        include: { advertiser: { select: { companyName: true } }, publisher: { select: { companyName: true } }, invoice: { select: { number: true } } },
        orderBy: { paidAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.payment.count({ where }),
    ]);
    return paginated(serialize(items), total, query.page, query.pageSize);
  }

  /** Incoming advertiser payment: Dr cash / Cr advertiser_receivable; settles the invoice when fully paid. */
  async recordPayment(auth: OrgAuthContext, input: z.infer<typeof PaymentBody>, meta: RequestMeta) {
    const advertiser = await this.prisma.advertiser.findFirst({ where: { id: input.advertiserId, organizationId: auth.organizationId } });
    if (!advertiser) throw AppError.badRequest('Unknown advertiser');
    const value = round2(D(input.amount));
    const invoice = input.invoiceId ? await this.prisma.invoice.findFirst({ where: { id: input.invoiceId, organizationId: auth.organizationId, advertiserId: advertiser.id } }) : null;
    if (input.invoiceId && !invoice) throw AppError.badRequest('Unknown invoice for this advertiser');
    if (invoice && (invoice.status !== 'issued' || invoice.type !== 'invoice')) throw AppError.conflict('Payments can be recorded against issued invoices only');
    if (invoice && invoice.currency !== input.currency) throw AppError.badRequest('Payment currency must match the invoice');

    const payment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          publicId: generatePublicId('pay'),
          organizationId: auth.organizationId,
          direction: 'incoming',
          advertiserId: advertiser.id,
          invoiceId: invoice?.id ?? null,
          amount: value,
          currency: input.currency,
          method: input.method,
          reference: input.reference,
          paidAt: dayStart(input.paidAt),
          notes: input.notes,
          createdById: auth.user.id,
        },
      });
      await tx.ledgerJournal.create({
        data: {
          organizationId: auth.organizationId,
          type: 'payment_received',
          reference: input.reference || created.publicId,
          memo: `Payment from ${advertiser.companyName}`,
          currency: input.currency,
          createdById: auth.user.id,
          entries: {
            createMany: {
              data: [
                { organizationId: auth.organizationId, account: 'cash', advertiserId: advertiser.id, amount: value, currency: input.currency },
                { organizationId: auth.organizationId, account: 'advertiser_receivable', advertiserId: advertiser.id, amount: value.negated(), currency: input.currency },
              ],
            },
          },
        },
      });
      if (invoice) {
        const paid = invoice.amountPaid.plus(value);
        await tx.invoice.update({ where: { id: invoice.id }, data: { amountPaid: paid, ...(paid.greaterThanOrEqualTo(invoice.total) ? { status: 'paid', paidAt: dayStart(input.paidAt) } : {}) } });
      }
      return created;
    });
    await writeAudit(this.prisma, auth, meta, { action: 'payment.received', entityType: 'payment', entityId: payment.id, summary: `${value.toString()} ${input.currency} from ${advertiser.companyName}` });
    return serialize(payment);
  }

  // ─── Publisher payouts ────────────────────────────────────────────────────

  async listPayouts(auth: OrgAuthContext, query: z.infer<typeof ListPayoutsQuery>) {
    if (isAdvertiserPortal(auth.scope)) throw AppError.forbidden();
    const where: Prisma.PublisherPayoutWhereInput = {
      organizationId: auth.organizationId,
      ...(auth.scope.restricted ? { publisherId: { in: auth.scope.publisherIds } } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.publisherId ? { publisherId: query.publisherId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.publisherPayout.findMany({ where, include: { publisher: { select: { companyName: true } } }, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.publisherPayout.count({ where }),
    ]);
    return paginated(serialize(items), total, query.page, query.pageSize);
  }

  /**
   * Requests a payout of the publisher's available balance: ledger payable minus payouts already
   * requested or approved. Using the ledger means reversals after a previous payout are clawed back
   * automatically. Approved conversions not yet in a payout are linked for traceability.
   */
  async requestPayout(auth: OrgAuthContext, input: z.infer<typeof RequestPayoutBody>, meta: RequestMeta) {
    const publisherId = isPublisherPortal(auth.scope) ? auth.scope.publisherIds[0] : input.publisherId;
    if (!publisherId) throw AppError.badRequest('Choose a publisher');
    if (!isPublisherPortal(auth.scope) && !auth.permissions.has('finance.manage')) throw AppError.forbidden();
    const publisher = await this.prisma.publisher.findFirst({ where: { id: publisherId, organizationId: auth.organizationId } });
    if (!publisher) throw AppError.badRequest('Unknown publisher');

    const [payable, open] = await Promise.all([
      this.prisma.ledgerEntry.aggregate({ where: { organizationId: auth.organizationId, account: 'publisher_payable', publisherId, currency: input.currency }, _sum: { amount: true } }),
      this.prisma.publisherPayout.aggregate({ where: { organizationId: auth.organizationId, publisherId, currency: input.currency, status: { in: ['requested', 'approved'] } }, _sum: { amount: true } }),
    ]);
    const available = round2(D(payable._sum.amount ?? 0).negated().minus(D(open._sum.amount ?? 0)));
    if (available.lessThanOrEqualTo(0)) throw AppError.badRequest('There is no available balance to pay out in this currency');

    const payout = await this.prisma.$transaction(async (tx) => {
      const created = await tx.publisherPayout.create({
        data: {
          publicId: generatePublicId('po'),
          organizationId: auth.organizationId,
          publisherId,
          currency: input.currency,
          amount: available,
          periodEnd: new Date(),
          requestedById: auth.user.id,
          notes: input.notes,
        },
      });
      const linked = await tx.conversion.updateMany({ where: { organizationId: auth.organizationId, publisherId, currency: input.currency, status: 'approved', payoutId: null }, data: { payoutId: created.id } });
      return tx.publisherPayout.update({ where: { id: created.id }, data: { conversionCount: linked.count } });
    });
    await writeAudit(this.prisma, auth, meta, { action: 'payout.requested', entityType: 'payout', entityId: payout.id, summary: `${available.toString()} ${input.currency} for ${publisher.companyName}` });
    this.deps.notifier.emit({
      organizationId: auth.organizationId,
      type: 'payout.requested',
      title: `Payout requested: ${publisher.companyName}`,
      body: `${available.toFixed(2)} ${input.currency} covering ${payout.conversionCount} approved conversions is waiting for approval.`,
      link: '/ntrack/finance/payouts',
      subject: { publisherId },
      actorUserId: auth.user.id,
    });
    return serialize(payout);
  }

  private async findPayout(auth: OrgAuthContext, id: string) {
    const payout = await this.prisma.publisherPayout.findFirst({ where: { id, organizationId: auth.organizationId }, include: { publisher: true } });
    if (!payout) throw AppError.notFound('Payout');
    return payout;
  }

  async approvePayout(auth: OrgAuthContext, id: string, meta: RequestMeta) {
    const payout = await this.findPayout(auth, id);
    if (payout.status !== 'requested') throw AppError.conflict('Only requested payouts can be approved');
    if (payout.requestedById === auth.user.id && !auth.user.isPlatformAdmin) throw AppError.forbidden('A different person must approve a payout they requested (four-eyes rule)');
    const updated = await this.prisma.publisherPayout.update({ where: { id }, data: { status: 'approved', approvedById: auth.user.id, approvedAt: new Date() } });
    await writeAudit(this.prisma, auth, meta, { action: 'payout.approved', entityType: 'payout', entityId: id, summary: `${payout.amount.toString()} ${payout.currency}` });
    this.notifyPayout(auth, payout, 'approved', 'It will be paid according to your payment terms.');
    return serialize(updated);
  }

  async rejectPayout(auth: OrgAuthContext, id: string, reason: string, meta: RequestMeta) {
    const payout = await this.findPayout(auth, id);
    if (!['requested', 'approved'].includes(payout.status)) throw AppError.conflict('Only open payouts can be rejected');
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.conversion.updateMany({ where: { payoutId: id }, data: { payoutId: null } });
      return tx.publisherPayout.update({ where: { id }, data: { status: 'rejected', rejectionReason: reason } });
    });
    await writeAudit(this.prisma, auth, meta, { action: 'payout.rejected', entityType: 'payout', entityId: id, summary: reason });
    this.notifyPayout(auth, payout, 'rejected', `Reason: ${reason}`);
    return serialize(updated);
  }

  /** Records the outgoing payment: Dr publisher_payable / Cr cash. */
  async markPayoutPaid(auth: OrgAuthContext, id: string, input: z.infer<typeof MarkPaidBody>, meta: RequestMeta) {
    const payout = await this.findPayout(auth, id);
    if (payout.status !== 'approved') throw AppError.conflict('Approve the payout before marking it paid');
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          publicId: generatePublicId('pay'),
          organizationId: auth.organizationId,
          direction: 'outgoing',
          publisherId: payout.publisherId,
          payoutId: payout.id,
          amount: payout.amount,
          currency: payout.currency,
          method: input.method,
          reference: input.reference,
          paidAt: dayStart(input.paidAt),
          createdById: auth.user.id,
        },
      });
      await tx.ledgerJournal.create({
        data: {
          organizationId: auth.organizationId,
          type: 'payout_paid',
          reference: input.reference,
          memo: `Payout ${payout.publicId} to ${payout.publisher.companyName}`,
          currency: payout.currency,
          createdById: auth.user.id,
          entries: {
            createMany: {
              data: [
                { organizationId: auth.organizationId, account: 'publisher_payable', publisherId: payout.publisherId, amount: payout.amount, currency: payout.currency },
                { organizationId: auth.organizationId, account: 'cash', publisherId: payout.publisherId, amount: payout.amount.negated(), currency: payout.currency },
              ],
            },
          },
        },
      });
      return tx.publisherPayout.update({ where: { id }, data: { status: 'paid', paidAt: dayStart(input.paidAt) } });
    });
    await writeAudit(this.prisma, auth, meta, { action: 'payout.paid', entityType: 'payout', entityId: id, summary: `${payout.amount.toString()} ${payout.currency} ref ${input.reference}` });
    this.notifyPayout(auth, payout, 'paid', `Payment reference: ${input.reference}`);
    return serialize(updated);
  }

  /** Publisher-facing payout status update (their own payout amount only). */
  private notifyPayout(auth: OrgAuthContext, payout: { publicId: string; publisherId: string; amount: Prisma.Decimal; currency: string }, status: string, detail: string) {
    this.deps.notifier.emit({
      organizationId: auth.organizationId,
      type: 'payout.updated',
      title: `Payout ${payout.publicId} ${status}: ${payout.amount.toFixed(2)} ${payout.currency}`,
      body: detail,
      link: '/ntrack/finance/payouts',
      subject: { publisherId: payout.publisherId },
      actorUserId: auth.user.id,
    });
  }

  // ─── Exchange rates ───────────────────────────────────────────────────────

  async listRates(auth: OrgAuthContext) {
    return serialize(await this.prisma.exchangeRate.findMany({ where: { organizationId: auth.organizationId }, orderBy: [{ effectiveDate: 'desc' }, { currency: 'asc' }], take: 200 }));
  }

  async saveRate(auth: OrgAuthContext, input: z.infer<typeof ExchangeRateBody>, meta: RequestMeta) {
    const rate = await this.prisma.exchangeRate.upsert({
      where: { organizationId_currency_effectiveDate: { organizationId: auth.organizationId, currency: input.currency, effectiveDate: dayStart(input.effectiveDate) } },
      create: { organizationId: auth.organizationId, currency: input.currency, rateToBase: input.rateToBase, effectiveDate: dayStart(input.effectiveDate) },
      update: { rateToBase: input.rateToBase },
    });
    await writeAudit(this.prisma, auth, meta, { action: 'exchange_rate.saved', entityType: 'exchange_rate', entityId: rate.id, summary: `${input.currency} = ${input.rateToBase} on ${input.effectiveDate}` });
    return serialize(rate);
  }
}
