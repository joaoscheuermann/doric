import express, { type Router } from 'express';
import type { SandboxSshAccess } from 'sandbox';

import { handleHttpError, sendError } from '../lib/http/errors.js';
import type { RunningVm } from '../lib/vms.js';

export type CreateVmsRouterOptions = {
  readonly list: () => readonly RunningVm[];
  readonly find: (id: string) => RunningVm | undefined;
  readonly ssh: (
    id: string,
  ) => Promise<
    { readonly projectId: string; readonly ssh: SandboxSshAccess } | undefined
  >;
};

/** Creates the mountable routes for observing active VM runtimes. */
export const createVmsRouter = ({
  list,
  find,
  ssh,
}: CreateVmsRouterOptions): Router => {
  const router = express.Router();

  router.get('/', (_request, response) => {
    response.json(list());
  });

  router.get('/:id/ssh', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const vm = find(request.params.id ?? '');
    if (vm === undefined) {
      sendError(response, 404, 'vm_not_found', 'The VM was not found.');
      return;
    }

    const access = await ssh(vm.id);
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
