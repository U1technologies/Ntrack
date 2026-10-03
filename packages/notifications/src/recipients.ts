import { NOTIFICATION_TYPES, type NotificationType } from '@ntrack/shared';

export interface NotificationSubject {
  advertiserId?: string | null;
  publisherId?: string | null;
}

export interface CandidateMember {
  userId: string;
  email: string;
  roleScope: 'organization' | 'advertiser' | 'publisher' | 'managed';
  permissions: string[];
  advertiserId: string | null;
  publisherId: string | null;
  /** Assignments for managed members. */
  assignedAdvertiserIds: string[];
  assignedPublisherIds: string[];
}

/**
 * Pure recipient filter: permission, audience and data scope. Kept free of I/O so the rules that
 * stop a notification leaking another partner's data are exhaustively unit-testable.
 */
export const canReceive = (type: NotificationType, member: CandidateMember, subject: NotificationSubject): boolean => {
  const definition = NOTIFICATION_TYPES[type];
  if (!member.permissions.includes(definition.permission)) return false;
  const staffAllowed = definition.audience !== 'partner';
  const partnerAllowed = definition.audience !== 'staff';
  const advertiserId = subject.advertiserId ?? null;
  const publisherId = subject.publisherId ?? null;

  switch (member.roleScope) {
    case 'organization':
      return staffAllowed;
    case 'managed':
      return (
        staffAllowed &&
        ((advertiserId !== null && member.assignedAdvertiserIds.includes(advertiserId)) ||
          (publisherId !== null && member.assignedPublisherIds.includes(publisherId)))
      );
    case 'advertiser':
      return partnerAllowed && advertiserId !== null && member.advertiserId === advertiserId;
    case 'publisher':
      return partnerAllowed && publisherId !== null && member.publisherId === publisherId;
    default:
      return false;
  }
};
