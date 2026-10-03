import type { PermissionKey } from './permissions';

/**
 * Notification catalogue. Each type names the permission a recipient must hold and who can
 * receive it:
 *  - staff:   organization-wide members, plus managed (agency/account manager) members assigned
 *             to the subject advertiser or publisher
 *  - partner: advertiser or publisher portal users linked to the subject
 *  - all:     both
 * Recipients are always resolved inside the event's organization and data scope, so a
 * notification can never reveal a record its recipient could not open in the console.
 */

export type NotificationAudience = 'staff' | 'partner' | 'all';

export interface NotificationTypeDefinition {
  label: string;
  description: string;
  permission: PermissionKey;
  audience: NotificationAudience;
  defaults: { inApp: boolean; email: boolean };
}

export const NOTIFICATION_TYPES = {
  'application.submitted': {
    label: 'New campaign applications',
    description: 'A publisher applied to run a campaign that needs approval.',
    permission: 'campaigns.approve',
    audience: 'all',
    defaults: { inApp: true, email: true },
  },
  'application.decided': {
    label: 'Application decisions',
    description: 'Your application to a campaign was approved or rejected.',
    permission: 'campaigns.view',
    audience: 'partner',
    defaults: { inApp: true, email: true },
  },
  'conversion.reviewed': {
    label: 'Conversion approvals and rejections',
    description: 'Conversions were approved, rejected or reversed after review.',
    permission: 'conversions.view',
    audience: 'partner',
    defaults: { inApp: true, email: false },
  },
  'cap.reached': {
    label: 'Caps reached',
    description: 'A campaign hit its daily click or conversion cap.',
    permission: 'campaigns.manage',
    audience: 'all',
    defaults: { inApp: true, email: true },
  },
  'budget.exhausted': {
    label: 'Budget exhausted',
    description: 'A campaign used up its monthly or total budget and stopped paying for clicks.',
    permission: 'campaigns.view',
    audience: 'all',
    defaults: { inApp: true, email: true },
  },
  'domain.failed': {
    label: 'Tracking domain failures',
    description: 'A tracking domain failed its DNS or HTTPS health check.',
    permission: 'domains.manage',
    audience: 'staff',
    defaults: { inApp: true, email: true },
  },
  'postback.failed': {
    label: 'Postback delivery failures',
    description: 'A postback or webhook failed after all retries.',
    permission: 'postbacks.manage',
    audience: 'all',
    defaults: { inApp: true, email: true },
  },
  'payout.requested': {
    label: 'Payout requests',
    description: 'A publisher requested a payout that needs approval.',
    permission: 'finance.approve',
    audience: 'staff',
    defaults: { inApp: true, email: true },
  },
  'payout.updated': {
    label: 'Payout status',
    description: 'Your payout was approved, rejected or paid.',
    permission: 'finance.view',
    audience: 'partner',
    defaults: { inApp: true, email: true },
  },
  'fraud.alert': {
    label: 'Fraud alerts',
    description: 'A fraud rule flagged traffic or conversions for review.',
    permission: 'fraud.manage',
    audience: 'staff',
    defaults: { inApp: true, email: false },
  },
  'privacy.request_submitted': {
    label: 'Privacy requests',
    description: 'Someone asked for personal data to be erased and it needs a second person to review it.',
    permission: 'privacy.manage',
    audience: 'staff',
    defaults: { inApp: true, email: true },
  },
  'report.failed': {
    label: 'Scheduled report failures',
    description: 'One of your scheduled reports could not be generated or sent.',
    permission: 'reports.schedule',
    audience: 'staff',
    defaults: { inApp: true, email: true },
  },
} as const satisfies Record<string, NotificationTypeDefinition>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;
export const NOTIFICATION_TYPE_KEYS = Object.keys(NOTIFICATION_TYPES) as NotificationType[];

export const isNotificationType = (value: unknown): value is NotificationType =>
  typeof value === 'string' && Object.hasOwn(NOTIFICATION_TYPES, value);

export const EMAIL_QUEUE = 'ntrack-email';

export interface EmailAttachment {
  filename: string;
  contentType: string;
  /** Base64 so the job payload stays JSON. */
  contentBase64: string;
}

export interface EmailJob {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
}
