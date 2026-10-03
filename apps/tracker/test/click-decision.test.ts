import { describe, expect, it } from 'vitest';
import { decideClick, type ClickFacts } from '../src/services/click-decision';
import { makeCampaign, makeLink } from './fixtures';

const facts = (overrides: Partial<ClickFacts> = {}): ClickFacts => ({
  query: {},
  country: 'US',
  deviceType: 'desktop',
  os: 'windows',
  browser: 'chrome',
  language: 'en',
  clickId: '01J9Z3QK4T8W2M6N7P5R0S1V2X',
  now: Date.UTC(2026, 9, 3),
  botReason: null,
  isDuplicate: false,
  isDatacenter: false,
  capReached: false,
  frequencyCapReached: false,
  ...overrides,
});

describe('decideClick: standard mode', () => {
  it('redirects to the default landing page with macros rendered', () => {
    const decision = decideClick(makeCampaign(), makeLink(), facts({ query: { sub1: 'google' } }));
    expect(decision).toMatchObject({ kind: 'redirect', landingPageId: 'lp_main', invalidReason: null });
    if (decision.kind === 'redirect') expect(decision.location).toBe('https://brand.com/offer?aff=01J9Z3QK4T8W2M6N7P5R0S1V2X&s1=google');
  });

  it('uses link presets over URL parameters so attribution cannot be edited in the URL', () => {
    const decision = decideClick(makeCampaign(), makeLink({ presets: { sub1: 'saved' } }), facts({ query: { sub1: 'edited' } }));
    expect(decision.kind === 'redirect' && decision.subs.sub1).toBe('saved');
  });

  it('honours a requested landing page only if it belongs to the campaign', () => {
    const alt = decideClick(makeCampaign(), makeLink(), facts({ query: { lp: 'lp_alt' } }));
    expect(alt.kind === 'redirect' && alt.landingPageId).toBe('lp_alt');
    const unknown = decideClick(makeCampaign(), makeLink(), facts({ query: { lp: 'lp_other' } }));
    expect(unknown.kind === 'redirect' && unknown.landingPageId).toBe('lp_main');
  });

  it('ignores deep links unless the campaign allows them', () => {
    const decision = decideClick(makeCampaign(), makeLink(), facts({ query: { dl: 'https://brand.com/deep' } }));
    expect(decision.kind === 'redirect' && decision.location).toContain('/offer');
  });

  it('follows an allowlisted deep link when allowed and ignores an off-list one', () => {
    const campaign = makeCampaign({ allowDeepLinks: true });
    const ok = decideClick(campaign, makeLink(), facts({ query: { dl: 'https://shop.brand.com/item/9' } }));
    expect(ok.kind === 'redirect' && ok.location).toBe('https://shop.brand.com/item/9');
    const evil = decideClick(campaign, makeLink(), facts({ query: { dl: 'https://evil.com/phish' } }));
    expect(evil.kind === 'redirect' && evil.location).toContain('https://brand.com/offer');
  });

  it('appends the link UTM parameters to the destination', () => {
    const decision = decideClick(makeCampaign(), makeLink({ extraParams: { utm_source: 'ntrack' } }), facts());
    expect(decision.kind === 'redirect' && new URL(decision.location).searchParams.get('utm_source')).toBe('ntrack');
  });

  it('rejects when a landing page template renders to an off-list host', () => {
    const campaign = makeCampaign({ allowedHosts: ['other.com'], landingPages: { lp_main: 'https://brand.com/x' } });
    expect(decideClick(campaign, makeLink(), facts())).toMatchObject({ kind: 'reject', code: 'destination_invalid' });
  });

  it('records bots and duplicates as invalid but still redirects', () => {
    expect(decideClick(makeCampaign(), makeLink(), facts({ botReason: 'bot_user_agent' }))).toMatchObject({ kind: 'redirect', invalidReason: 'bot_user_agent' });
    expect(decideClick(makeCampaign(), makeLink(), facts({ isDuplicate: true }))).toMatchObject({ kind: 'redirect', invalidReason: 'duplicate_click' });
  });
});

describe('decideClick: campaign rules', () => {
  it.each([
    [{ status: 'paused' as const }, {}, 'campaign_inactive'],
    [{ startsAt: '2027-01-01T00:00:00Z' }, {}, 'campaign_not_started'],
    [{ endsAt: '2026-01-01T00:00:00Z' }, {}, 'campaign_ended'],
    [{ allowedCountries: ['IN'] }, {}, 'geo_not_allowed'],
    [{ blockedCountries: ['US'] }, {}, 'geo_not_allowed'],
    [{ allowedDevices: ['mobile' as const] }, {}, 'device_not_allowed'],
    [{}, { capReached: true }, 'click_cap_reached'],
  ])('rejects with %o / %o as %s when no fallback is set', (campaign, factOverrides, reason) => {
    expect(decideClick(makeCampaign(campaign), makeLink(), facts(factOverrides))).toMatchObject({ kind: 'reject', status: 410, invalidReason: reason });
  });

  it('rejects publishers that are not approved for the campaign', () => {
    expect(decideClick(makeCampaign(), makeLink({ publisherApproved: false }), facts())).toMatchObject({ invalidReason: 'publisher_not_approved' });
  });

  it('sends blocked traffic to the declared fallback URL when one exists', () => {
    const decision = decideClick(makeCampaign({ status: 'paused', fallbackUrl: 'https://brand.com/closed' }), makeLink(), facts());
    expect(decision).toMatchObject({ kind: 'redirect', location: 'https://brand.com/closed', usedFallback: true, invalidReason: 'campaign_inactive' });
  });
});

