/**
 * Integration tests for tenant isolation, data-level scopes and request security. They run the
 * real Express app against real PostgreSQL/Redis (see vitest.integration.config.ts) and create
 * their own throwaway organizations, so they can run against a development database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { REDIS_KEYS, generateClickId, generateSecretToken, type ClickContext } from '@ntrack/shared'
import { createApp } from '../../src/app'
import { loadApiConfig } from '../../src/config/env'
import { closeDeps, createDeps } from '../../src/deps'
import { hashPassword } from '../../src/lib/password'
import { provisionOrganization, syncPermissionCatalogue } from '../../src/services/provisioning'
import type { AppDeps } from '../../src/types'

const run = generateSecretToken(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')
const PASSWORD = 'IntegrationPass123'

let deps: AppDeps
let app: Express
const orgIds: string[] = []
const userIds: string[] = []

/**
 * A signed-in client with its own cookie jar and CSRF token. Sessions are reused per user so the
 * suite stays under the real login rate limit (10 per IP and email per 15 minutes).
 */
const sessions = new Map<string, ReturnType<typeof createSession>>()
const signIn = (email: string) => {
  if (!sessions.has(email)) sessions.set(email, createSession(email))
  return sessions.get(email)!
}

const createSession = async (email: string) => {
  const agent = request.agent(app)
  const csrf = await agent.get('/v1/auth/csrf')
  let token = csrf.body.data.csrfToken as string
  const login = await agent.post('/v1/auth/login').set('x-csrf-token', token).send({ email, password: PASSWORD })
  expect(login.status).toBe(200)
  token = /ntrack_csrf=([^;]+)/.exec((login.headers['set-cookie'] as unknown as string[]).join(';'))?.[1] ?? token
  return {
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object) => agent.post(url).set('x-csrf-token', token).send(body),
    patch: (url: string, body?: object) => agent.patch(url).set('x-csrf-token', token).send(body),
    put: (url: string, body?: object) => agent.put(url).set('x-csrf-token', token).send(body),
    rawPost: (url: string, body?: object) => agent.post(url).send(body),
  }
}

const createUser = async (organizationId: string, roleSlug: string, email: string, link: { advertiserId?: string; publisherId?: string } = {}) => {
  const role = await deps.prisma.role.findUniqueOrThrow({ where: { organizationId_slug: { organizationId, slug: roleSlug } } })
  const user = await deps.prisma.user.create({ data: { email, name: email, passwordHash: await hashPassword(PASSWORD) } })
  userIds.push(user.id)
  await deps.prisma.organizationMember.create({ data: { organizationId, userId: user.id, roleId: role.id, ...link } })
  return user
}

let orgA: string
let orgB: string
let campaignA: string
let advertiserA: string
let publisherA1: string
let publisherA2: string

beforeAll(async () => {
  deps = createDeps(loadApiConfig({ ...process.env, NODE_ENV: 'test' }))
  app = createApp(deps)
  // Every run comes from 127.0.0.1, so clear the account-link limiter counters left by earlier runs
  // (the limits themselves stay in force within this run).
  for (const prefix of ['acctoken', 'pwreset']) {
    const keys = await deps.redis.keys(`ntrack:rl:${prefix}:*`)
    if (keys.length) await deps.redis.del(...keys)
  }
  await syncPermissionCatalogue(deps.prisma)
  orgA = (await provisionOrganization(deps.prisma, { name: `Org A ${run}`, slug: `it-a-${run}` })).id
  orgB = (await provisionOrganization(deps.prisma, { name: `Org B ${run}`, slug: `it-b-${run}` })).id
  orgIds.push(orgA, orgB)

  await createUser(orgA, 'network_admin', `admin-a-${run}@it.test`)
  await createUser(orgB, 'network_admin', `admin-b-${run}@it.test`)

  const adminA = await signIn(`admin-a-${run}@it.test`)
  advertiserA = (await adminA.post('/v1/advertisers', { companyName: 'IT Advertiser A', email: 'a@it.test' })).body.data.id
  publisherA1 = (await adminA.post('/v1/publishers', { companyName: 'IT Publisher A1', email: 'p1@it.test', status: 'active' })).body.data.id
  publisherA2 = (await adminA.post('/v1/publishers', { companyName: 'IT Publisher A2', email: 'p2@it.test', status: 'active' })).body.data.id
  const campaign = await adminA.post('/v1/campaigns', {
    name: 'IT Campaign A',
    advertiserId: advertiserA,
    category: 'Ecommerce',
    status: 'active',
    defaultPayout: '4.00',
    defaultRevenue: '6.00',
    landingPages: [{ name: 'Main', url: 'https://brand.example.com/?c={click_id}', isDefault: true }],
  })
  expect(campaign.status).toBe(201)
  campaignA = campaign.body.data.id
  await adminA.post(`/v1/campaigns/${campaignA}/publishers`, { publisherId: publisherA1, status: 'approved' })

  await createUser(orgA, 'publisher', `pub-a1-${run}@it.test`, { publisherId: publisherA1 })
  await createUser(orgA, 'publisher', `pub-a2-${run}@it.test`, { publisherId: publisherA2 })
  await createUser(orgA, 'advertiser', `adv-a-${run}@it.test`, { advertiserId: advertiserA })
  await createUser(orgA, 'analyst', `analyst-a-${run}@it.test`)
}, 60_000)

afterAll(async () => {
  await deps.prisma.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } })
  await deps.prisma.dataRequest.deleteMany({ where: { organizationId: { in: orgIds } } })
  await deps.prisma.apiKey.deleteMany({ where: { organizationId: { in: orgIds } } })
  await deps.prisma.externalRef.deleteMany({ where: { organizationId: { in: orgIds } } })
  await deps.prisma.importBatch.deleteMany({ where: { organizationId: { in: orgIds } } })
  // Journal entries are append-only (onDelete: Restrict), so test cleanup removes them explicitly.
  await deps.prisma.ledgerEntry.deleteMany({ where: { journal: { organizationId: { in: orgIds } } } })
  await deps.prisma.ledgerJournal.deleteMany({ where: { organizationId: { in: orgIds } } })
  await deps.prisma.conversion.deleteMany({ where: { organizationId: { in: orgIds } } })
  await deps.prisma.searchFeed.deleteMany({ where: { organizationId: { in: orgIds } } })
  await deps.prisma.campaign.deleteMany({ where: { organizationId: { in: orgIds } } })
  await deps.prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
  await deps.prisma.notificationPreference.deleteMany({ where: { userId: { in: userIds } } })
  await deps.prisma.user.deleteMany({ where: { email: { endsWith: `-${run}@it.test` } } })
  await deps.prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await deps.prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await closeDeps(deps)
})

