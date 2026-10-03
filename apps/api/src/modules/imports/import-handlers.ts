import type { ZodError } from 'zod';
import {
  CAMPAIGN_CATEGORIES,
  CONVERSION_EVENTS,
  CURRENCIES,
  PAYOUT_MODELS,
  mapAccessStatus,
  mapCampaignStatus,
  mapCategory,
  mapGoal,
  mapPartnerStatus,
  mapVisibility,
  translateTrackierUrl,
  type ImportEntity,
} from '@ntrack/shared';
import type { AppDeps, OrgAuthContext, RequestMeta } from '../../types';
import { AdvertiserBody } from '../advertisers/advertisers.schemas';
import { AdvertisersService } from '../advertisers/advertisers.service';
import { AssignPublisherBody, CreateCampaignBody, PayoutTierBody } from '../campaigns/campaigns.schemas';
import { CampaignPartnersService } from '../campaigns/campaign-partners.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { PublisherBody } from '../publishers/publishers.schemas';
import { PublishersService } from '../publishers/publishers.service';

/**
 * Per-entity import rules. Each row is turned into exactly the input the normal create endpoint
 * accepts and validated with the same schema, so imported records meet the same rules as records
 * created by hand. Existing NTrack records are only ever linked, never changed.
 */

export const SOURCE = 'trackier';

export interface ImportContext {
  deps: AppDeps;
  auth: OrgAuthContext;
  meta: RequestMeta;
  options: { activateCampaigns: boolean };
  /** NTrack ID for an external record already imported or linked. */
  resolve: (entityType: 'advertiser' | 'publisher' | 'campaign', externalId: string) => Promise<string | null>;
}

export interface BuiltRow {
  externalId: string;
  input: Record<string, unknown> | null;
  errors: string[];
  warnings: string[];
}

export interface MatchResult {
  match: 'new' | 'already_imported' | 'possible_duplicate' | 'existing';
  matchedId?: string;
  matchedLabel?: string;
  decision: 'create' | 'link' | 'skip' | null;
}

export interface EntityHandler {
  /** Entity type recorded in external_refs (null when rows have no own external ID). */
  refType: 'advertiser' | 'publisher' | 'campaign' | null;
  build(values: Record<string, string>, ctx: ImportContext): Promise<BuiltRow>;
  match(row: BuiltRow, ctx: ImportContext): Promise<MatchResult>;
  create(input: Record<string, unknown>, ctx: ImportContext): Promise<string>;
  undo(entityId: string, ctx: ImportContext): Promise<'deleted' | 'archived' | 'suspended'>;
}

const issues = (error: ZodError) => error.issues.map((i) => `${i.path.join('.') || 'row'}: ${i.message}`);
const clean = (value: string | undefined) => (value ?? '').trim();
const upper = (value: string | undefined) => clean(value).toUpperCase();
const amountOf = (value: string | undefined) => {
  const v = clean(value).replace(/[^0-9.]/g, '');
  return v === '' ? '0' : v;
};
const intOf = (value: string | undefined) => {
  const v = clean(value).replace(/[^0-9]/g, '');
  return v === '' ? null : Number(v);
};
const urlOf = (value: string | undefined) => {
  const v = clean(value);
  return v && !/^https?:\/\//i.test(v) ? `https://${v}` : v;
};
const yes = (value: string | undefined) => ['yes', 'y', 'true', '1', '%'].includes(clean(value).toLowerCase());

