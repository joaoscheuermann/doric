import { Router } from 'express';
import { z } from 'zod';

import { sendError } from '../lib/http.js';
import type { SessionService } from '../lib/session-service.js';

const listInput = z.object({
  limit: z.coerce.number().int().safe().positive().max(100).default(50),
  cursor: z.uuid().optional(),
});
const idInput = z.object({ id: z.uuid() });

const promptInput = z
  .object({
    prompt: z.string().refine((value) => value.trim().length > 0),
  })
  .strict();

const eventsInput = z.object({
  afterSequence: z.coerce.number().int().safe().nonnegative().default(0),
});

/** Exposes long-lived Direct sessions, FIFO prompts, and durable event history. */
export const createSessionsRouter = (service: SessionService): Router => {
  const router = Router();

  router.post('/', async (_request, response) => {
    const session = await service.create();

    response.status(202).json({
      ...session,
      ssh: { href: `/sessions/${session.id}/ssh` },
    });
  });

  router.get('/', async (request, response) => {
    const parsed = listInput.safeParse(request.query);

    if (!parsed.success) {
      sendError(response, 400, 'invalid_page', 'The session page is invalid.');

      return;
    }

    response.json(await service.list(parsed.data.limit, parsed.data.cursor));
  });

  router.get('/:id', async (request, response) => {
    const parsed = idInput.safeParse(request.params);

    if (!parsed.success) {
      invalidId(response);

      return;
    }

    const session = await service.find(parsed.data.id);

    if (session === undefined) {
      missing(response);

      return;
    }

    response.json(session);
  });

  router.post('/:id/prompt', async (request, response) => {
    const id = idInput.safeParse(request.params);

    if (!id.success) {
      invalidId(response);

      return;
    }

    const input = promptInput.safeParse(request.body);

    if (!input.success) {
      sendError(
        response,
        422,
        'invalid_prompt',
        'A non-empty prompt is required.',
      );

      return;
    }

    const result = await service.prompt(id.data.id, input.data.prompt);

    if (result.status === 'missing') {
      missing(response);

      return;
    }

    if (result.status === 'inactive') {
      sendError(
        response,
        409,
        'session_inactive',
        'The session no longer accepts prompts.',
      );

      return;
    }

    response.status(202).json({ promptId: result.promptId });
  });

  router.get('/:id/ssh', async (request, response) => {
    response.set('Cache-Control', 'no-store');

    const parsed = idInput.safeParse(request.params);

    if (!parsed.success) {
      invalidId(response);

      return;
    }

    const access = await service.ssh(parsed.data.id);

    if (access.status === 'pending') {
      response.set('Retry-After', '1').status(202).json({ status: 'pending' });

      return;
    }

    if (access.status === 'missing') {
      missing(response);

      return;
    }

    if (access.status === 'expired') {
      sendError(
        response,
        410,
        'session_ssh_expired',
        'SSH access for this session has expired.',
      );

      return;
    }

    if (access.status === 'unavailable') {
      sendError(
        response,
        409,
        'session_ssh_unavailable',
        'SSH is unavailable for this session.',
      );

      return;
    }

    response.json({
      ...access,
      href: `/vms/${encodeURIComponent(access.vmId)}/ssh`,
    });
  });

  router.get('/:id/events', async (request, response) => {
    response.set('Cache-Control', 'no-store');

    const id = idInput.safeParse(request.params);

    if (!id.success) {
      invalidId(response);

      return;
    }

    const query = eventsInput.safeParse(request.query);

    if (!query.success) {
      sendError(
        response,
        400,
        'invalid_event_cursor',
        'The event cursor is invalid.',
      );

      return;
    }

    const events = await service.events(id.data.id, query.data.afterSequence);

    if (events === undefined) {
      missing(response);

      return;
    }

    response.json(events);
  });

  router.post('/:id/terminate', async (request, response) => {
    const parsed = idInput.safeParse(request.params);

    if (!parsed.success) {
      invalidId(response);

      return;
    }

    const session = await service.terminate(parsed.data.id);

    if (session === undefined) {
      missing(response);

      return;
    }

    response.json(session);
  });

  router.delete('/:id', async (request, response) => {
    const parsed = idInput.safeParse(request.params);

    if (!parsed.success) {
      invalidId(response);

      return;
    }

    const outcome = await service.delete(parsed.data.id);

    if (outcome === 'missing') {
      missing(response);

      return;
    }

    if (outcome === 'active') {
      sendError(
        response,
        409,
        'session_active',
        'Active sessions cannot be deleted.',
      );

      return;
    }

    response.status(204).end();
  });

  return router;
};

const invalidId = (response: Parameters<typeof sendError>[0]) =>
  sendError(response, 400, 'invalid_session_id', 'The session ID is invalid.');

const missing = (response: Parameters<typeof sendError>[0]) =>
  sendError(response, 404, 'session_not_found', 'The session was not found.');
