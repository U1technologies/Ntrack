import { Router, type Request, type Response } from 'express';
import { ok } from '../../lib/response';
import { orgAuth, requestMeta } from '../../lib/request';
import { parse } from '../../lib/validate';
import { orgRoute } from '../../middleware/auth';
import { toolRateLimit } from '../../middleware/rate-limit';
import type { AppDeps } from '../../types';
import { RedirectTestBody, RedirectTesterService } from './redirect-tester.service';

export const createToolsRouter = (deps: AppDeps) => {
  const router = Router();
  const tester = new RedirectTesterService(deps);
  router.post('/redirect-test', toolRateLimit(deps), ...orgRoute(['domains.view', 'links.manage']), async (req: Request, res: Response) =>
    ok(res, await tester.run(orgAuth(req), parse(RedirectTestBody, req.body), requestMeta(req)), 'Test complete')
  );
  return router;
};