describe('tenant isolation', () => {
  it('hides another organization\'s campaigns, advertisers and publishers', async () => {
    const adminB = await signIn(`admin-b-${run}@it.test`)
    expect((await adminB.get(`/v1/campaigns/${campaignA}`)).status).toBe(404)
    expect((await adminB.get(`/v1/advertisers/${advertiserA}`)).status).toBe(404)
    expect((await adminB.get(`/v1/publishers/${publisherA1}`)).status).toBe(404)
    const list = await adminB.get('/v1/campaigns')
    expect(list.body.data.items.map((c: { id: string }) => c.id)).not.toContain(campaignA)
  })

  it('saves the conversion tracking method, accepts mobile tokens and returns matching code for the campaign page', async () => {
    const adminA = await signIn(`admin-a-${run}@it.test`)
    const created = await adminA.post('/v1/campaigns', {
      name: 'IT App Campaign',
      advertiserId: advertiserA,
      category: 'Travel',
      conversionTracking: 'iframe_pixel',
      landingPages: [{ name: 'App', url: 'https://brand.example.com/app?c={click_id}&g={gaid}&i={idfa}&a={app_name}', isDefault: true }],
    })
    expect(created.status).toBe(201)
    expect(created.body.data.conversionTracking).toBe('iframe_pixel')
    const setup = await adminA.get(`/v1/campaigns/${created.body.data.id}/tracking-setup`)
    expect(setup.status).toBe(200)
    expect(setup.body.data.method).toBe('iframe_pixel')
    expect(Object.keys(setup.body.data.snippets).sort()).toEqual(['iframe_pixel', 'image_pixel', 'js_tag', 'server_postback'])
    if (setup.body.data.domain) expect(setup.body.data.snippets.iframe_pixel).toContain('<iframe')
    const macros = await adminA.get('/v1/campaigns/macros')
    expect(macros.body.data.map((m: { name: string }) => m.name)).toEqual(expect.arrayContaining(['click_id', 'gaid', 'idfa', 'app_name']))
    expect((await adminA.patch(`/v1/campaigns/${created.body.data.id}`, { conversionTracking: 'fax' })).status).toBe(400)
    // Clean up: nothing references this campaign.
    await deps.prisma.landingPage.deleteMany({ where: { campaignId: created.body.data.id } })
    await deps.prisma.campaign.delete({ where: { id: created.body.data.id } }).catch(() => undefined)
  })

  it('keeps the advertiser postback token out of reach of view-only roles', async () => {
    const analyst = `analyst-setup-${run}@it.test`
    await createUser(orgA, 'analyst', analyst)
    const session = await signIn(analyst)
    const admin = await signIn(`admin-a-${run}@it.test`)
    let realToken = (await admin.get(`/v1/advertisers/${advertiserA}/tracking-setup`)).body.data.token
    if (!realToken) realToken = (await admin.post(`/v1/advertisers/${advertiserA}/postback-token`, {})).body.data.token
    const viaCampaign = await session.get(`/v1/campaigns/${campaignA}/tracking-setup`)
    expect(viaCampaign.status).toBe(200)
    expect(viaCampaign.body.data.tokenVisible).toBe(false)
    expect(realToken).toBeTruthy()
    expect(JSON.stringify(viaCampaign.body.data)).not.toContain(realToken)
    const viaAdvertiser = await session.get(`/v1/advertisers/${advertiserA}/tracking-setup`)
    if (viaAdvertiser.status === 200) expect(JSON.stringify(viaAdvertiser.body.data)).not.toContain(realToken)
  })

  it('numbers advertisers, publishers and campaigns 1, 2, 3 per organization and uses the numbers in links', async () => {
    const adminA = await signIn(`admin-a-${run}@it.test`)
    const adminB = await signIn(`admin-b-${run}@it.test`)
    const advA = await deps.prisma.advertiser.findUniqueOrThrow({ where: { id: advertiserA } })
    const pub1 = await deps.prisma.publisher.findUniqueOrThrow({ where: { id: publisherA1 } })
    const pub2 = await deps.prisma.publisher.findUniqueOrThrow({ where: { id: publisherA2 } })
    const campA = await deps.prisma.campaign.findUniqueOrThrow({ where: { id: campaignA } })
    expect(advA.number).toBe(1)
    expect([pub1.number, pub2.number]).toEqual([1, 2])
    expect(campA.number).toBe(1)
    // Another organization starts its own sequence.
    const advB = await adminB.post('/v1/advertisers', { companyName: `IT Advertiser B ${run}`, email: 'b-serial@it.test' })
    expect(advB.status).toBe(201)
    expect(advB.body.data.number).toBe(1)
    // A duplicated campaign takes the next number, never the source's.
    const copy = await adminA.post(`/v1/campaigns/${campaignA}/duplicate`, {})
    expect(copy.status).toBe(201)
    expect(copy.body.data.number).toBeGreaterThan(campA.number)
    // Links show the numbers: /click?campaign_id=1&pub_id=1
    const domain = await deps.prisma.trackingDomain.create({
      data: { publicId: `dom_it${run}`.slice(0, 20), organizationId: orgA, hostname: `trk-${run}.it.test`, status: 'active', verificationToken: 'x', verifiedAt: new Date() },
    })
    const link = await adminA.post('/v1/links', { campaignId: campaignA, publisherId: publisherA1, domainId: domain.id, sub1: 'fb' })
    expect(link.status).toBe(201)
    expect(link.body.data.trackingUrl).toBe(`https://trk-${run}.it.test/click?campaign_id=1&pub_id=1&sub1=fb`)
    expect(link.body.data.shortUrl).toMatch(new RegExp(`^https://trk-${run}\\.it\\.test/click/[0-9A-Za-z]{10}$`))
    await deps.prisma.trackingLink.deleteMany({ where: { domainId: domain.id } })
    await deps.prisma.trackingDomain.delete({ where: { id: domain.id } })
    await deps.prisma.landingPage.deleteMany({ where: { campaignId: copy.body.data.id } })
    await deps.prisma.campaign.delete({ where: { id: copy.body.data.id } }).catch(() => undefined)
    await deps.prisma.advertiser.delete({ where: { id: advB.body.data.id } }).catch(() => undefined)
  })

  it('refuses to switch into an organization the user does not belong to', async () => {
    const adminB = await signIn(`admin-b-${run}@it.test`)
    expect((await adminB.post('/v1/auth/switch-organization', { organizationId: orgA })).status).toBe(404)
  })

  it('cannot attach another tenant\'s advertiser to a campaign', async () => {
    const adminB = await signIn(`admin-b-${run}@it.test`)
    const response = await adminB.post('/v1/campaigns', {
      name: 'Cross-tenant attempt',
      advertiserId: advertiserA,
      category: 'Other',
      landingPages: [{ name: 'x', url: 'https://x.example.com/', isDefault: true }],
    })
    expect(response.status).toBe(400)
  })
})

describe('portal data scopes', () => {
  it('shows an approved publisher the campaign but never the revenue rate', async () => {
    const publisher = await signIn(`pub-a1-${run}@it.test`)
    const campaign = await publisher.get(`/v1/campaigns/${campaignA}`)
    expect(campaign.status).toBe(200)
    expect(campaign.body.data.defaultPayout).toBe('4')
    expect(campaign.body.data.defaultRevenue).toBeUndefined()
  })

  it('hides the campaign from a publisher who is not approved on it', async () => {
    const publisher = await signIn(`pub-a2-${run}@it.test`)
    expect((await publisher.get(`/v1/campaigns/${campaignA}`)).status).toBe(404)
    expect((await publisher.get(`/v1/publishers/${publisherA1}`)).status).toBe(404)
  })

  it('never leaks other campaigns or links through search (regression: search OR overwrote scope)', async () => {
    const publisher = await signIn(`pub-a2-${run}@it.test`)
    const campaigns = await publisher.get('/v1/campaigns?search=IT%20Campaign')
    expect(campaigns.body.data.items).toHaveLength(0)
  })

  it('returns the publisher\'s own profile, and only that', async () => {
    const publisher = await signIn(`pub-a2-${run}@it.test`)
    const own = await publisher.get(`/v1/publishers/${publisherA2}`)
    expect(own.status).toBe(200)
    expect(own.body.data.id).toBe(publisherA2)
  })

  it('stops publishers from managing advertisers and approving themselves', async () => {
    const publisher = await signIn(`pub-a2-${run}@it.test`)
    expect((await publisher.get('/v1/advertisers')).status).toBe(403)
    expect((await publisher.post(`/v1/campaigns/${campaignA}/publishers`, { publisherId: publisherA2, status: 'approved' })).status).toBe(403)
  })

  it('shows an advertiser user the revenue they pay but not publisher payouts', async () => {
    const advertiser = await signIn(`adv-a-${run}@it.test`)
    const campaign = await advertiser.get(`/v1/campaigns/${campaignA}`)
    expect(campaign.status).toBe(200)
    expect(campaign.body.data.defaultPayout).toBeUndefined()
  })

  it('forces campaigns submitted by an advertiser to pending', async () => {
    const advertiser = await signIn(`adv-a-${run}@it.test`)
    const response = await advertiser.post('/v1/campaigns', {
      name: 'Advertiser submission',
      advertiserId: advertiserA,
      category: 'Other',
      status: 'active',
      landingPages: [{ name: 'x', url: 'https://brand.example.com/x', isDefault: true }],
    })
    expect(response.status).toBe(201)
    expect(response.body.data.status).toBe('pending')
  })
})

