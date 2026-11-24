import { Router } from 'express';

import { sendAnswer } from '../api/answer.js';
import { terminalOperations } from '../api/operations/terminals.js';
import type { TransportPorts } from '../api/ports.js';
import { routeInput } from './input.js';

/**
 * Ephemeral terminal data is never cached or stored in conversation events.
 * The bodies are `terminalOperations`.
 */
export const createTerminalsRouter = (
  terminal: TransportPorts['terminal'],
): Router => {
  const router = Router();
  const operations = terminalOperations({ terminal });
  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/projects/:id/terminals', async (request, response) => {
    sendAnswer(response, await operations.list(routeInput(request)));
  });
  router.post('/threads/:id/terminals', async (request, response) => {
    sendAnswer(response, await operations.create(routeInput(request)));
  });
  router.get('/terminals/:id', async (request, response) => {
    sendAnswer(response, await operations.snapshot(routeInput(request)));
  });
  router.post('/terminals/:id/input', async (request, response) => {
    sendAnswer(response, await operations.input(routeInput(request)));
  });
  router.post('/terminals/:id/resize', async (request, response) => {
    sendAnswer(response, await operations.resize(routeInput(request)));
  });
  router.delete('/terminals/:id', async (request, response) => {
    sendAnswer(response, await operations.stop(routeInput(request)));
  });
  return router;
};