describe('decideClick: transparent mode (Google Ads compatible)', () => {
  const transparent = makeCampaign({ redirectMode: 'transparent', fallbackUrl: 'https://brand.com/closed' });

  it('redirects to exactly the declared destination parameter', () => {
    const declared = 'https://brand.com/landing?gclid=abc';
    const decision = decideClick(transparent, makeLink(), facts({ query: { url: declared } }));
    expect(decision).toMatchObject({ kind: 'redirect', location: declared });
  });

  it('never falls back to another destination when the declared one is missing or off-list', () => {
    expect(decideClick(transparent, makeLink(), facts())).toMatchObject({ kind: 'reject', status: 400, code: 'destination_missing' });
    expect(decideClick(transparent, makeLink(), facts({ query: { url: 'https://evil.com' } }))).toMatchObject({ kind: 'reject', status: 400 });
  });

  it('still sends the user to the declared URL for a paused campaign, recording the click as invalid', () => {
    const decision = decideClick({ ...transparent, status: 'paused' }, makeLink(), facts({ query: { url: 'https://brand.com/x' } }));
    expect(decision).toMatchObject({ kind: 'redirect', location: 'https://brand.com/x', invalidReason: 'campaign_inactive' });
  });

  it('appends the click ID only when the campaign opts in', () => {
    const decision = decideClick({ ...transparent, transparentClickIdParam: 'ntclid' }, makeLink(), facts({ query: { url: 'https://brand.com/x' } }));
    expect(decision.kind === 'redirect' && decision.location).toBe('https://brand.com/x?ntclid=01J9Z3QK4T8W2M6N7P5R0S1V2X');
  });
});

describe('decideClick: OS, browser, language, frequency and budget rules', () => {
  it('blocks a visitor whose OS is not on the campaign list', () => {
    const decision = decideClick(makeCampaign({ allowedOperatingSystems: ['ios', 'android'] }), makeLink(), facts());
    expect(decision).toMatchObject({ kind: 'reject', invalidReason: 'os_not_allowed' });
  });

  it('serves a visitor whose OS, browser and language all match', () => {
    const campaign = makeCampaign({ allowedOperatingSystems: ['windows'], allowedBrowsers: ['chrome'], allowedLanguages: ['en', 'hi'] });
    expect(decideClick(campaign, makeLink(), facts())).toMatchObject({ kind: 'redirect', invalidReason: null });
  });

  it('blocks a browser that is not allowed', () => {
    const decision = decideClick(makeCampaign({ allowedBrowsers: ['safari'] }), makeLink(), facts());
    expect(decision).toMatchObject({ kind: 'reject', invalidReason: 'browser_not_allowed' });
  });

  it('blocks a visitor without a matching language, including one that sent no Accept-Language', () => {
    const campaign = makeCampaign({ allowedLanguages: ['hi'] });
    expect(decideClick(campaign, makeLink(), facts())).toMatchObject({ invalidReason: 'language_not_allowed' });
    expect(decideClick(campaign, makeLink(), facts({ language: '' }))).toMatchObject({ invalidReason: 'language_not_allowed' });
  });

  it('sends a visitor over the frequency cap to the fallback URL', () => {
    const campaign = makeCampaign({ frequencyCap: 3, fallbackUrl: 'https://fallback.example.com/' });
    const decision = decideClick(campaign, makeLink(), facts({ frequencyCapReached: true }));
    expect(decision).toMatchObject({ kind: 'redirect', usedFallback: true, invalidReason: 'frequency_cap_reached' });
  });

  it('treats an exhausted budget as a block reason ahead of targeting', () => {
    const campaign = makeCampaign({ budgetExhausted: true, allowedBrowsers: ['safari'] });
    expect(decideClick(campaign, makeLink(), facts())).toMatchObject({ kind: 'reject', invalidReason: 'budget_reached' });
  });

  it('still follows the declared destination in transparent mode when the budget is exhausted', () => {
    const campaign = makeCampaign({ redirectMode: 'transparent', budgetExhausted: true });
    const decision = decideClick(campaign, makeLink(), facts({ query: { url: 'https://brand.com/landing' } }));
    expect(decision).toMatchObject({ kind: 'redirect', location: 'https://brand.com/landing', invalidReason: 'budget_reached' });
  });

  it('flags data-centre traffic but still redirects to the offer', () => {
    const decision = decideClick(makeCampaign(), makeLink(), facts({ isDatacenter: true }));
    expect(decision).toMatchObject({ kind: 'redirect', usedFallback: false, invalidReason: 'datacenter_ip' });
  });

  it('reports a bot user agent ahead of the data-centre flag', () => {
    const decision = decideClick(makeCampaign(), makeLink(), facts({ isDatacenter: true, botReason: 'bot_user_agent' }));
    expect(decision).toMatchObject({ invalidReason: 'bot_user_agent' });
  });
});