/** Advertisers and publishers share most rules. */
const partnerHandler = (kind: 'advertiser' | 'publisher'): EntityHandler => ({
  refType: kind,
  async build(values) {
    const externalId = clean(values.externalId);
    const base = {
      companyName: clean(values.companyName),
      email: clean(values.email),
      contactName: clean(values.contactName),
      phone: clean(values.phone),
      website: urlOf(values.website),
      country: upper(values.country).slice(0, 2),
      status: mapPartnerStatus(clean(values.status)),
      notes: externalId ? `Imported from Trackier (ID ${externalId})` : 'Imported from Trackier',
    };
    const currency = upper(values.currency);
    const candidate = kind === 'advertiser' && (CURRENCIES as readonly string[]).includes(currency) ? { ...base, currency } : base;
    const parsed = kind === 'advertiser' ? AdvertiserBody.safeParse(candidate) : PublisherBody.safeParse(candidate);
    const errors = parsed.success ? [] : issues(parsed.error);
    if (!externalId) errors.unshift('Missing Trackier ID');
    return { externalId, input: parsed.success ? (parsed.data as Record<string, unknown>) : null, errors, warnings: [] };
  },
  async match(row, ctx) {
    const existingRef = await ctx.resolve(kind, row.externalId);
    if (existingRef) return { match: 'already_imported', matchedId: existingRef, decision: 'skip' };
    const input = row.input as { email: string; companyName: string };
    const where = { organizationId: ctx.auth.organizationId };
    const model = kind === 'advertiser' ? ctx.deps.prisma.advertiser : ctx.deps.prisma.publisher;
    const byEmail = await (model as typeof ctx.deps.prisma.advertiser).findFirst({ where: { ...where, email: { equals: input.email, mode: 'insensitive' } }, select: { id: true, companyName: true } });
    if (byEmail) return { match: 'possible_duplicate', matchedId: byEmail.id, matchedLabel: byEmail.companyName, decision: 'link' };
    const byName = await (model as typeof ctx.deps.prisma.advertiser).findFirst({ where: { ...where, companyName: { equals: input.companyName, mode: 'insensitive' } }, select: { id: true, companyName: true } });
    if (byName) return { match: 'possible_duplicate', matchedId: byName.id, matchedLabel: byName.companyName, decision: null };
    return { match: 'new', decision: 'create' };
  },
  async create(input, ctx) {
    const created =
      kind === 'advertiser'
        ? await new AdvertisersService(ctx.deps).create(ctx.auth, input as never, ctx.meta)
        : await new PublishersService(ctx.deps).create(ctx.auth, input as never, ctx.meta);
    return (created as { id: string }).id;
  },
  async undo(entityId, ctx) {
    try {
      if (kind === 'advertiser') await new AdvertisersService(ctx.deps).remove(ctx.auth, entityId, ctx.meta);
      else await new PublishersService(ctx.deps).remove(ctx.auth, entityId, ctx.meta);
      return 'deleted';
    } catch {
      // In use since the import: keep it, but suspended.
      if (kind === 'advertiser') await new AdvertisersService(ctx.deps).update(ctx.auth, entityId, { status: 'suspended' }, ctx.meta);
      else await new PublishersService(ctx.deps).update(ctx.auth, entityId, { status: 'suspended' }, ctx.meta);
      return 'suspended';
    }
  },
});

