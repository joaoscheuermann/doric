import express, { type Express } from 'express';

import { createConfigRouter } from '../../routes/config.js';
import { createProjectsRouter } from '../../routes/projects.js';
import { createThreadsRouter } from '../../routes/threads.js';
import {
  createVmsRouter,
  type CreateVmsRouterOptions,
} from '../../routes/vms.js';
import type { ConfigService } from '../config/service.js';
import { handleHttpError } from './errors.js';
import type { WorkspaceService } from '../workspace/types.js';

/** Registers the production HTTP surface on the shared HTTP/Socket.IO app. */
export const registerHttpRoutes = (
  app: Express,
  dependencies: {
    readonly config: ConfigService;
    readonly service: WorkspaceService;
    readonly vms: CreateVmsRouterOptions;
  },
): void => {
  app.use(express.json());
  app.use('/vms', createVmsRouter(dependencies.vms));
  app.use('/config', createConfigRouter(dependencies.config));
  app.use('/projects', createProjectsRouter(dependencies.service));
  app.use('/threads', createThreadsRouter(dependencies.service));
  app.use(handleHttpError);
};
