import express, { type Express } from 'express';

import { handleHttpError } from './errors.js';
import { createConfigRouter } from './routes/config.js';
import { createCredentialsRouter } from './routes/credentials.js';
import { createProjectsRouter } from './routes/projects.js';
import { createProvidersRouter } from './routes/providers.js';
import { createResourcesRouter } from './routes/resources.js';
import { createTerminalsRouter } from './routes/terminals.js';
import { createThreadsRouter } from './routes/threads.js';
import { createToolsRouter } from './routes/tools.js';
import { createVmsRouter } from './routes/vms.js';
import type { TransportServices } from './services.js';

/**
 * Registers the production HTTP surface on the shared HTTP/Socket.IO app, in
 * the mount order of before (design 57 §8.2).
 */
export const registerHttpRoutes = (
  app: Express,
  services: TransportServices,
): void => {
  app.use(express.json());
  app.use(createTerminalsRouter(services.terminal));
  app.use('/vms', createVmsRouter(services.sandbox, services.runtime));
  app.use('/config', createConfigRouter(services.configuration));
  app.use('/credentials', createCredentialsRouter(services.secrets));
  app.use(
    '/resources',
    createResourcesRouter(() => services.resources()),
  );
  app.use('/providers', createProvidersRouter(services.models));
  app.use('/projects', createProjectsRouter(services));
  app.use('/threads', createThreadsRouter(services));
  app.use('/tools', createToolsRouter(services.tools));
  app.use(handleHttpError);
};
