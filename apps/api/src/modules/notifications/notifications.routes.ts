import { Router, type Request, type Response } from 'express';
import { ok } from '../../lib/response';
import { orgAuth, param } from '../../lib/request';
import { parse, uuid } from '../../lib/validate';
import { requireAuth, requireOrganization } from '../../middleware/auth';
import type { AppDeps } from '../../types';
import { ListNotificationsQuery, NotificationsService, PreferencesBody } from './notifications.service';

/** Every member can read and manage their own notifications; no extra permission is needed. */
export const createNotificationsRouter = (deps: AppDeps) => {
  const router = Router();
  const service = new NotificationsService(deps);
  const own = [requireAuth(), requireOrganization];

  router.get('/', ...own, async (req: Request, res: Response) => ok(res, await service.list(orgAuth(req), parse(ListNotificationsQuery, req.query))));
  router.get('/unread-count', ...own, async (req: Request, res: Response) => ok(res, await service.unreadCount(orgAuth(req))));
  router.post('/read-all', ...own, async (req: Request, res: Response) => ok(res, await service.markAllRead(orgAuth(req)), 'All notifications marked as read'));
  router.get('/preferences', ...own, async (req: Request, res: Response) => ok(res, await service.preferences(orgAuth(req))));
  router.put('/preferences', ...own, async (req: Request, res: Response) =>
    ok(res, await service.savePreferences(orgAuth(req), parse(PreferencesBody, req.body)), 'Preferences saved')
  );
  router.post('/:id/read', ...own, async (req: Request, res: Response) => ok(res, await service.markRead(orgAuth(req), parse(uuid, param(req, 'id')))));
  return router;
};