describe('request security', () => {
  it('rejects state-changing requests without a CSRF token', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const response = await admin.rawPost('/v1/advertisers', { companyName: 'No CSRF', email: 'x@it.test' })
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('csrf')
  })

  it('rejects unauthenticated access', async () => {
    expect((await request(app).get('/v1/campaigns')).status).toBe(401)
  })

  it('prevents granting permissions the actor does not hold (privilege escalation)', async () => {
    const analyst = await signIn(`analyst-a-${run}@it.test`)
    const response = await analyst.post('/v1/roles', { name: 'Escalate', scope: 'organization', permissions: ['finance.approve'] })
    expect(response.status).toBe(403)
  })

  it('rejects landing pages with macros in the hostname', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const response = await admin.post(`/v1/campaigns/${campaignA}/landing-pages`, { name: 'bad', url: 'https://{subid1}.evil.example/' })
    expect(response.status).toBe(400)
  })

  it('records an audit entry for campaign changes', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    await admin.patch(`/v1/campaigns/${campaignA}`, { description: 'Updated by integration test' })
    const after = await admin.get(`/v1/campaigns/${campaignA}`)
    // Regression: partial updates used to reset defaulted fields (payouts became 0).
    expect(after.body.data.defaultPayout).toBe('4')
    expect(after.body.data.status).toBe('active')
    const logs = await admin.get(`/v1/audit-logs?entityType=campaign&entityId=${campaignA}`)
    expect(logs.body.data.items.some((entry: { action: string }) => entry.action === 'campaign.updated')).toBe(true)
  })
})

describe('conversions', () => {
  let conversionId: string

  beforeAll(async () => {
    const campaign = await deps.prisma.campaign.findUniqueOrThrow({ where: { id: campaignA } })
    const clickId = generateClickId()
    const context: ClickContext = {
      clickId,
      gaid: '',
      idfa: '',
      appName: '',
      ts: Date.now() - 60_000,
      organizationId: orgA,
      campaignId: campaignA,
      publisherId: publisherA1,
      advertiserId: campaign.advertiserId,
      linkId: '00000000-0000-4000-8000-000000000000',
      domainId: '00000000-0000-4000-8000-000000000000',
      sub1: 'it',
      sub2: '',
      sub3: '',
      sub4: '',
      sub5: '',
      source: '',
      country: 'US',
      deviceType: 'desktop',
      externalClickId: '',
      isValid: true,
      invalidReason: '',
      visitorId: 'it-visitor',
      referrerDomain: '',
    }
    await deps.redis.set(REDIS_KEYS.click(clickId), JSON.stringify(context), 'EX', 3600)
    const result = await deps.conversions.ingest({ source: 's2s', clickId, event: 'sale', transactionId: `IT-${run}`, saleAmount: '50.00', currency: 'USD', customParams: {}, receivedAt: Date.now() })
    expect(result.outcome).toBe('created')
    if (result.outcome === 'created') conversionId = result.conversion.id
    const duplicate = await deps.conversions.ingest({ source: 's2s', clickId, event: 'sale', transactionId: `IT-${run}`, saleAmount: '50.00', currency: 'USD', customParams: {}, receivedAt: Date.now() })
    expect(duplicate.outcome).toBe('duplicate')
  })

  it('uses the campaign default payout and revenue', async () => {
    const conversion = await deps.prisma.conversion.findUniqueOrThrow({ where: { id: conversionId } })
    expect(conversion.payout.toString()).toBe('4')
    expect(conversion.revenue.toString()).toBe('6')
    expect(conversion.status).toBe('pending')
  })

  it('shows the owning publisher their payout but not revenue', async () => {
    const publisher = await signIn(`pub-a1-${run}@it.test`)
    const response = await publisher.get(`/v1/conversions/${conversionId}`)
    expect(response.status).toBe(200)
    expect(response.body.data.payout).toBe('4')
    expect(response.body.data.revenue).toBeUndefined()
    expect(response.body.data.attributions).toBeUndefined()
  })

  it('hides the conversion from another publisher and another organization', async () => {
    const other = await signIn(`pub-a2-${run}@it.test`)
    expect((await other.get(`/v1/conversions/${conversionId}`)).status).toBe(404)
    const adminB = await signIn(`admin-b-${run}@it.test`)
    expect((await adminB.get(`/v1/conversions/${conversionId}`)).status).toBe(404)
  })

  it('stops publishers approving their own conversions', async () => {
    const publisher = await signIn(`pub-a1-${run}@it.test`)
    expect((await publisher.post(`/v1/conversions/${conversionId}/status`, { status: 'approved' })).status).toBe(403)
  })

  it('enforces status transitions and records history', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    expect((await admin.post(`/v1/conversions/${conversionId}/status`, { status: 'approved', note: 'ok' })).status).toBe(200)
    expect((await admin.post(`/v1/conversions/${conversionId}/status`, { status: 'reversed', note: 'chargeback' })).status).toBe(200)
    expect((await admin.post(`/v1/conversions/${conversionId}/status`, { status: 'approved' })).status).toBe(409)
    const detail = await admin.get(`/v1/conversions/${conversionId}`)
    expect(detail.body.data.events.map((e: { type: string }) => e.type)).toEqual(['created', 'duplicate_received', 'approved', 'reversed'])
  })

  it('rejects postback URLs that point at private networks when not allowed', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const response = await admin.post('/v1/postbacks', { name: 'ssrf', events: ['conversion.created'], urlTemplate: 'https://169.254.169.254/latest?c={click_id}' })
    expect(response.status).toBe(400)
  })
})

/** Notifications are fire-and-forget; poll briefly for the expected rows. */
const notificationsFor = async (email: string, type: string, expectAtLeast = 1) => {
  const user = await deps.prisma.user.findUniqueOrThrow({ where: { email } })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rows = await deps.prisma.notification.findMany({ where: { userId: user.id, type } })
    if (rows.length >= expectAtLeast) return rows
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return deps.prisma.notification.findMany({ where: { userId: user.id, type } })
}

