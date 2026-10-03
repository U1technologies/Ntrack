import type { Request, Response } from 'express';
import { created, ok } from '../../lib/response';
import { orgAuth, param, requestMeta } from '../../lib/request';
import { serialize } from '../../lib/serialize';
import { parse } from '../../lib/validate';
import type { AppDeps } from '../../types';
import { CreateOrganizationBody, UpdateOrganizationBody, UpdateSettingsBody } from './organizations.schemas';
import { OrganizationsService } from './organizations.service';

export const createOrganizationsController = (deps: AppDeps) => {
  const service = new OrganizationsService(deps);
  return {
    list: async (_req: Request, res: Response) => ok(res, serialize(await service.list())),
    create: async (req: Request, res: Response) => created(res, await service.create(req.auth!, parse(CreateOrganizationBody, req.body), requestMeta(req))),
    update: async (req: Request, res: Response) =>
      ok(res, await service.update(req.auth!, param(req, 'id'), parse(UpdateOrganizationBody, req.body), requestMeta(req)), 'Organization updated'),
    current: async (req: Request, res: Response) => ok(res, await service.current(orgAuth(req))),
    updateSettings: async (req: Request, res: Response) =>
      ok(res, await service.updateSettings(orgAuth(req), parse(UpdateSettingsBody, req.body), requestMeta(req)), 'Settings saved'),
  };
};
