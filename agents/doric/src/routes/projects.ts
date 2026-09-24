import { type Response, Router } from 'express';
import { z } from 'zod';

import { handleHttpError, sendError } from '../lib/http/errors.js';
import { projectColors } from '../lib/workspace/colors.js';
import type {
  ProjectLeaseState,
  WorkspaceService,
} from '../lib/workspace/types.js';
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
const pathInput = z
  .string()
  .max(4096)
  .refine((value) => !value.includes('\u0000'));
const pathQuery = z.object({ path: pathInput.optional() });

/** The lease-dependent statuses every Project file subresource reports. */
const leaseStates = new Set<ProjectLeaseState>([
  'missing',
  'pending',
  'unavailable',
  'expired',
]);

/** Answers the shared lease statuses; returns true once it has responded. */
const leaseResponse = (response: Response, status: string): boolean => {
  if (!leaseStates.has(status as ProjectLeaseState)) return false;
  if (status === 'missing') {
    missing(response, 'project');
    return true;
  }
  if (status === 'pending') {
    response.set('Retry-After', '1').status(202).json({ status: 'pending' });
    return true;
  }
  if (status === 'expired') {
    sendError(
      response,
      410,
      'project_files_expired',
      'The Project file access has expired.',
    );
    return true;
  }
  conflict(response, 'project', 'files_unavailable');
  return true;
};

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
  router.get('/:id/files', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const input = pathQuery.safeParse(request.query);
    if (!input.success) {
      sendError(
        response,
        422,
        'invalid_project_path',
        'The Project path is invalid.',
      );
      return;
    }
    const result = await service.projects.files(
      request.params.id,
      input.data.path,
    );
    if (leaseResponse(response, result.status)) return;
    if (result.status === 'ready') {
      response.json({ path: result.path, entries: result.entries });
      return;
    }
    if (result.status === 'not_found') {
      sendError(
        response,
        404,
        'project_path_not_found',
        'The Project path was not found.',
      );
      return;
    }
    sendError(
      response,
      422,
      'invalid_project_path',
      'The Project path is not a directory.',
    );
  });
  router.get('/:id/files/content', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const input = pathInput.safeParse(request.query.path);
    if (!input.success) {
      sendError(
        response,
        422,
        'invalid_project_path',
        'The Project path is invalid.',
      );
      return;
    }
    const result = await service.projects.file(request.params.id, input.data);
    if (leaseResponse(response, result.status)) return;
    if (result.status === 'ready') {
      response.json({
        path: result.path,
        content: result.content,
        truncated: result.truncated,
        binary: result.binary,
      });
      return;
    }
    if (result.status === 'not_found') {
      sendError(
        response,
        404,
        'project_path_not_found',
        'The Project path was not found.',
      );
      return;
    }
    sendError(
      response,
      422,
      'invalid_project_path',
      'The Project path is not a readable file.',
    );
  });
  router.get('/:id/diff', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const input = pathQuery.safeParse(request.query);
    if (!input.success) {
      sendError(
        response,
        422,
        'invalid_project_path',
        'The Project path is invalid.',
      );
      return;
    }
    const result = await service.projects.diff(
      request.params.id,
      input.data.path,
    );
    if (leaseResponse(response, result.status)) return;
    if (result.status === 'ready') {
      response.json({
        ...(result.path === undefined ? {} : { path: result.path }),
        repository: result.repository,
        diff: result.diff,
        changes: result.changes,
      });
      return;
    }
    if (result.status === 'not_found') {
      sendError(
        response,
        404,
        'project_path_not_found',
        'The Project path was not found.',
      );
      return;
    }
    sendError(
      response,
      422,
      'invalid_project_path',
      'The Project path is invalid.',
    );
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
