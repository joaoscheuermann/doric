import { type Response, Router } from 'express';
import {
  type ProjectLeaseState,
  projectColors,
  type Runtime,
  type RuntimeLease,
  type RuntimeThreads,
} from 'runtime/contracts';
import { z } from 'zod';

import { handleHttpError, sendError } from '../errors.js';
import type { LeaseScope } from '../services.js';
import {
  conflict,
  missing,
  nameInput,
  pageInput,
  validateId,
} from './input.js';

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
/** An optional query path as a lease read takes it: absent stays absent. */
const pathOf = (path: string | undefined) =>
  path === undefined ? {} : { path };

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
export const createProjectsRouter = ({
  runtime,
  threads,
  lease,
}: {
  readonly runtime: Runtime;
  readonly threads: RuntimeThreads;
  readonly lease: (scope: LeaseScope) => RuntimeLease;
}): Router => {
  const router = Router();
  const projectLease = (projectId: string) => lease({ projectId });
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
    const project = await runtime.createProject({ name: input.data.name });
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
      await runtime.projects({
        limit: input.data.limit,
        ...(input.data.cursor === undefined
          ? {}
          : { cursor: input.data.cursor }),
      }),
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
    const project = await runtime.renameProject({
      id: request.params.id,
      name: input.data.name,
    });
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
    const project = await runtime.setProjectColor({
      id: request.params.id,
      color: input.data.color,
    });
    if (project === undefined) {
      missing(response, 'project');
      return;
    }
    response.json(project);
  });
  router.get('/:id', async (request, response) => {
    const project = await runtime.project(request.params.id);
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
    const result = await threads.createThread({
      projectId: request.params.id,
      name: input.data.name,
      ...(input.data.parentThreadId === undefined
        ? {}
        : { parentThreadId: input.data.parentThreadId }),
    });
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
    const page = await threads.threads({
      projectId: request.params.id,
      limit: input.data.limit,
      ...(input.data.cursor === undefined ? {} : { cursor: input.data.cursor }),
      ...(input.data.parentThreadId === undefined
        ? {}
        : { parentThreadId: input.data.parentThreadId }),
    });
    if (page === undefined) {
      missing(response, 'project');
      return;
    }
    response.json(page);
  });
  router.get('/:id/ssh', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const access = await projectLease(request.params.id).ssh();
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
    const result = await projectLease(request.params.id).files(
      pathOf(input.data.path),
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
  router.get('/:id/resources', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const result = await projectLease(request.params.id).resources();
    if (leaseResponse(response, result.status)) return;
    if (result.status === 'ready') {
      response.json(result.container);
      return;
    }
    conflict(response, 'project', 'resources_unavailable');
  });
  router.get('/:id/tree', async (request, response) => {
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
    const result = await projectLease(request.params.id).tree(
      pathOf(input.data.path),
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
    const result = await projectLease(request.params.id).file({
      path: input.data,
    });
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
    const result = await projectLease(request.params.id).diff(
      pathOf(input.data.path),
    );
    if (leaseResponse(response, result.status)) return;
    if (result.status === 'ready') {
      response.json({
        ...(result.path === undefined ? {} : { path: result.path }),
        repositories: result.repositories,
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
  router.get('/:id/changes', async (request, response) => {
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
    const result = await projectLease(request.params.id).changes(
      pathOf(input.data.path),
    );
    if (leaseResponse(response, result.status)) return;
    if (result.status === 'ready') {
      response.json({
        ...(result.path === undefined ? {} : { path: result.path }),
        repositories: result.repositories,
      });
      return;
    }
    sendError(
      response,
      result.status === 'not_found' ? 404 : 422,
      result.status === 'not_found'
        ? 'project_path_not_found'
        : 'invalid_project_path',
      'The Project path cannot be read.',
    );
  });
  router.get('/:id/files/diff', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const input = z
      .object({ repository: pathInput, path: pathInput.min(1) })
      .safeParse(request.query);
    if (!input.success) {
      sendError(
        response,
        422,
        'invalid_project_path',
        'The Project path is invalid.',
      );
      return;
    }
    const result = await projectLease(request.params.id).fileDiff({
      repository: input.data.repository,
      path: input.data.path,
    });
    if (leaseResponse(response, result.status)) return;
    if (result.status === 'ready') {
      response.json(result.diff);
      return;
    }
    sendError(
      response,
      result.status === 'not_found' ? 404 : 422,
      result.status === 'not_found'
        ? 'project_path_not_found'
        : 'invalid_project_path',
      'The changed file cannot be read.',
    );
  });
  router.post('/:id/terminate', async (request, response) => {
    const project = await runtime.terminateProject(request.params.id);
    if (project === undefined) {
      missing(response, 'project');
      return;
    }
    response.json(project);
  });
  router.delete('/:id', async (request, response) => {
    const result = await runtime.deleteProject(request.params.id);
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
