import { generateLinkSlug, generatePublicId, generateSecretToken } from '@ntrack/shared';
import type { PrismaClient } from '@ntrack/db';

/**
 * Local preview data. Every record is prefixed "DEMO" so it can never be mistaken for real
 * operations data, and no metrics are fabricated: run scripts/demo-traffic.mjs to send real
 * requests through the tracker if you want clicks on the dashboard.
 *
 * Refuses to run in production.
 */
export const seedDemoData = async (prisma: PrismaClient, organizationId: string) => {
  if (process.env.NODE_ENV === 'production') throw new Error('Demo data cannot be seeded in production');
  if (await prisma.advertiser.findFirst({ where: { organizationId, companyName: 'DEMO Travel Co' } })) {
    console.log('Demo data already present; skipping.');
    return;
  }

  const domain =
    (await prisma.trackingDomain.findUnique({ where: { hostname: 'trk.localhost' } })) ??
    (await prisma.trackingDomain.create({
      data: {
        publicId: generatePublicId('dom'),
        organizationId,
        hostname: 'trk.localhost',
        purpose: 'affiliate',
        status: 'active',
        isDefault: true,
        verifiedAt: new Date(),
        verificationToken: generateSecretToken(18),
      },
    }));

  const [travel, fintech] = await Promise.all(
    [
      { companyName: 'DEMO Travel Co', email: 'partners@demo-travel.example', website: 'https://demo-travel.example', country: 'US' },
      { companyName: 'DEMO Fintech', email: 'affiliates@demo-fintech.example', website: 'https://demo-fintech.example', country: 'IN' },
    ].map((data) => prisma.advertiser.create({ data: { ...data, publicId: generatePublicId('adv'), organizationId, status: 'active' } }))
  );

  const publishers = await Promise.all(
    [
      { companyName: 'DEMO Coupon Hub', email: 'team@demo-coupons.example', trafficSources: ['coupon', 'search'] },
      { companyName: 'DEMO Travel Blog', email: 'hello@demo-travelblog.example', trafficSources: ['content', 'social'] },
      { companyName: 'DEMO Cashback App', email: 'ops@demo-cashback.example', trafficSources: ['cashback'] },
    ].map((data) => prisma.publisher.create({ data: { ...data, publicId: generatePublicId('pub'), organizationId, status: 'active' } }))
  );

  const campaigns = [
    { advertiserId: travel!.id, name: 'DEMO Hotel Deals', category: 'Hotels', url: 'https://demo-travel.example/hotels?aff={click_id}&s1={subid1}', payout: '6.00', revenue: '9.00', model: 'CPA' as const },
    { advertiserId: travel!.id, name: 'DEMO Flight Search', category: 'Flights', url: 'https://demo-travel.example/flights?aff={click_id}', payout: '0.35', revenue: '0.50', model: 'CPC' as const },
    { advertiserId: fintech!.id, name: 'DEMO Credit Card Leads', category: 'Finance', url: 'https://demo-fintech.example/apply?ref={click_id}', payout: '18.00', revenue: '25.00', model: 'CPL' as const },
  ];

  for (const input of campaigns) {
    const campaign = await prisma.campaign.create({
      data: {
        publicId: generatePublicId('cmp'),
        organizationId,
        advertiserId: input.advertiserId,
        name: input.name,
        description: 'DEMO DATA: sample campaign for local previews.',
        category: input.category,
        status: 'active',
        visibility: 'approval_required',
        payoutModel: input.model,
        revenueModel: input.model,
        defaultPayout: input.payout,
        defaultRevenue: input.revenue,
        landingPages: { create: [{ publicId: generatePublicId('lp'), organizationId, name: 'Main', url: input.url, isDefault: true }] },
      },
    });
    for (const publisher of publishers) {
      await prisma.campaignPublisher.create({ data: { organizationId, campaignId: campaign.id, publisherId: publisher.id, status: 'approved', decidedAt: new Date() } });
      await prisma.trackingLink.create({
        data: {
          publicId: generatePublicId('lnk'),
          slug: generateLinkSlug(),
          organizationId,
          campaignId: campaign.id,
          publisherId: publisher.id,
          domainId: domain.id,
          name: `DEMO ${publisher.companyName.replace('DEMO ', '')} link`,
          source: publisher.trafficSources[0] ?? '',
        },
      });
    }
  }
  console.log('Seeded DEMO advertisers, publishers, campaigns and links. Restart the workers (or wait 5 minutes) to sync tracker config.');
};
