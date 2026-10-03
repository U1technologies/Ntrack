import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@ntrack/db';
import { NOTIFICATION_TYPES, type EmailJob, type NotificationType } from '@ntrack/shared';
import { canReceive, type CandidateMember, type NotificationSubject } from './recipients';
import { renderNotificationEmail } from './templates';

export interface NotifyEvent {
  organizationId: string;
  type: NotificationType;
  title: string;
  body?: string;
  /** Console path (e.g. `/ntrack/campaigns/<id>`); emails turn it into an absolute link. */
  link?: string;
  subject?: NotificationSubject;
  /** Limits delivery to these users (still permission and scope checked). */
  onlyUserIds?: string[];
  /** The user who caused the event; they are not notified about their own action. */
  actorUserId?: string | null;
  /** Suppresses repeats of the same event (e.g. one cap alert per campaign per day). */
  dedupeKey?: string;
  dedupeTtlSeconds?: number;
}

export interface NotifierDeps {
  prisma: PrismaClient;
  /** Needed for dedupe keys; without it, dedupe is skipped. */
  redis?: Redis;
  /** Without a queue, email preferences are ignored (in-app only). */
  emailQueue?: Queue<EmailJob>;
  /** Absolute console origin used in email links, e.g. https://nextagmedia.com */
  consoleOrigin?: string;
  log?: { warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
}

export interface NotifyResult {
  inApp: number;
  emails: number;
  skipped?: 'duplicate';
}

export class Notifier {
  constructor(private readonly deps: NotifierDeps) {}

  async notify(event: NotifyEvent): Promise<NotifyResult> {
    if (event.dedupeKey && this.deps.redis) {
      const fresh = await this.deps.redis.set(`ntrack:notify:${event.organizationId}:${event.dedupeKey}`, '1', 'EX', event.dedupeTtlSeconds ?? 86_400, 'NX');
      if (fresh !== 'OK') return { inApp: 0, emails: 0, skipped: 'duplicate' };
    }

    const recipients = (await this.candidates(event.organizationId, event.onlyUserIds)).filter(
      (member) => member.userId !== event.actorUserId && canReceive(event.type, member, event.subject ?? {})
    );
    if (recipients.length === 0) return { inApp: 0, emails: 0 };

    const preferences = await this.deps.prisma.notificationPreference.findMany({
      where: { organizationId: event.organizationId, type: event.type, userId: { in: recipients.map((r) => r.userId) } },
    });
    const byUser = new Map(preferences.map((p) => [p.userId, p]));
    const defaults = NOTIFICATION_TYPES[event.type].defaults;
    const inAppUsers = recipients.filter((r) => byUser.get(r.userId)?.inApp ?? defaults.inApp);
    const emailUsers = this.deps.emailQueue ? recipients.filter((r) => byUser.get(r.userId)?.email ?? defaults.email) : [];

    const title = event.title.slice(0, 200);
    const body = (event.body ?? '').slice(0, 2000);
    const link = event.link && event.link.startsWith('/ntrack') ? event.link : '';
    if (inAppUsers.length > 0) {
      await this.deps.prisma.notification.createMany({
        data: inAppUsers.map((r) => ({ organizationId: event.organizationId, userId: r.userId, type: event.type, title, body, link })),
      });
    }
    if (emailUsers.length > 0 && this.deps.emailQueue) {
      const absoluteLink = link && this.deps.consoleOrigin ? `${this.deps.consoleOrigin.replace(/\/$/, '')}${link}` : '';
      const email = renderNotificationEmail({ title, body, link: absoluteLink, typeLabel: NOTIFICATION_TYPES[event.type].label });
      await this.deps.emailQueue.addBulk(
        emailUsers.map((r) => ({
          name: event.type,
          data: { to: r.email, ...email },
          opts: { attempts: 5, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: 1000, removeOnFail: 5000 },
        }))
      );
    }
    return { inApp: inAppUsers.length, emails: emailUsers.length };
  }

  /** Fire-and-forget variant for hot paths: failures are logged, never thrown to the caller. */
  emit(event: NotifyEvent): void {
    this.notify(event).catch((error: unknown) => this.deps.log?.error({ err: error, type: event.type }, 'notification failed'));
  }

  private async candidates(organizationId: string, onlyUserIds?: string[]): Promise<CandidateMember[]> {
    const members = await this.deps.prisma.organizationMember.findMany({
      where: {
        organizationId,
        status: 'active',
        user: { status: 'active' },
        ...(onlyUserIds ? { userId: { in: onlyUserIds } } : {}),
      },
      include: {
        user: { select: { email: true } },
        role: { select: { scope: true, permissions: { select: { permissionKey: true } } } },
      },
    });
    const managedIds = members.filter((m) => m.role.scope === 'managed').map((m) => m.userId);
    const assignments = managedIds.length
      ? await this.deps.prisma.managerAssignment.findMany({ where: { organizationId, userId: { in: managedIds } } })
      : [];
    return members.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      roleScope: m.role.scope,
      permissions: m.role.permissions.map((p) => p.permissionKey),
      advertiserId: m.advertiserId,
      publisherId: m.publisherId,
      assignedAdvertiserIds: assignments.filter((a) => a.userId === m.userId && a.advertiserId).map((a) => a.advertiserId as string),
      assignedPublisherIds: assignments.filter((a) => a.userId === m.userId && a.publisherId).map((a) => a.publisherId as string),
    }));
  }
}