const campaignHandler: EntityHandler = {
  refType: 'campaign',
  async build(values, ctx) {
    const externalId = clean(values.externalId);
    const errors: string[] = [];
    const warnings: string[] = [];
    const advertiserId = await ctx.resolve('advertiser', clean(values.advertiserExternalId));
    if (!advertiserId) errors.push(`Advertiser ${clean(values.advertiserExternalId) || '(blank)'} has not been imported or linked yet. Import advertisers first.`);
    const translated = translateTrackierUrl(clean(values.url));
    if (translated.unknown.length) errors.push(`Unknown Trackier macros in the URL: ${translated.unknown.map((m) => `{${m}}`).join(', ')}`);
    if (translated.idMacros.length) warnings.push(`{${translated.idMacros.join('}, {')}} will send NTrack IDs instead of Trackier IDs. Check the advertiser does not rely on Trackier IDs.`);
    const trackierStatus = mapCampaignStatus(clean(values.status));
    const status = trackierStatus === 'active' && ctx.options.activateCampaigns ? 'active' : 'draft';
    if (trackierStatus === 'active' && status === 'draft') warnings.push('Active in Trackier; imported as a draft so it does not serve until you activate it.');
    const payoutModel = upper(values.payoutModel).replace(/[^A-Z]/g, '');
    const model = (PAYOUT_MODELS as readonly string[]).includes(payoutModel) ? payoutModel : payoutModel.includes('REV') ? 'REVSHARE' : 'CPA';
    const currency = upper(values.currency);
    const countries = clean(values.countries)
      .split(/[,;|\s]+/)
      .map((c) => c.trim().toUpperCase())
      .filter((c) => /^[A-Z]{2}$/.test(c));
    const candidate = {
      name: clean(values.name),
      advertiserId: advertiserId ?? '00000000-0000-4000-8000-000000000000',
      description: clean(values.description),
      category: mapCategory(clean(values.category), CAMPAIGN_CATEGORIES),
      previewUrl: urlOf(values.previewUrl),
      status,
      visibility: mapVisibility(clean(values.visibility)),
      currency: (CURRENCIES as readonly string[]).includes(currency) ? currency : 'USD',
      payoutModel: model,
      revenueModel: model,
      defaultPayout: amountOf(values.payout),
      defaultRevenue: amountOf(values.revenue),
      geoAllowed: [...new Set(countries)],
      dailyClickCap: intOf(values.dailyClickCap),
      dailyConversionCap: intOf(values.dailyConversionCap),
      landingPages: [{ name: 'Main', url: translated.url, isDefault: true }],
    };
    const parsed = CreateCampaignBody.safeParse(candidate);
    if (!parsed.success) errors.push(...issues(parsed.error));
    if (!externalId) errors.unshift('Missing Trackier ID');
    return { externalId, input: errors.length ? null : (parsed.data as Record<string, unknown>), errors, warnings };
  },
  async match(row, ctx) {
    const existingRef = await ctx.resolve('campaign', row.externalId);
    if (existingRef) return { match: 'already_imported', matchedId: existingRef, decision: 'skip' };
    const input = row.input as { name: string; advertiserId: string };
    const same = await ctx.deps.prisma.campaign.findFirst({
      where: { organizationId: ctx.auth.organizationId, advertiserId: input.advertiserId, name: { equals: input.name, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
    if (same) return { match: 'possible_duplicate', matchedId: same.id, matchedLabel: same.name, decision: null };
    return { match: 'new', decision: 'create' };
  },
  async create(input, ctx) {
    const campaign = await new CampaignsService(ctx.deps).create(ctx.auth, input as never, ctx.meta);
    return (campaign as unknown as { id: string }).id;
  },
  async undo(entityId, ctx) {
    const service = new CampaignsService(ctx.deps);
    const campaign = await ctx.deps.prisma.campaign.findUniqueOrThrow({ where: { id: entityId }, select: { name: true } });
    try {
      await service.remove(ctx.auth, entityId, campaign.name, ctx.meta);
      return 'deleted';
    } catch {
      await service.setStatus(ctx.auth, entityId, { status: 'archived', note: 'Import undone' }, ctx.meta);
      return 'archived';
    }
  },
};

const payoutHandler: EntityHandler = {
  refType: null,
  async build(values, ctx) {
    const errors: string[] = [];
    const campaignRef = clean(values.campaignExternalId);
    const campaignId = await ctx.resolve('campaign', campaignRef);
    if (!campaignId) errors.push(`Campaign ${campaignRef || '(blank)'} has not been imported or linked yet. Import campaigns first.`);
    const publisherRef = clean(values.publisherExternalId);
    const publisherId = publisherRef ? await ctx.resolve('publisher', publisherRef) : null;
    if (publisherRef && !publisherId) errors.push(`Publisher ${publisherRef} has not been imported or linked yet.`);
    const goal = clean(values.goal);
    const event = mapGoal(goal, CONVERSION_EVENTS);
    const country = upper(values.country);
    const candidate = {
      name: `Imported${goal ? `: ${goal}` : ''}${country ? ` ${country}` : ''}`.slice(0, 120),
      publisherId,
      country: /^[A-Z]{2}$/.test(country) ? country : null,
      event,
      payout: amountOf(values.payout),
      revenue: amountOf(values.revenue),
      isPercentage: yes(values.isPercentage),
    };
    const parsed = PayoutTierBody.safeParse(candidate);
    if (!parsed.success) errors.push(...issues(parsed.error));
    const warnings = goal && event === 'custom' ? [`Goal "${goal}" has no matching NTrack event; imported as "custom".`] : [];
    return { externalId: `${campaignRef}:${goal}:${country}:${publisherRef}`, input: errors.length ? null : { ...(parsed.data as Record<string, unknown>), campaignId }, errors, warnings };
  },
  async match(row, ctx) {
    const input = row.input as { campaignId: string; event: string | null; country: string | null; publisherId: string | null };
    const existing = await ctx.deps.prisma.campaignPayout.findFirst({
      where: { campaignId: input.campaignId, event: input.event, country: input.country, publisherId: input.publisherId },
      select: { id: true, name: true },
    });
    if (existing) return { match: 'existing', matchedId: existing.id, matchedLabel: existing.name, decision: 'skip' };
    return { match: 'new', decision: 'create' };
  },
  async create(input, ctx) {
    const { campaignId, ...tier } = input as { campaignId: string } & Record<string, unknown>;
    const created = await new CampaignPartnersService(ctx.deps).addPayout(ctx.auth, campaignId, tier as never, ctx.meta);
    return (created as { id: string }).id;
  },
  async undo(entityId, ctx) {
    const tier = await ctx.deps.prisma.campaignPayout.findUniqueOrThrow({ where: { id: entityId }, select: { campaignId: true } });
    await new CampaignPartnersService(ctx.deps).removePayout(ctx.auth, tier.campaignId, entityId, ctx.meta);
    return 'deleted';
  },
};

const approvalHandler: EntityHandler = {
  refType: null,
  async build(values, ctx) {
    const errors: string[] = [];
    const campaignRef = clean(values.campaignExternalId);
    const publisherRef = clean(values.publisherExternalId);
    const campaignId = await ctx.resolve('campaign', campaignRef);
    const publisherId = await ctx.resolve('publisher', publisherRef);
    if (!campaignId) errors.push(`Campaign ${campaignRef || '(blank)'} has not been imported or linked yet.`);
    if (!publisherId) errors.push(`Publisher ${publisherRef || '(blank)'} has not been imported or linked yet.`);
    const parsed = AssignPublisherBody.safeParse({ publisherId: publisherId ?? '00000000-0000-4000-8000-000000000000', status: mapAccessStatus(clean(values.status)), note: 'Imported from Trackier' });
    if (!parsed.success) errors.push(...issues(parsed.error));
    return { externalId: `${campaignRef}:${publisherRef}`, input: errors.length ? null : { ...(parsed.data as Record<string, unknown>), campaignId }, errors, warnings: [] };
  },
  async match(row, ctx) {
    const input = row.input as { campaignId: string; publisherId: string };
    const existing = await ctx.deps.prisma.campaignPublisher.findUnique({ where: { campaignId_publisherId: { campaignId: input.campaignId, publisherId: input.publisherId } } });
    if (existing) return { match: 'existing', matchedId: existing.id, matchedLabel: `already ${existing.status}`, decision: 'skip' };
    return { match: 'new', decision: 'create' };
  },
  async create(input, ctx) {
    const { campaignId, ...assignment } = input as { campaignId: string } & Record<string, unknown>;
    const created = await new CampaignPartnersService(ctx.deps).assign(ctx.auth, campaignId, assignment as never, ctx.meta);
    return (created as { id: string }).id;
  },
  async undo(entityId, ctx) {
    const access = await ctx.deps.prisma.campaignPublisher.findUniqueOrThrow({ where: { id: entityId } });
    await ctx.deps.prisma.campaignPublisher.delete({ where: { id: entityId } });
    await ctx.deps.publisher.publishLinksWhere({ campaignId: access.campaignId, publisherId: access.publisherId });
    return 'deleted';
  },
};

export const HANDLERS: Record<ImportEntity, EntityHandler> = {
  advertisers: partnerHandler('advertiser'),
  publishers: partnerHandler('publisher'),
  campaigns: campaignHandler,
  payouts: payoutHandler,
  approvals: approvalHandler,
};
