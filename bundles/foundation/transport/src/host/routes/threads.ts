import { Router } from 'express';

import { sendAnswer } from '../api/answer.js';
import { threadOperations } from '../api/operations/threads.js';
import type { TransportPorts } from '../api/ports.js';
import { handleHttpError } from '../errors.js';
import { routeInput, validateId } from './input.js';

/** The `/threads` routes; the bodies are `threadOperations`. */
export const createThreadsRouter = (
  ports: Pick<TransportPorts, 'threads' | 'git' | 'usage'>,
): Router => {
  const router = Router();
  const operations = threadOperations(ports);
  router.use('/:id', validateId('thread'));
  router.get('/:id/queue', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    sendAnswer(response, await operations.queue(routeInput(request)));
  });
  router.post('/:id/queue/resume', async (request, response) => {
    sendAnswer(response, await operations.resumeQueue(routeInput(request)));
  });
  router.delete('/:id/queue/:promptId', async (request, response) => {
    sendAnswer(response, await operations.removeQueued(routeInput(request)));
  });
  router.get('/:id/queue/:promptId', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    sendAnswer(response, await operations.queuedPrompt(routeInput(request)));
  });
  router.patch('/:id/queue/:promptId', async (request, response) => {
    sendAnswer(response, await operations.editQueued(routeInput(request)));
  });
  router.get('/:id/usage', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    sendAnswer(response, await operations.usage(routeInput(request)));
  });
  router.patch('/:id', async (request, response) => {
    sendAnswer(response, await operations.update(routeInput(request)));
  });
  router.get('/:id', async (request, response) => {
    sendAnswer(response, await operations.get(routeInput(request)));
  });
  router.post('/:id/prompt', async (request, response) => {
    sendAnswer(response, await operations.prompt(routeInput(request)));
  });
  router.post('/:id/steer', async (request, response) => {
    sendAnswer(response, await operations.steer(routeInput(request)));
  });
  router.post('/:id/resume', async (request, response) => {
    sendAnswer(response, await operations.resume(routeInput(request)));
  });
  router.post('/:id/rewind', async (request, response) => {
    sendAnswer(response, await operations.rewind(routeInput(request)));
  });
  router.post('/:id/compact', async (request, response) => {
    sendAnswer(response, await operations.compact(routeInput(request)));
  });
  router.get('/:id/events', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    sendAnswer(response, await operations.events(routeInput(request)));
  });
  router.get('/:id/git', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    sendAnswer(response, await operations.git(routeInput(request)));
  });
  router
    .route('/:id/branches')
    .get(async (request, response) => {
      response.set('Cache-Control', 'no-store');
      sendAnswer(response, await operations.branches(routeInput(request)));
    })
    .post(async (request, response) => {
      sendAnswer(response, await operations.switchBranch(routeInput(request)));
    });
  router.post('/:id/interrupt', async (request, response) => {
    sendAnswer(response, await operations.interrupt(routeInput(request)));
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
