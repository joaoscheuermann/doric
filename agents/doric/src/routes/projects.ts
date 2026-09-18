import { Router } from 'express';
import { z } from 'zod';

import { handleHttpError, sendError } from '../lib/http/errors.js';
import type { WorkspaceService } from '../lib/workspace/types.js';
import { conflict, idInput, missing, pageInput } from './workspace-input.js';

const createInput = z.object({ parentThreadId: z.uuid().optional() }).strict();
const threadsInput = pageInput.extend({ parentThreadId: z.uuid().optional() });

/** Project creation reserves an environment; conversations are created separately. */
export const createProjectsRouter = (service: WorkspaceService): Router => {
  const router = Router();
  router.post('/', async (request, response) => {
    if (
      !z
        .object({})
        .strict()
        .safeParse(request.body ?? {}).success
    ) {
      sendError(
        response,
        422,
        'invalid_project',
        'Project creation takes no input.',
      );
      return;
    }
    const project = await service.projects.create();
    response
      .status(202)
      .json({ ...project, ssh: { href: `/projects/${project.id}/ssh` } });
  });
  router.get('/', async (request, response) => {
    const input = pageInput.safeParse(request.query);
    if (!input.success) {
      sendError(response, 400, 'invalid_page', 'The page is invalid.');
      return;
    }
    response.json(
      await service.projects.list(input.data.limit, input.data.cursor),
    );
  });
  router.use('/:id', (request, response, next) => {
    if (!idInput.safeParse(request.params.id).success) {
      sendError(
        response,
        400,
        'invalid_project_id',
        'The project ID is invalid.',
      );
      return;
    }
    next();
  });
  router.get('/:id', async (request, response) => {
    const project = await service.projects.find(request.params.id);
    if (project === undefined) {
      missing(response, 'project');
      return;
    }
    response.json(project);
  });
  router.post('/:id/threads', async (request, response) => {
    const input = createInput.safeParse(request.body ?? {});
    if (!input.success) {
      sendError(
        response,
        422,
        'invalid_thread',
        'Only an optional parentThreadId is accepted.',
      );
      return;
    }
    const result = await service.threads.create(
      request.params.id,
      input.data.parentThreadId,
    );
    if (result.status === 'missing') {
      missing(response, 'project');
      return;
    }
    if (result.status !== 'created') {
      conflict(response, 'thread', result.status);
      return;
    }
    response.status(201).json(result.thread);
  });
  router.get('/:id/threads', async (request, response) => {
    const input = threadsInput.safeParse(request.query);
    if (!input.success) {
      sendError(response, 400, 'invalid_page', 'The page is invalid.');
      return;
    }
    const page = await service.threads.list(
      request.params.id,
      input.data.limit,
      input.data.cursor,
      input.data.parentThreadId,
    );
    if (page === undefined) {
      missing(response, 'project');
      return;
    }
    response.json(page);
  });
  router.get('/:id/ssh', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const access = await service.projects.ssh(request.params.id);
    if (access.status === 'missing') {
      missing(response, 'project');
      return;
    }
    if (access.status === 'pending') {
      response.set('Retry-After', '1').status(202).json({ status: 'pending' });
      return;
    }
    if (access.status === 'expired') {
      sendError(
        response,
        410,
        'project_ssh_expired',
        'SSH access has expired.',
      );
      return;
    }
    if (access.status !== 'ready') {
      conflict(response, 'project', 'ssh_unavailable');
      return;
    }
    response.json({
      ...access,
      href: `/vms/${encodeURIComponent(access.vmId)}/ssh`,
    });
  });
  router.post('/:id/terminate', async (request, response) => {
    const project = await service.projects.terminate(request.params.id);
    if (project === undefined) {
      missing(response, 'project');
      return;
    }
    response.json(project);
  });
  router.delete('/:id', async (request, response) => {
    const result = await service.projects.delete(request.params.id);
    if (result === 'missing') {
      missing(response, 'project');
      return;
    }
    if (result === 'active') {
      conflict(response, 'project', 'active');
      return;
    }
    response.status(204).end();
  });
  router.use(handleHttpError);
  return router;
};
