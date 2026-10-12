import express, { type Router } from 'express';
import type { Runtime, SandboxProviderApi } from 'runtime/contracts';

import { handleHttpError, sendError } from '../errors.js';

/** The routes observing the sandbox provider's running machines. */
export const createVmsRouter = (
  sandbox: SandboxProviderApi,
  runtime: Runtime,
): Router => {
  const router = express.Router();

  router.get('/', async (_request, response) => {
    response.json(await sandbox.machines());
  });

  router.get('/:id/ssh', async (request, response) => {
    response.set('Cache-Control', 'no-store');

    const vm = await sandbox.machine(request.params.id ?? '');

    if (vm === undefined) {
      sendError(response, 404, 'vm_not_found', 'The VM was not found.');

      return;
    }

    const access = await runtime.vmSsh(vm.id);

    if (access === undefined) {
      sendError(
        response,
        409,
        'vm_ssh_unavailable',
        'SSH is unavailable for this VM.',
      );

      return;
    }

    response.json({ vm, ...access });
  });

  router.use(handleHttpError);
  return router;
};