describe('notifications', () => {
  it('sends application requests to staff and the campaign advertiser only, and decisions to the applicant only', async () => {
    const applicant = await signIn(`pub-a2-${run}@it.test`)
    expect((await applicant.post(`/v1/campaigns/${campaignA}/apply`, { note: 'Search traffic' })).status).toBe(201)

    expect(await notificationsFor(`admin-a-${run}@it.test`, 'application.submitted')).toHaveLength(1)
    expect(await notificationsFor(`adv-a-${run}@it.test`, 'application.submitted')).toHaveLength(1)
    expect(await notificationsFor(`pub-a1-${run}@it.test`, 'application.submitted', 0)).toHaveLength(0)
    expect(await notificationsFor(`admin-b-${run}@it.test`, 'application.submitted', 0)).toHaveLength(0)
    // The applicant is the actor and is not notified about their own action.
    expect(await notificationsFor(`pub-a2-${run}@it.test`, 'application.submitted', 0)).toHaveLength(0)

    const admin = await signIn(`admin-a-${run}@it.test`)
    const application = await deps.prisma.campaignPublisher.findFirstOrThrow({ where: { campaignId: campaignA, publisherId: publisherA2 } })
    expect((await admin.patch(`/v1/campaigns/applications/${application.id}`, { status: 'rejected', note: 'Not a fit' })).status).toBe(200)
    const decided = await notificationsFor(`pub-a2-${run}@it.test`, 'application.decided')
    expect(decided).toHaveLength(1)
    expect(decided[0]!.title).toContain('rejected')
    expect(await notificationsFor(`pub-a1-${run}@it.test`, 'application.decided', 0)).toHaveLength(0)
  })

  it('lists only the signed-in user\'s notifications and refuses to mark someone else\'s as read', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const list = await admin.get('/v1/notifications')
    expect(list.status).toBe(200)
    expect(list.body.data.unread).toBeGreaterThan(0)
    const adminUser = await deps.prisma.user.findUniqueOrThrow({ where: { email: `admin-a-${run}@it.test` } })
    expect(list.body.data.items.every((n: { userId: string }) => n.userId === adminUser.id)).toBe(true)

    const other = await signIn(`adv-a-${run}@it.test`)
    expect((await other.post(`/v1/notifications/${list.body.data.items[0].id}/read`)).status).toBe(404)
    expect((await admin.post(`/v1/notifications/${list.body.data.items[0].id}/read`)).status).toBe(200)
    expect((await admin.post('/v1/notifications/read-all')).body.data.unread).toBe(0)
  })

  it('offers publishers only the notification types they can receive', async () => {
    const publisher = await signIn(`pub-a1-${run}@it.test`)
    const prefs = await publisher.get('/v1/notifications/preferences')
    const types = prefs.body.data.items.map((i: { type: string }) => i.type)
    expect(types).toContain('payout.updated')
    expect(types).not.toContain('fraud.alert')
    expect(types).not.toContain('payout.requested')
    expect((await publisher.put('/v1/notifications/preferences', { items: [{ type: 'fraud.alert', inApp: true, email: true }] })).status).toBe(400)
    const saved = await publisher.put('/v1/notifications/preferences', { items: [{ type: 'payout.updated', inApp: true, email: false }] })
    expect(saved.status).toBe(200)
    expect(saved.body.data.items.find((i: { type: string }) => i.type === 'payout.updated').email).toBe(false)
  })
})

describe('scheduled reports', () => {
  it('needs reports.schedule and only accepts recipients who are members able to view reports', async () => {
    const publisher = await signIn(`pub-a1-${run}@it.test`)
    const body = { name: 'Daily perf', frequency: 'daily', hourLocal: 8, config: { preset: 'yesterday' }, recipients: [`pub-a1-${run}@it.test`] }
    expect((await publisher.post('/v1/scheduled-reports', body)).status).toBe(403)

    const admin = await signIn(`admin-a-${run}@it.test`)
    expect((await admin.post('/v1/scheduled-reports', { ...body, recipients: [`admin-b-${run}@it.test`] })).status).toBe(400)
    expect((await admin.post('/v1/scheduled-reports', { ...body, frequency: 'weekly', recipients: [`admin-a-${run}@it.test`] })).status).toBe(400)

    const created = await admin.post('/v1/scheduled-reports', { ...body, recipients: [`admin-a-${run}@it.test`, `analyst-a-${run}@it.test`] })
    expect(created.status).toBe(201)
    const ran = await admin.post(`/v1/scheduled-reports/${created.body.data.id}/run`)
    expect(ran.status).toBe(200)
    expect(ran.body.data.sent).toBe(2)
    // Another user (analysts may schedule their own reports) cannot see or run it.
    const analyst = await signIn(`analyst-a-${run}@it.test`)
    expect((await analyst.post(`/v1/scheduled-reports/${created.body.data.id}/run`)).status).toBe(404)
    expect((await analyst.get('/v1/scheduled-reports')).body.data).toHaveLength(0)
  })
})

describe('search monetization', () => {
  it('refuses to link a feed to another organization\'s campaign on update (regression)', async () => {
    const adminA = await signIn(`admin-a-${run}@it.test`)
    const adminB = await signIn(`admin-b-${run}@it.test`)
    const advertiserB = (await adminB.post('/v1/advertisers', { companyName: 'IT Advertiser B', email: 'b@it.test' })).body.data.id
    const campaignB = (
      await adminB.post('/v1/campaigns', {
        name: 'IT Campaign B',
        advertiserId: advertiserB,
        category: 'Ecommerce',
        landingPages: [{ name: 'Main', url: 'https://b.example.com/', isDefault: true }],
      })
    ).body.data.id
    const partner = (await adminA.post('/v1/search/partners', { name: 'IT Search Partner' })).body.data.id
    const feed = await adminA.post(`/v1/search/partners/${partner}/feeds`, { name: 'Feed 1', externalCode: 'f1' })
    expect(feed.status).toBe(201)
    expect((await adminA.patch(`/v1/search/feeds/${feed.body.data.id}`, { campaignId: campaignB })).status).toBe(400)
    expect((await adminA.patch(`/v1/search/feeds/${feed.body.data.id}`, { campaignId: campaignA })).status).toBe(200)
  })
})

describe('redirect response types', () => {
  const base = {
    advertiserId: '',
    category: 'Ecommerce',
    landingPages: [{ name: 'Main', url: 'https://brand.example.com/?c={click_id}', isDefault: true }],
  }

  it('rejects HTML 200 for transparent (Google Ads) campaigns on create', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const response = await admin.post('/v1/campaigns', {
      ...base,
      advertiserId: advertiserA,
      name: 'IT Transparent 200',
      redirectMode: 'transparent',
      allowedHosts: ['brand.example.com'],
      redirectResponse: 'html_200',
    })
    expect(response.status).toBe(400)
    expect(JSON.stringify(response.body)).toContain('302')
  })

  it('allows all four types on standard campaigns and blocks switching a 200 campaign to transparent', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const created = await admin.post('/v1/campaigns', { ...base, advertiserId: advertiserA, name: 'IT Standard 200', redirectResponse: 'html_200', referrerPolicy: 'no-referrer' })
    expect(created.status).toBe(201)
    const id = created.body.data.id
    expect(created.body.data.redirectResponse).toBe('html_200')

    // Partial update changing only the mode must still be checked against the stored response.
    const toTransparent = await admin.patch(`/v1/campaigns/${id}`, { redirectMode: 'transparent', allowedHosts: ['brand.example.com'] })
    expect(toTransparent.status).toBe(400)
    // Switching both together to 302 + transparent is fine.
    const ok = await admin.patch(`/v1/campaigns/${id}`, { redirectMode: 'transparent', allowedHosts: ['brand.example.com'], redirectResponse: 'redirect_302' })
    expect(ok.status).toBe(200)
    // And a transparent campaign cannot be switched to 200 on its own either.
    expect((await admin.patch(`/v1/campaigns/${id}`, { redirectResponse: 'html_200' })).status).toBe(400)
    // Back to standard with the organization default (null) is allowed.
    expect((await admin.patch(`/v1/campaigns/${id}`, { redirectMode: 'standard', redirectResponse: null })).status).toBe(200)
  })

  it('applies an HTML 200 organization default to standard campaigns only; transparent snapshots stay 302', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    expect((await admin.patch('/v1/organizations/current/settings', { redirectResponse: 'html_200' })).status).toBe(200)
    try {
      const transparent = await admin.post('/v1/campaigns', {
        ...base,
        advertiserId: advertiserA,
        name: 'IT Transparent default',
        redirectMode: 'transparent',
        allowedHosts: ['brand.example.com'],
      })
      expect(transparent.status).toBe(201)
      const standard = await admin.post('/v1/campaigns', { ...base, advertiserId: advertiserA, name: 'IT Standard default' })
      expect(standard.status).toBe(201)
      const snapshot = async (id: string) => JSON.parse((await deps.redis.get(REDIS_KEYS.campaign(id))) ?? '{}') as { redirectResponse?: string }
      expect((await snapshot(transparent.body.data.id)).redirectResponse).toBe('redirect_302')
      expect((await snapshot(standard.body.data.id)).redirectResponse).toBe('html_200')
    } finally {
      await admin.patch('/v1/organizations/current/settings', { redirectResponse: 'redirect_302' })
    }
  })

  it('reports the effective redirect type, including a hidden referrer inherited from the organization', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const created = await admin.post('/v1/campaigns', { ...base, advertiserId: advertiserA, name: 'IT Inherit referrer', redirectResponse: 'redirect_302' })
    expect(created.status).toBe(201)
    expect((await admin.patch('/v1/organizations/current/settings', { referrerPolicy: 'no-referrer' })).status).toBe(200)
    try {
      const detail = await admin.get(`/v1/campaigns/${created.body.data.id}`)
      expect(detail.body.data.effectiveRedirect).toMatchObject({ response: 'redirect_302', referrerPolicy: 'no-referrer', type: '302_hide_referrer', referrerPolicyFromDefault: true })
    } finally {
      await admin.patch('/v1/organizations/current/settings', { referrerPolicy: 'strict-origin-when-cross-origin' })
    }
  })

  it('rejects unknown redirect responses', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    expect((await admin.patch('/v1/organizations/current/settings', { redirectResponse: 'meta_refresh' })).status).toBe(400)
  })
})

