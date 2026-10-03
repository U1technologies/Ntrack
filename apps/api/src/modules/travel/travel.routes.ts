import { Router, type Request, type Response } from 'express';
import { created, ok } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { parse, patchSchema } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import type { AppDeps } from '../../types';
import { BookingImportBody, ListBookingsQuery, TravelPartnerBody, TravelService } from './travel.service';

export const createTravelRouter = (deps: AppDeps) => {
  const router = Router();
  const service = new TravelService(deps);
  router.get('/adapters', ...orgRoute('travel.view'), (_req: Request, res: Response) => ok(res, service.adapters()));
  router.get('/partners', ...orgRoute('travel.view'), async (req: Request, res: Response) => ok(res, await service.listPartners(orgAuth(req))));
  router.post('/partners', ...orgRoute('travel.manage'), async (req: Request, res: Response) =>
    created(res, await service.createPartner(orgAuth(req), parse(TravelPartnerBody, req.body), requestMeta(req)), 'Travel partner created')
  );
  router.patch('/partners/:id', ...orgRoute('travel.manage'), async (req: Request, res: Response) =>
    ok(res, await service.updatePartner(orgAuth(req), param(req, 'id'), parse(patchSchema(TravelPartnerBody), req.body), requestMeta(req)), 'Travel partner updated')
  );
  router.post('/partners/:id/import', ...orgRoute('travel.manage'), async (req: Request, res: Response) =>
    ok(res, await service.importBookings(orgAuth(req), param(req, 'id'), parse(BookingImportBody, req.body), requestMeta(req)), 'Bookings imported')
  );
  router.post('/partners/:id/reconcile', ...orgRoute('travel.manage'), async (req: Request, res: Response) =>
    ok(res, await service.reconcile(orgAuth(req), param(req, 'id')), 'Reconciliation complete')
  );
  router.get('/partners/:id/missing', ...orgRoute('travel.view'), async (req: Request, res: Response) => ok(res, await service.missingFromPartner(orgAuth(req), param(req, 'id'))));
  router.get('/bookings', ...orgRoute('travel.view'), async (req: Request, res: Response) => ok(res, await service.listBookings(orgAuth(req), parse(ListBookingsQuery, req.query))));
  return router;
};
