import { describe, expect, it } from 'vitest';
import { canReceive, renderNotificationEmail, type CandidateMember } from '../src';

const member = (overrides: Partial<CandidateMember>): CandidateMember => ({
  userId: 'u1',
  email: 'user@example.com',
  roleScope: 'organization',
  permissions: [],
  advertiserId: null,
  publisherId: null,
  assignedAdvertiserIds: [],
  assignedPublisherIds: [],
  ...overrides,
});

describe('canReceive', () => {
  it('requires the permission named by the notification type', () => {
    expect(canReceive('domain.failed', member({ permissions: ['domains.view'] }), {})).toBe(false);
    expect(canReceive('domain.failed', member({ permissions: ['domains.manage'] }), {})).toBe(true);
  });

  it('sends partner notifications only to the publisher the event is about', () => {
    const publisherUser = member({ roleScope: 'publisher', publisherId: 'pubA', permissions: ['finance.view'] });
    expect(canReceive('payout.updated', publisherUser, { publisherId: 'pubA' })).toBe(true);
    expect(canReceive('payout.updated', publisherUser, { publisherId: 'pubB' })).toBe(false);
    expect(canReceive('payout.updated', publisherUser, {})).toBe(false);
  });

  it('never sends staff-only notifications to partner users, even with the permission', () => {
    const advertiserUser = member({ roleScope: 'advertiser', advertiserId: 'advA', permissions: ['fraud.manage'] });
    expect(canReceive('fraud.alert', advertiserUser, { advertiserId: 'advA' })).toBe(false);
  });

  it('does not send partner-only notifications to organization staff', () => {
    const staff = member({ permissions: ['finance.view'] });
    expect(canReceive('payout.updated', staff, { publisherId: 'pubA' })).toBe(false);
  });

  it('limits managed members to their assigned advertisers and publishers', () => {
    const manager = member({ roleScope: 'managed', permissions: ['campaigns.approve'], assignedPublisherIds: ['pubA'] });
    expect(canReceive('application.submitted', manager, { advertiserId: 'advX', publisherId: 'pubA' })).toBe(true);
    expect(canReceive('application.submitted', manager, { advertiserId: 'advX', publisherId: 'pubB' })).toBe(false);
    expect(canReceive('application.submitted', manager, {})).toBe(false);
  });

  it('lets the advertiser of the campaign see application requests for their campaigns', () => {
    const advertiserUser = member({ roleScope: 'advertiser', advertiserId: 'advA', permissions: ['campaigns.approve'] });
    expect(canReceive('application.submitted', advertiserUser, { advertiserId: 'advA', publisherId: 'pubZ' })).toBe(true);
    expect(canReceive('application.submitted', advertiserUser, { advertiserId: 'advB', publisherId: 'pubZ' })).toBe(false);
  });
});

describe('renderNotificationEmail', () => {
  it('escapes HTML and strips newlines from the subject', () => {
    const email = renderNotificationEmail({ title: 'Cap <b>hit</b>\r\nBcc: x@y.z', body: '<script>x</script>', link: '', typeLabel: 'Caps' });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
  });
});

describe('account emails', () => {
  it('escapes organization and inviter names and keeps subjects on one line', async () => {
    const { renderInvitationEmail, renderPasswordResetEmail } = await import('../src');
    const email = renderInvitationEmail({ organizationName: 'Acme <b>Ltd</b>\nBcc: x@y.z', inviterName: '<script>alert(1)</script>', roleName: 'Analyst', url: 'https://example.com/ntrack/accept-invite?token=a&b', expiresInDays: 7 });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('href="https://example.com/ntrack/accept-invite?token=a&amp;b"');
    expect(email.text).toContain('https://example.com/ntrack/accept-invite?token=a&b');
    const reset = renderPasswordResetEmail({ url: 'https://example.com/ntrack/reset-password?token=x', expiresInMinutes: 30 });
    expect(reset.text).toContain('30 minutes');
  });
});