/** Finds the link in the most recent queued account email to `email` (emails are queued, not sent, in tests). */
const linkFromEmail = async (email: string, path: string) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const jobs = await deps.emailQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, 200)
    const job = jobs.filter((j) => j?.data?.to === email && j.data.text.includes(path)).sort((a, b) => b.timestamp - a.timestamp)[0]
    const token = job ? new URL(/https?:\/\/\S+/.exec(job.data.text.slice(job.data.text.indexOf(path) - 200))![0]).searchParams.get('token') : null
    if (token) return token
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`no ${path} email for ${email}`)
}

describe('invitations', () => {
  const anonymous = async () => {
    const agent = request.agent(app)
    const token = (await agent.get('/v1/auth/csrf')).body.data.csrfToken as string
    return { post: (url: string, body?: object) => agent.post(url).set('x-csrf-token', token).send(body) }
  }

  it('invites a new person, who sets a password, accepts once and can then sign in', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const analystRole = await deps.prisma.role.findUniqueOrThrow({ where: { organizationId_slug: { organizationId: orgA, slug: 'analyst' } } })
    const email = `invitee-${run}@it.test`
    const invite = await admin.post('/v1/users/invitations', { email, name: 'New Analyst', roleId: analystRole.id })
    expect(invite.status).toBe(201)
    expect(invite.body.data.inviteUrl).toContain('/accept-invite?token=')
    expect(invite.body.data.invitation.tokenHash).toBeUndefined()
    const token = new URL(invite.body.data.inviteUrl).searchParams.get('token')!

    const pending = await admin.get('/v1/users/invitations')
    expect(pending.body.data.map((i: { email: string }) => i.email)).toContain(email)

    const visitor = await anonymous()
    const lookup = await visitor.post('/v1/auth/invitations/lookup', { token })
    expect(lookup.body.data).toMatchObject({ email, existingAccount: false, roleName: analystRole.name })
    expect((await visitor.post('/v1/auth/invitations/accept', { token, name: 'New Analyst', password: 'short' })).status).toBe(400)
    expect((await visitor.post('/v1/auth/invitations/accept', { token, name: 'New Analyst', password: 'InviteePass12345' })).status).toBe(200)
    // Single use.
    expect((await visitor.post('/v1/auth/invitations/accept', { token, name: 'Again', password: 'InviteePass12345' })).status).toBe(404)

    const user = await deps.prisma.user.findUniqueOrThrow({ where: { email } })
    userIds.push(user.id)
    const login = await (async () => {
      const agent = request.agent(app)
      const csrf = (await agent.get('/v1/auth/csrf')).body.data.csrfToken as string
      return agent.post('/v1/auth/login').set('x-csrf-token', csrf).send({ email, password: 'InviteePass12345' })
    })()
    expect(login.status).toBe(200)
    expect(await deps.prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: orgA, userId: user.id } } })).toMatchObject({ roleId: analystRole.id })
  })

  it('makes old links stop working after resend or revoke', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const role = await deps.prisma.role.findUniqueOrThrow({ where: { organizationId_slug: { organizationId: orgA, slug: 'read_only' } } })
    const first = await admin.post('/v1/users/invitations', { email: `resend-${run}@it.test`, roleId: role.id })
    const firstToken = new URL(first.body.data.inviteUrl).searchParams.get('token')!
    const resent = await admin.post(`/v1/users/invitations/${first.body.data.invitation.id}/resend`)
    expect(resent.status).toBe(200)
    const visitor = await anonymous()
    expect((await visitor.post('/v1/auth/invitations/lookup', { token: firstToken })).status).toBe(404)
    const newToken = new URL(resent.body.data.inviteUrl).searchParams.get('token')!
    expect((await visitor.post('/v1/auth/invitations/lookup', { token: newToken })).status).toBe(200)
    expect((await admin.post(`/v1/users/invitations/${first.body.data.invitation.id}/revoke`)).status).toBe(200)
    expect((await visitor.post('/v1/auth/invitations/lookup', { token: newToken })).status).toBe(404)
    // Revoking keeps the record for the audit trail.
    expect(await deps.prisma.invitation.findUnique({ where: { id: first.body.data.invitation.id } })).toMatchObject({ revokedAt: expect.any(Date) })
  })

  it('asks existing NTrack users for their current password and refuses to re-invite members', async () => {
    const adminA = await signIn(`admin-a-${run}@it.test`)
    const role = await deps.prisma.role.findUniqueOrThrow({ where: { organizationId_slug: { organizationId: orgA, slug: 'read_only' } } })
    expect((await adminA.post('/v1/users/invitations', { email: `analyst-a-${run}@it.test`, roleId: role.id })).status).toBe(409)

    const invite = await adminA.post('/v1/users/invitations', { email: `admin-b-${run}@it.test`, roleId: role.id })
    const token = new URL(invite.body.data.inviteUrl).searchParams.get('token')!
    const visitor = await anonymous()
    expect((await visitor.post('/v1/auth/invitations/lookup', { token })).body.data.existingAccount).toBe(true)
    expect((await visitor.post('/v1/auth/invitations/accept', { token, name: 'B', password: 'WrongPassword123' })).status).toBe(400)
    expect((await visitor.post('/v1/auth/invitations/accept', { token, name: 'B', password: PASSWORD })).status).toBe(200)
    const userB = await deps.prisma.user.findUniqueOrThrow({ where: { email: `admin-b-${run}@it.test` } })
    expect(await deps.prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: orgA, userId: userB.id } } })).not.toBeNull()
  })

  it('stops restricted user managers from inviting users for partners they do not manage (regression)', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    // The manager must hold every permission of the role it grants (no escalation), plus users.manage.
    const publisherPermissions = (
      await deps.prisma.rolePermission.findMany({ where: { role: { organizationId: orgA, slug: 'publisher' } }, select: { permissionKey: true } })
    ).map((p) => p.permissionKey)
    const managerRole = await admin.post('/v1/roles', { name: `IT Partner Manager ${run}`, scope: 'managed', permissions: [...new Set([...publisherPermissions, 'users.view', 'users.manage'])] })
    expect(managerRole.status).toBe(201)
    const manager = await createUser(orgA, managerRole.body.data.slug, `manager-${run}@it.test`)
    await deps.prisma.managerAssignment.create({ data: { organizationId: orgA, userId: manager.id, publisherId: publisherA1 } })
    const publisherRole = await deps.prisma.role.findUniqueOrThrow({ where: { organizationId_slug: { organizationId: orgA, slug: 'publisher' } } })
    const managerClient = await signIn(`manager-${run}@it.test`)
    expect((await managerClient.post('/v1/users/invitations', { email: `p2-user-${run}@it.test`, roleId: publisherRole.id, publisherId: publisherA2 })).status).toBe(403)
    expect((await managerClient.post('/v1/users/invitations', { email: `p1-user-${run}@it.test`, roleId: publisherRole.id, publisherId: publisherA1 })).status).toBe(201)
  })
})

