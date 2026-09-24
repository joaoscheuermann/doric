import { Router } from 'express';
import { z } from 'zod';

import { handleHttpError, sendError } from '../lib/http/errors.js';
import { projectColors } from '../lib/workspace/colors.js';
import type { WorkspaceService } from '../lib/workspace/types.js';
import {
  conflict,
  missing,
  nameInput,
  pageInput,
  validateId,
} from './workspace-input.js';

const projectInput = z.object({ name: nameInput }).strict();
const projectColorInput = z
  .object({ color: z.enum([...projectColors]).nullable() })
  .strict();
const createInput = z
  .object({ name: nameInput, parentThreadId: z.uuid().optional() })
  .strict();
const threadsInput = pageInput.extend({ parentThreadId: z.uuid().optional() });

/** Project creation reserves an environment; conversations are created separately. */
export const createProjectsRouter = (service: WorkspaceService): Router => {
  const router = Router();
  router.post('/', async (request, response) => {
    const input = projectInput.safeParse(request.body ?? {});
    if (!input.success) {
      sendError(
        response,
        422,
        'invalid_project',
        'A Project name between 1 and 80 characters is required.',
      );
      return;
    }
    const project = await service.projects.create(input.data.name);
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
  router.use('/:id', validateId('project'));
  router.patch('/:id', async (request, response) => {
    const input = projectInput.safeParse(request.body ?? {});
    if (!input.success) {
      sendError(
        response,
        422,
        'invalid_project',
        'A Project name between 1 and 80 characters is required.',
      );
      return;
    }
    const project = await service.projects.rename(
      request.params.id,
      input.data.name,
    );
    if (project === undefined) {
      missing(response, 'project');
      return;
    }
    response.json(project);
  });
  router.patch('/:id/color', async (request, response) => {
    const input = projectColorInput.safeParse(request.body ?? {});
    if (!input.success) {
      sendError(
        response,
        422,
        'invalid_project_color',
        'A Project color from the palette, or null, is required.',
      );
      return;
    }
    const project = await service.projects.setColor(
      request.params.id,
      input.data.color ?? undefined,
    );
    if (project === undefined) {
      missing(response, 'project');
      return;
    }
    response.json(project);
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
        'A Thread name between 1 and 80 characters and optional parentThreadId are accepted.',
      );
      return;
    }
    const result = await service.threads.create(
      request.params.id,
      input.data.name,
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
