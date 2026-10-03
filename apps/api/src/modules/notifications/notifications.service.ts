import { z } from 'zod';
import { NOTIFICATION_TYPES, NOTIFICATION_TYPE_KEYS, type NotificationType } from '@ntrack/shared';
import { AppError } from '../../lib/errors';
import { paginated } from '../../lib/response';
import { PaginationQuery, skipTake } from '../../lib/validate';
import type { AppDeps, OrgAuthContext } from '../../types';

export const ListNotificationsQuery = PaginationQuery.extend({
  unread: z.enum(['true', 'false']).optional(),
});

export const PreferencesBody = z.object({
  items: z
    .array(
      z.object({
        type: z.enum(NOTIFICATION_TYPE_KEYS as [NotificationType, ...NotificationType[]]),
        inApp: z.boolean(),
        email: z.boolean(),
      })
    )
    .min(1)
    .max(NOTIFICATION_TYPE_KEYS.length),
});

/** Types this user could ever receive, given their permissions and whether they are staff or a partner. */
const receivableTypes = (auth: OrgAuthContext): NotificationType[] => {
  const isPartner = auth.scope.type === 'advertiser' || auth.scope.type === 'publisher';
  return NOTIFICATION_TYPE_KEYS.filter((type) => {
    const definition = NOTIFICATION_TYPES[type];
    if (!auth.permissions.has(definition.permission)) return false;
    return isPartner ? definition.audience !== 'staff' : definition.audience !== 'partner';
  });
};

/** A user's own in-app notifications and delivery preferences, always within the active organization. */
export class NotificationsService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }

  private own(auth: OrgAuthContext) {
    return { organizationId: auth.organizationId, userId: auth.user.id };
  }

  async list(auth: OrgAuthContext, query: z.infer<typeof ListNotificationsQuery>) {
    const where = { ...this.own(auth), ...(query.unread === 'true' ? { readAt: null } : {}) };
    const [items, total, unread] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { ...this.own(auth), readAt: null } }),
    ]);
    return { ...paginated(items, total, query.page, query.pageSize), unread };
  }

  async unreadCount(auth: OrgAuthContext) {
    return { unread: await this.prisma.notification.count({ where: { ...this.own(auth), readAt: null } }) };
  }

  async markRead(auth: OrgAuthContext, id: string) {
    const { count } = await this.prisma.notification.updateMany({ where: { id, ...this.own(auth), readAt: null }, data: { readAt: new Date() } });
    if (count === 0) {
      const exists = await this.prisma.notification.count({ where: { id, ...this.own(auth) } });
      if (!exists) throw AppError.notFound('Notification');
    }
    return this.unreadCount(auth);
  }

  async markAllRead(auth: OrgAuthContext) {
    const { count } = await this.prisma.notification.updateMany({ where: { ...this.own(auth), readAt: null }, data: { readAt: new Date() } });
    return { marked: count, unread: 0 };
  }

  async preferences(auth: OrgAuthContext) {
    const types = receivableTypes(auth);
    const saved = await this.prisma.notificationPreference.findMany({ where: { ...this.own(auth), type: { in: types } } });
    const byType = new Map(saved.map((p) => [p.type, p]));
    return {
      emailConfigured: Boolean(this.deps.config.SMTP_HOST && this.deps.config.SMTP_FROM),
      items: types.map((type) => {
        const definition = NOTIFICATION_TYPES[type];
        const pref = byType.get(type);
        return {
          type,
          label: definition.label,
          description: definition.description,
          inApp: pref?.inApp ?? definition.defaults.inApp,
          email: pref?.email ?? definition.defaults.email,
        };
      }),
    };
  }

  async savePreferences(auth: OrgAuthContext, input: z.infer<typeof PreferencesBody>) {
    const allowed = new Set(receivableTypes(auth));
    const rejected = input.items.filter((item) => !allowed.has(item.type));
    if (rejected.length > 0) throw AppError.badRequest(`You do not receive: ${rejected.map((r) => r.type).join(', ')}`);
    await this.prisma.$transaction(
      input.items.map((item) =>
        this.prisma.notificationPreference.upsert({
          where: { organizationId_userId_type: { ...this.own(auth), type: item.type } },
          create: { ...this.own(auth), type: item.type, inApp: item.inApp, email: item.email },
          update: { inApp: item.inApp, email: item.email },
        })
      )
    );
    return this.preferences(auth);
  }
}