describe('password reset', () => {
  const anonymous = async () => {
    const agent = request.agent(app)
    const token = (await agent.get('/v1/auth/csrf')).body.data.csrfToken as string
    return { post: (url: string, body?: object) => agent.post(url).set('x-csrf-token', token).send(body) }
  }

  it('answers the same for unknown and known emails, and resets with a single-use link', async () => {
    const email = `reset-${run}@it.test`
    const user = await createUser(orgA, 'read_only', email)
    const visitor = await anonymous()
    const unknown = await visitor.post('/v1/auth/password/forgot', { email: `nobody-${run}@it.test` })
    const known = await visitor.post('/v1/auth/password/forgot', { email })
    expect(unknown.status).toBe(200)
    expect(known.status).toBe(200)
    expect(unknown.body.message).toBe(known.body.message)

    // An existing session must be signed out by the reset.
    const session = await signIn(email)
    expect((await session.get('/v1/auth/me')).status).toBe(200)

    const token = await linkFromEmail(email, '/reset-password')
    expect((await visitor.post('/v1/auth/password/reset', { token, password: 'weak' })).status).toBe(400)
    expect((await visitor.post('/v1/auth/password/reset', { token, password: 'BrandNewPass12345' })).status).toBe(200)
    expect((await visitor.post('/v1/auth/password/reset', { token, password: 'AnotherPass12345' })).status).toBe(400)
    expect((await session.get('/v1/auth/me')).status).toBe(401)
    const fresh = request.agent(app)
    const csrf = (await fresh.get('/v1/auth/csrf')).body.data.csrfToken as string
    expect((await fresh.post('/v1/auth/login').set('x-csrf-token', csrf).send({ email, password: PASSWORD })).status).toBe(401)
    expect((await fresh.post('/v1/auth/login').set('x-csrf-token', csrf).send({ email, password: 'BrandNewPass12345' })).status).toBe(200)
    expect(user.id).toBeTruthy()
  })
})

describe('privacy requests', () => {
  const runNow = async (id: string) => {
    const { PrivacyService } = await import('../../src/modules/privacy/privacy.service')
    await new PrivacyService(deps, deps.files, async () => undefined).process(id)
    return deps.prisma.dataRequest.findUniqueOrThrow({ where: { id } })
  }
  const zipFiles = async (agentGet: (url: string) => request.Test, url: string) => {
    const response = await agentGet(url).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => done(null, Buffer.concat(chunks)))
    })
    if (response.status !== 200) return { status: response.status, files: {} as Record<string, string> }
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(response.body as Buffer)
    const files: Record<string, string> = {}
    for (const name of Object.keys(zip.files)) files[name] = await zip.files[name]!.async('string')
    return { status: 200, files }
  }

  it('exports a publisher with its own data only, never advertiser revenue', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const created = await admin.post('/v1/privacy/requests', { type: 'export', subjectType: 'publisher', subjectId: publisherA1, reason: 'DSAR-1 test' })
    expect(created.status).toBe(201)
    expect(created.body.data.status).toBe('approved')
    expect((await runNow(created.body.data.id)).status).toBe('completed')
    const download = await zipFiles(admin.get, `/v1/privacy/requests/${created.body.data.id}/download`)
    expect(download.status).toBe(200)
    expect(Object.keys(download.files)).toEqual(expect.arrayContaining(['README.txt', 'profile.json', 'conversions.csv', 'tracking-links.json']))
    expect(JSON.parse(download.files['profile.json']!).companyName).toBe('IT Publisher A1')
    expect(download.files['conversions.csv']!.split('\n')[0]).not.toContain('revenue')
    expect(JSON.stringify(download.files)).not.toMatch(/tokenHash|passwordHash/)
  })

  it('keeps self-service exports private to the person they describe', async () => {
    const analystEmail = `analyst-a-${run}@it.test`
    const analyst = await signIn(analystEmail)
    const mine = await analyst.post('/v1/privacy/me/export')
    expect(mine.status).toBe(201)
    expect((await runNow(mine.body.data.id)).status).toBe('completed')
    const own = await zipFiles(analyst.get, `/v1/privacy/requests/${mine.body.data.id}/download`)
    expect(own.status).toBe(200)
    expect(JSON.parse(own.files['profile.json']!).email).toBe(analystEmail)

    const admin = await signIn(`admin-a-${run}@it.test`)
    const listed = await admin.get('/v1/privacy/requests')
    expect(listed.body.data.items.map((i: { id: string }) => i.id)).not.toContain(mine.body.data.id)
    expect((await admin.get(`/v1/privacy/requests/${mine.body.data.id}/download`)).status).toBe(404)
    // Analysts cannot manage other people's requests.
    expect((await analyst.get('/v1/privacy/requests')).status).toBe(403)
  })

  it('erases a publisher only after a second person approves, keeping financial records', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const publisher = (await admin.post('/v1/publishers', { companyName: 'IT Erase Me', email: 'erase@it.test', contactName: 'Pat Person', phone: '+1 555 0100', status: 'active' })).body.data
    const requested = await admin.post('/v1/privacy/requests', { type: 'erasure', subjectType: 'publisher', subjectId: publisher.id, reason: 'DSAR-2 test' })
    expect(requested.body.data.status).toBe('pending_review')
    expect((await admin.post(`/v1/privacy/requests/${requested.body.data.id}/approve`, { note: 'self approve' })).status).toBe(403)

    await createUser(orgA, 'network_admin', `admin-a2-${run}@it.test`)
    const second = await signIn(`admin-a2-${run}@it.test`)
    expect((await second.post(`/v1/privacy/requests/${requested.body.data.id}/approve`, { note: 'verified identity' })).status).toBe(200)
    const done = await runNow(requested.body.data.id)
    expect(done.status).toBe('completed')
    const erased = await deps.prisma.publisher.findUniqueOrThrow({ where: { id: publisher.id } })
    expect(erased).toMatchObject({ companyName: `Erased publisher ${publisher.publicId}`, email: '', contactName: '', phone: '', status: 'suspended', taxInfoEncrypted: null })
    expect((done.summary as { kept: string[] }).kept).toEqual(expect.arrayContaining(['conversions', 'invoices (with their billing snapshot)']))
  })

  it('erases a user account: anonymised, signed out, email scrubbed from the audit trail', async () => {
    const email = `erase-user-${run}@it.test`
    const user = await createUser(orgA, 'read_only', email)
    const session = await signIn(email)
    expect((await session.get('/v1/auth/me')).status).toBe(200)
    const admin = await signIn(`admin-a-${run}@it.test`)
    const requested = await admin.post('/v1/privacy/requests', { type: 'erasure', subjectType: 'user', subjectId: user.id, reason: 'DSAR-3 test' })
    expect(requested.status).toBe(201)
    const second = await signIn(`admin-a2-${run}@it.test`)
    expect((await second.post(`/v1/privacy/requests/${requested.body.data.id}/approve`, {})).status).toBe(200)
    expect((await runNow(requested.body.data.id)).status).toBe('completed')

    const after = await deps.prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after).toMatchObject({ email: `erased-${user.id}@erased.invalid`, name: 'Erased user', passwordHash: null, status: 'disabled' })
    expect((await session.get('/v1/auth/me')).status).toBe(401)
    expect(await deps.prisma.auditLog.count({ where: { OR: [{ summary: { contains: email } }, { actorEmail: email }] } })).toBe(0)
    // The membership record is kept (disabled), not deleted.
    expect(await deps.prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: orgA, userId: user.id } } })).toMatchObject({ status: 'disabled' })
  })

  it('refuses organization erasure and duplicate open requests', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    expect((await admin.post('/v1/privacy/requests', { type: 'erasure', subjectType: 'organization', subjectId: orgA, reason: 'not supported' })).status).toBe(400)
    const first = await admin.post('/v1/privacy/requests', { type: 'erasure', subjectType: 'advertiser', subjectId: advertiserA, reason: 'DSAR-4 test' })
    expect(first.status).toBe(201)
    expect((await admin.post('/v1/privacy/requests', { type: 'erasure', subjectType: 'advertiser', subjectId: advertiserA, reason: 'again' })).status).toBe(409)
    expect((await admin.post(`/v1/privacy/requests/${first.body.data.id}/reject`, { note: 'test only' })).status).toBe(200)
  })
})

