import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { CAMPAIGN_CATEGORIES } from '@ntrack/shared';
import { created, ok } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { parse } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import type { AppDeps } from '../../types';
import { CampaignPartnersService } from './campaign-partners.service';
import {
  ApplicationDecisionBody,
  ApplyBody,
  AssignPublisherBody,
  BulkBody,
  CreateCampaignBody,
  DeleteCampaignBody,
  LandingPageBody,
  ListApplicationsQuery,
  ListCampaignsQuery,
  PayoutTierBody,
  StatusBody,
  UpdateCampaignBody,
  UpdateLandingPageBody,
  UpdatePayoutTierBody,
} from './campaigns.schemas';
import { CampaignsService } from './campaigns.service';

const MarketplaceQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
  search: z.string().trim().max(100).optional(),
  category: z.enum(CAMPAIGN_CATEGORIES).optional(),
});

export const createCampaignsRouter = (deps: AppDeps) => {
  const router = Router();
  const campaigns = new CampaignsService(deps);
  const partners = new CampaignPartnersService(deps);

  // Static paths first so they are not captured by /:id.
  router.get('/marketplace', ...orgRoute('campaigns.view'), async (req: Request, res: Response) =>
    ok(res, await partners.marketplace(orgAuth(req), parse(MarketplaceQuery, req.query)))
  );
  router.get('/applications', ...orgRoute('campaigns.view'), async (req: Request, res: Response) =>
    ok(res, await partners.listApplications(orgAuth(req), parse(ListApplicationsQuery, req.query)))
  );
  router.patch('/applications/:applicationId', ...orgRoute('campaigns.approve'), async (req: Request, res: Response) =>
    ok(res, await partners.decide(orgAuth(req), param(req, 'applicationId'), parse(ApplicationDecisionBody, req.body), requestMeta(req)), 'Application updated')
  );
  router.post('/bulk', ...orgRoute('campaigns.manage'), async (req: Request, res: Response) =>
    ok(res, await campaigns.bulk(orgAuth(req), parse(BulkBody, req.body), requestMeta(req)), 'Campaigns updated')
  );

  router.get('/', ...orgRoute('campaigns.view'), async (req: Request, res: Response) => ok(res, await campaigns.list(orgAuth(req), parse(ListCampaignsQuery, req.query))));
  router.post('/', ...orgRoute('campaigns.manage'), async (req: Request, res: Response) =>
    created(res, await campaigns.create(orgAuth(req), parse(CreateCampaignBody, req.body), requestMeta(req)), 'Campaign created')
  );
  router.get('/:id', ...orgRoute('campaigns.view'), async (req: Request, res: Response) => ok(res, await campaigns.get(orgAuth(req), param(req, 'id'))));
  router.patch('/:id', ...orgRoute('campaigns.manage'), async (req: Request, res: Response) =>
    ok(res, await campaigns.update(orgAuth(req), param(req, 'id'), parse(UpdateCampaignBody, req.body), requestMeta(req)), 'Campaign updated')
  );
  router.post('/:id/status', ...orgRoute('campaigns.manage'), async (req: Request, res: Response) =>
    ok(res, await campaigns.setStatus(orgAuth(req), param(req, 'id'), parse(StatusBody, req.body), requestMeta(req)), 'Campaign status updated')
  );
  router.post('/:id/duplicate', ...orgRoute('campaigns.manage'), async (req: Request, res: Response) =>
    created(res, await campaigns.duplicate(orgAuth(req), param(req, 'id'), requestMeta(req)), 'Campaign duplicated')
  );
  router.delete('/:id', ...orgRoute('campaigns.delete'), async (req: Request, res: Response) => {
    await campaigns.remove(orgAuth(req), param(req, 'id'), parse(DeleteCampaignBody, req.body).confirmName, requestMeta(req));
    return ok(res, null, 'Campaign deleted');
  });

  router.get('/:id/landing-pages', ...orgRoute('campaigns.view'), async (req: Request, res: Response) =>
    ok(res, await campaigns.listLandingPages(orgAuth(req), param(req, 'id')))
  );
  router.post('/:id/landing-pages', ...orgRoute('campaigns.manage'), async (req: Request, res: Response) =>
    created(res, await campaigns.addLandingPage(orgAuth(req), param(req, 'id'), parse(LandingPageBody, req.body), requestMeta(req)), 'Landing page added')
  );
  router.patch('/:id/landing-pages/:pageId', ...orgRoute('campaigns.manage'), async (req: Request, res: Response) =>
    ok(
      res,
      await campaigns.updateLandingPage(orgAuth(req), param(req, 'id'), param(req, 'pageId'), parse(UpdateLandingPageBody, req.body), requestMeta(req)),
      'Landing page updated'
    )
  );
  router.delete('/:id/landing-pages/:pageId', ...orgRoute('campaigns.manage'), async (req: Request, res: Response) => {
    await campaigns.removeLandingPage(orgAuth(req), param(req, 'id'), param(req, 'pageId'), requestMeta(req));
    return ok(res, null, 'Landing page deleted');
  });

  router.get('/:id/payouts', ...orgRoute(['payouts.view', 'campaigns.view']), async (req: Request, res: Response) =>
    ok(res, await partners.listPayouts(orgAuth(req), param(req, 'id')))
  );
  router.get('/:id/payouts/history', ...orgRoute('payouts.view'), async (req: Request, res: Response) =>
    ok(res, await partners.payoutHistory(orgAuth(req), param(req, 'id')))
  );
  router.post('/:id/payouts', ...orgRoute('payouts.manage'), async (req: Request, res: Response) =>
    created(res, await partners.addPayout(orgAuth(req), param(req, 'id'), parse(PayoutTierBody, req.body), requestMeta(req)), 'Payout tier added')
  );
  router.patch('/:id/payouts/:tierId', ...orgRoute('payouts.manage'), async (req: Request, res: Response) =>
    ok(res, await partners.updatePayout(orgAuth(req), param(req, 'id'), param(req, 'tierId'), parse(UpdatePayoutTierBody, req.body), requestMeta(req)), 'Payout tier updated')
  );
  router.delete('/:id/payouts/:tierId', ...orgRoute('payouts.manage'), async (req: Request, res: Response) => {
    await partners.removePayout(orgAuth(req), param(req, 'id'), param(req, 'tierId'), requestMeta(req));
    return ok(res, null, 'Payout tier deleted');
  });

  router.post('/:id/apply', ...orgRoute('campaigns.view'), async (req: Request, res: Response) =>
    created(res, await partners.apply(orgAuth(req), param(req, 'id'), parse(ApplyBody, req.body).note, requestMeta(req)), 'Application submitted')
  );
  router.post('/:id/publishers', ...orgRoute('campaigns.approve'), async (req: Request, res: Response) =>
    ok(res, await partners.assign(orgAuth(req), param(req, 'id'), parse(AssignPublisherBody, req.body), requestMeta(req)), 'Publisher access updated')
  );
  return router;
};
