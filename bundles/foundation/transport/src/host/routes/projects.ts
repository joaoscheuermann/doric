import { Router } from 'express';

import { sendAnswer } from '../api/answer.js';
import { projectOperations } from '../api/operations/projects.js';
import type { TransportPorts } from '../api/ports.js';
import { handleHttpError } from '../errors.js';
import { routeInput, validateId } from './input.js';

/** The `/projects` routes; the bodies are `projectOperations`. */
export const createProjectsRouter = (
  ports: Pick<
    TransportPorts,
    'runtime' | 'threads' | 'lease' | 'files' | 'git' | 'resources'
  >,
): Router => {
  const router = Router();
  const operations = projectOperations(ports);
  router.post('/', async (request, response) => {
    sendAnswer(response, await operations.create(routeInput(request)));
  });
  router.get('/', async (request, response) => {
    sendAnswer(response, await operations.list(routeInput(request)));
  });
  router.use('/:id', validateId('project'));
  router.patch('/:id', async (request, response) => {
    sendAnswer(response, await operations.rename(routeInput(request)));
  });
  router.patch('/:id/color', async (request, response) => {
    sendAnswer(response, await operations.setColor(routeInput(request)));
  });
  router.get('/:id', async (request, response) => {
    sendAnswer(response, await operations.get(routeInput(request)));
  });
  router.post('/:id/threads', async (request, response) => {
    sendAnswer(response, await operations.createThread(routeInput(request)));
  });
  router.get('/:id/threads', async (request, response) => {
    sendAnswer(response, await operations.listThreads(routeInput(request)));
  });
  router.get('/:id/ssh', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    sendAnswer(response, await operations.ssh(routeInput(request)));
  });
  router.get('/:id/files', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    sendAnswer(response, await operations.files(routeInput(request)));
  });
  router.get('/:id/resources', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    sendAnswer(response, await operations.resources(routeInput(request)));
  });
  router.get('/:id/tree', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    sendAnswer(response, await operations.tree(routeInput(request)));
  });
  router.get('/:id/files/content', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    sendAnswer(response, await operations.content(routeInput(request)));
  });
  router.get('/:id/diff', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    sendAnswer(response, await operations.diff(routeInput(request)));
  });
  router.get('/:id/changes', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    sendAnswer(response, await operations.changes(routeInput(request)));
  });
  router.get('/:id/files/diff', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    sendAnswer(response, await operations.fileDiff(routeInput(request)));
  });
  router.post('/:id/terminate', async (request, response) => {
    sendAnswer(response, await operations.terminate(routeInput(request)));
  });
  router.delete('/:id', async (request, response) => {
    sendAnswer(response, await operations.remove(routeInput(request)));
  });
  router.use(handleHttpError);
  return router;
};