describe('invoice billing snapshot', () => {
  it('keeps the billing details an invoice was issued with after the advertiser changes or is erased', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const advertiser = (await admin.post('/v1/advertisers', { companyName: 'IT Snapshot Co', email: 'billing@snapshot.it.test', address: '1 Original Street', country: 'US' })).body.data
    const invoice = await deps.prisma.invoice.create({
      data: {
        publicId: `inv_it${run}`,
        organizationId: orgA,
        advertiserId: advertiser.id,
        type: 'invoice',
        number: `INV-IT-${run}`,
        status: 'draft',
        currency: 'USD',
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
        subtotal: '100.00',
        taxRate: '0',
        taxAmount: '0',
        total: '100.00',
      },
    })
    expect((await admin.post(`/v1/finance/invoices/${invoice.id}/issue`)).status).toBe(200)
    await admin.patch(`/v1/advertisers/${advertiser.id}`, { companyName: 'Renamed Co', address: '2 New Road' })
    const issued = await admin.get(`/v1/finance/invoices/${invoice.id}`)
    expect(issued.body.data.advertiser).toMatchObject({ companyName: 'IT Snapshot Co', address: '1 Original Street' })
  })
})

describe('API keys', () => {
  const bearer = (secret: string) => ({
    get: (url: string) => request(app).get(url).set('authorization', `Bearer ${secret}`),
    post: (url: string, body?: object) => request(app).post(url).set('authorization', `Bearer ${secret}`).send(body),
  })

  it('acts within the permissions chosen for the key, without CSRF, and never reaches account areas', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const created = await admin.post('/v1/api-keys', { name: 'IT reporting key', permissions: ['campaigns.view', 'reports.view'] })
    expect(created.status).toBe(201)
    const secret = created.body.data.secret as string
    expect(secret).toMatch(/^ntk_live_/)
    expect(created.body.data.key.secretHash).toBeUndefined()
    const listed = await admin.get('/v1/api-keys')
    expect(JSON.stringify(listed.body.data)).not.toContain(secret)

    const key = bearer(secret)
    expect((await key.get('/v1/campaigns')).status).toBe(200)
    expect((await key.post('/v1/campaigns', { name: 'nope' })).status).toBe(403)
    expect((await key.get('/v1/users')).status).toBe(403)
    expect((await key.get('/v1/auth/me')).status).toBe(403)
    expect((await key.get('/v1/api-keys')).status).toBe(403)
    expect((await request(app).get('/v1/campaigns').set('authorization', 'Bearer ntk_live_' + 'x'.repeat(43))).status).toBe(401)

    // A key with write permission can create without a CSRF token.
    const writer = await admin.post('/v1/api-keys', { name: 'IT writer key', permissions: ['campaigns.view', 'campaigns.manage'] })
    const made = await bearer(writer.body.data.secret).post('/v1/campaigns', {
      name: 'IT API campaign',
      advertiserId: advertiserA,
      category: 'Ecommerce',
      landingPages: [{ name: 'Main', url: 'https://brand.example.com/?c={click_id}', isDefault: true }],
    })
    expect(made.status).toBe(201)
  })

  it('refuses account-management permissions and anything the creator does not hold', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    expect((await admin.post('/v1/api-keys', { name: 'bad', permissions: ['users.manage'] })).status).toBe(400)
    expect((await admin.post('/v1/api-keys', { name: 'bad', permissions: ['not.a.permission'] })).status).toBe(400)
    const publisher = await signIn(`pub-a1-${run}@it.test`)
    expect((await publisher.post('/v1/api-keys', { name: 'bad', permissions: ['campaigns.manage'] })).status).toBe(400)
  })

  it('limits a publisher key to that publisher and never exposes revenue', async () => {
    const publisher = await signIn(`pub-a1-${run}@it.test`)
    const created = await publisher.post('/v1/api-keys', { name: 'IT publisher feed', permissions: ['campaigns.view', 'conversions.view'] })
    expect(created.status).toBe(201)
    const key = bearer(created.body.data.secret)
    const campaigns = await key.get('/v1/campaigns')
    expect(campaigns.status).toBe(200)
    expect(campaigns.body.data.items.map((c: { id: string }) => c.id)).toContain(campaignA)
    expect(JSON.stringify(campaigns.body.data)).not.toMatch(/defaultRevenue/)
    // Organization-wide managers see every key; the publisher sees only their own.
    const admin = await signIn(`admin-a-${run}@it.test`)
    expect((await admin.get('/v1/api-keys')).body.data.map((k: { name: string }) => k.name)).toContain('IT publisher feed')
    expect((await publisher.get('/v1/api-keys')).body.data.every((k: { name: string }) => k.name === 'IT publisher feed')).toBe(true)
  })

  it('stops working when revoked, rotated, expired, or when the creator loses access', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const revoked = (await admin.post('/v1/api-keys', { name: 'IT revoke', permissions: ['campaigns.view'] })).body.data
    expect((await admin.post(`/v1/api-keys/${revoked.key.id}/revoke`)).status).toBe(200)
    expect((await bearer(revoked.secret).get('/v1/campaigns')).status).toBe(401)

    const original = (await admin.post('/v1/api-keys', { name: 'IT rotate', permissions: ['campaigns.view'] })).body.data
    const rotated = await admin.post(`/v1/api-keys/${original.key.id}/rotate`)
    expect(rotated.status).toBe(200)
    expect((await bearer(original.secret).get('/v1/campaigns')).status).toBe(401)
    expect((await bearer(rotated.body.data.secret).get('/v1/campaigns')).status).toBe(200)

    const expiring = (await admin.post('/v1/api-keys', { name: 'IT expire', permissions: ['campaigns.view'] })).body.data
    await deps.prisma.apiKey.update({ where: { id: expiring.key.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect((await bearer(expiring.secret).get('/v1/campaigns')).status).toBe(401)

    await createUser(orgA, 'network_admin', `key-owner-${run}@it.test`)
    const owner = await signIn(`key-owner-${run}@it.test`)
    const owned = (await owner.post('/v1/api-keys', { name: 'IT owner leaves', permissions: ['campaigns.view'] })).body.data
    expect((await bearer(owned.secret).get('/v1/campaigns')).status).toBe(200)
    const ownerUser = await deps.prisma.user.findUniqueOrThrow({ where: { email: `key-owner-${run}@it.test` } })
    await deps.prisma.organizationMember.updateMany({ where: { organizationId: orgA, userId: ownerUser.id }, data: { status: 'disabled' } })
    expect((await bearer(owned.secret).get('/v1/campaigns')).status).toBe(401)
  })

  it('enforces the per-minute limit and the IP allowlist, and logs every request', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const limited = (await admin.post('/v1/api-keys', { name: 'IT limited', permissions: ['campaigns.view'], requestsPerMinute: 10 })).body.data
    const statuses: number[] = []
    for (let i = 0; i < 11; i += 1) statuses.push((await bearer(limited.secret).get('/v1/campaigns')).status)
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true)
    expect(statuses[10]).toBe(429)

    const fenced = (await admin.post('/v1/api-keys', { name: 'IT fenced', permissions: ['campaigns.view'], allowedIps: ['198.51.100.0/24'] })).body.data
    expect((await bearer(fenced.secret).get('/v1/campaigns')).status).toBe(403)
    expect((await admin.post('/v1/api-keys', { name: 'bad ip', permissions: ['campaigns.view'], allowedIps: ['not-an-ip'] })).status).toBe(400)

    // Rows are recorded when each response finishes; give the last ones a moment, then flush.
    let logs = await admin.get(`/v1/api-keys/logs?keyId=${limited.key.id}`)
    for (let attempt = 0; attempt < 20 && logs.body.data.items.length < 11; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      await deps.apiRequestLog.flush()
      logs = await admin.get(`/v1/api-keys/logs?keyId=${limited.key.id}`)
    }
    expect(logs.status).toBe(200)
    expect(logs.body.data.items.length).toBeGreaterThanOrEqual(11)
    expect(logs.body.data.items.map((r: { status: number }) => r.status)).toContain(429)
    expect(logs.body.data.items[0].path).toBe('/v1/campaigns')
  })
})

