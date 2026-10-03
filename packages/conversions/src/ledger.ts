import { Prisma, type Conversion } from '@ntrack/db';

const ZERO = new Prisma.Decimal(0);

/**
 * Brings the ledger in line with a conversion's current state. Approved conversions should have
 * their revenue and payout booked; anything else should have nothing booked. Only the
 * difference from what is already booked is posted, so calling this after any change (approve,
 * adjust, reject, reverse, re-approve) is idempotent and history is never rewritten.
 *
 * Accrual entries (debits positive, credits negative):
 *   revenue: Dr advertiser_receivable / Cr network_revenue
 *   payout:  Dr network_cost          / Cr publisher_payable
 */
export const syncConversionLedger = async (tx: Prisma.TransactionClient, conversion: Conversion, actorUserId?: string | null): Promise<Conversion> => {
  const approved = conversion.status === 'approved';
  const deltaRevenue = (approved ? conversion.revenue : ZERO).minus(conversion.bookedRevenue);
  const deltaPayout = (approved ? conversion.payout : ZERO).minus(conversion.bookedPayout);
  if (deltaRevenue.isZero() && deltaPayout.isZero()) return conversion;

  const type = !approved ? 'conversion_unbooked' : conversion.bookedRevenue.isZero() && conversion.bookedPayout.isZero() ? 'conversion_approved' : 'conversion_adjusted';
  const base = {
    organizationId: conversion.organizationId,
    campaignId: conversion.campaignId,
    conversionId: conversion.id,
    currency: conversion.currency,
  };
  const entries: Prisma.LedgerEntryCreateManyJournalInput[] = [];
  if (!deltaRevenue.isZero()) {
    entries.push({ ...base, account: 'advertiser_receivable', advertiserId: conversion.advertiserId, amount: deltaRevenue });
    entries.push({ ...base, account: 'network_revenue', advertiserId: conversion.advertiserId, amount: deltaRevenue.negated() });
  }
  if (!deltaPayout.isZero()) {
    entries.push({ ...base, account: 'network_cost', publisherId: conversion.publisherId, amount: deltaPayout });
    entries.push({ ...base, account: 'publisher_payable', publisherId: conversion.publisherId, amount: deltaPayout.negated() });
  }
  await tx.ledgerJournal.create({
    data: {
      organizationId: conversion.organizationId,
      type,
      reference: conversion.publicId,
      memo: `Conversion ${conversion.publicId} ${conversion.status}`,
      currency: conversion.currency,
      createdById: actorUserId ?? null,
      entries: { createMany: { data: entries } },
    },
  });
  return tx.conversion.update({
    where: { id: conversion.id },
    data: { bookedRevenue: approved ? conversion.revenue : ZERO, bookedPayout: approved ? conversion.payout : ZERO },
  });
};