describe('Trackier import', () => {
  const waitFor = async (admin: Awaited<ReturnType<typeof signIn>>, id: string) => {
    for (let i = 0; i < 50; i += 1) {
      const batch = (await admin.get(`/v1/imports/${id}`)).body.data.batch
      if (batch.status !== 'importing') return batch
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('import did not finish')
  }

  it('stages, validates and matches advertisers, links duplicates without changing them, and never re-imports', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const csv = ['Advertiser ID,Company,Email,Status', `T-ADV-1-${run},Trackier Brand ${run},brand-${run}@it.test,Active`, `T-ADV-2-${run},Whatever Name,a@it.test,Active`, `T-ADV-3-${run},No Email Co,,Active`].join('\n')
    const staged = await admin.post('/v1/imports', { entity: 'advertisers', fileName: 'advertisers.csv', csv })
    expect(staged.status).toBe(201)
    expect(staged.body.data.totals).toMatchObject({ rows: 3, new: 1, possible_duplicate: 1, invalid: 1 })
    const rows = (await admin.get(`/v1/imports/${staged.body.data.id}`)).body.data.rows.items
    expect(rows.find((r: { match: string }) => r.match === 'possible_duplicate')).toMatchObject({ matchedId: advertiserA, decision: 'link' })
    expect(rows.find((r: { match: string }) => r.match === 'invalid').errors.join(' ')).toMatch(/email/i)
    // Nothing is written before commit.
    expect(await deps.prisma.advertiser.count({ where: { organizationId: orgA, companyName: `Trackier Brand ${run}` } })).toBe(0)

    expect((await admin.post(`/v1/imports/${staged.body.data.id}/commit`)).status).toBe(200)
    const done = await waitFor(admin, staged.body.data.id)
    expect(done.status).toBe('imported')
    expect(done.totals).toMatchObject({ result_created: 1, result_linked: 1 })
    const advertiserARow = await deps.prisma.advertiser.findUniqueOrThrow({ where: { id: advertiserA } })
    expect(advertiserARow.companyName).toBe('IT Advertiser A')
    expect(await deps.prisma.externalRef.count({ where: { organizationId: orgA, externalId: { in: [`T-ADV-1-${run}`, `T-ADV-2-${run}`] } } })).toBe(2)

    const again = await admin.post('/v1/imports', { entity: 'advertisers', csv })
    expect(again.body.data.totals).toMatchObject({ already_imported: 2, invalid: 1 })
  })

  it('imports campaigns as drafts with Trackier macros translated, and rejects unknown macros or advertisers', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const csv = [
      'Campaign ID,Campaign Name,Advertiser ID,URL,Status,Payout,Revenue,Countries',
      `T-CMP-1-${run},Imported Offer ${run},T-ADV-1-${run},https://shop.example.com/?cid={click_id}&s1={p1},Active,4.50,6.00,"US, IN"`,
      `T-CMP-2-${run},Bad Macro ${run},T-ADV-1-${run},https://shop.example.com/?x={gaid},Active,1,2,US`,
      `T-CMP-3-${run},No Advertiser ${run},T-ADV-404,https://shop.example.com/,Active,1,2,US`,
    ].join('\n')
    const staged = await admin.post('/v1/imports', { entity: 'campaigns', csv })
    expect(staged.status).toBe(201)
    expect(staged.body.data.totals).toMatchObject({ new: 1, invalid: 2 })
    const rows = (await admin.get(`/v1/imports/${staged.body.data.id}`)).body.data.rows.items
    expect(rows.map((r: { errors: string[] }) => r.errors.join(' ')).join(' ')).toMatch(/\{gaid\}.*|Unknown Trackier macros/)
    await admin.post(`/v1/imports/${staged.body.data.id}/commit`)
    expect((await waitFor(admin, staged.body.data.id)).status).toBe('imported')
    const campaign = await deps.prisma.campaign.findFirstOrThrow({ where: { organizationId: orgA, name: `Imported Offer ${run}` }, include: { landingPages: true } })
    expect(campaign.status).toBe('draft')
    expect(campaign.geoAllowed.sort()).toEqual(['IN', 'US'])
    expect(campaign.defaultPayout.toString()).toBe('4.5')
    expect(campaign.landingPages[0]!.url).toBe('https://shop.example.com/?cid={click_id}&s1={subid1}')
  })

  it('imports payout tiers, publishers and approvals, and never overwrites existing access', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const payouts = await admin.post('/v1/imports', { entity: 'payouts', csv: ['Campaign ID,Goal,Country,Payout,Revenue', `T-CMP-1-${run},Lead,US,2.00,3.00`].join('\n') })
    expect(payouts.body.data.totals).toMatchObject({ new: 1 })
    await admin.post(`/v1/imports/${payouts.body.data.id}/commit`)
    await waitFor(admin, payouts.body.data.id)
    const campaign = await deps.prisma.campaign.findFirstOrThrow({ where: { organizationId: orgA, name: `Imported Offer ${run}` } })
    expect(await deps.prisma.campaignPayout.count({ where: { campaignId: campaign.id, event: 'lead', country: 'US' } })).toBe(1)

    const publishers = await admin.post('/v1/imports', { entity: 'publishers', csv: ['Publisher ID,Publisher Name,Email,Status', `T-PUB-1-${run},Imported Pub ${run},pub-${run}@it.test,Active`].join('\n') })
    await admin.post(`/v1/imports/${publishers.body.data.id}/commit`)
    await waitFor(admin, publishers.body.data.id)
    const approvals = await admin.post('/v1/imports', { entity: 'approvals', csv: ['Campaign ID,Publisher ID,Status', `T-CMP-1-${run},T-PUB-1-${run},Approved`].join('\n') })
    await admin.post(`/v1/imports/${approvals.body.data.id}/commit`)
    await waitFor(admin, approvals.body.data.id)
    const again = await admin.post('/v1/imports', { entity: 'approvals', csv: ['Campaign ID,Publisher ID,Status', `T-CMP-1-${run},T-PUB-1-${run},Blocked`].join('\n') })
    expect(again.body.data.totals).toMatchObject({ existing: 1 })
    const row = (await admin.get(`/v1/imports/${again.body.data.id}`)).body.data.rows.items[0]
    expect((await admin.patch(`/v1/imports/${again.body.data.id}/rows/${row.id}`, { decision: 'create' })).status).toBe(400)
  })

  it('undoes an import by removing only the records it created, and is closed to restricted roles', async () => {
    const admin = await signIn(`admin-a-${run}@it.test`)
    const staged = await admin.post('/v1/imports', { entity: 'advertisers', csv: ['Advertiser ID,Company,Email', `T-ADV-UNDO-${run},Undo Me ${run},undo-${run}@it.test`].join('\n') })
    await admin.post(`/v1/imports/${staged.body.data.id}/commit`)
    await waitFor(admin, staged.body.data.id)
    expect(await deps.prisma.advertiser.count({ where: { organizationId: orgA, companyName: `Undo Me ${run}` } })).toBe(1)
    const undone = await admin.post(`/v1/imports/${staged.body.data.id}/undo`)
    expect(undone.body.data).toMatchObject({ deleted: 1 })
    expect(await deps.prisma.advertiser.count({ where: { organizationId: orgA, companyName: `Undo Me ${run}` } })).toBe(0)
    expect(await deps.prisma.externalRef.count({ where: { externalId: `T-ADV-UNDO-${run}` } })).toBe(0)

    const publisher = await signIn(`pub-a1-${run}@it.test`)
    expect((await publisher.get('/v1/imports')).status).toBe(403)
  })
})
