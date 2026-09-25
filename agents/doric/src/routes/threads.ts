import { Router } from 'express';
import { z } from 'zod';

import { handleHttpError, sendError } from '../lib/http/errors.js';
import type { WorkspaceService } from '../lib/workspace/types.js';
import { conflict, missing, nameInput, validateId } from './workspace-input.js';

const threadInput = z.object({ name: nameInput }).strict();
const promptInput = z
  .object({
    prompt: z.string().refine((value) => value.trim().length > 0),
  })
  .strict();
const interruptInput = z.object({ promptId: z.uuid() }).strict();
const rewindInput = z
  .object({
    promptId: z.uuid(),
    prompt: z.string().refine((value) => value.trim().length > 0),
  })
  .strict();
const eventsInput = z.object({
  afterSequence: z.coerce.number().int().safe().nonnegative().default(0),
});

/** Human input cannot supply a privileged origin or delegation correlation. */
export const createThreadsRouter = (service: WorkspaceService): Router => {
  const router = Router();
  router.use('/:id', validateId('thread'));
  router.patch('/:id', async (request, response) => {
    const input = threadInput.safeParse(request.body ?? {});
    if (!input.success) {
      sendError(
        response,
        422,
        'invalid_thread',
        'A Thread name between 1 and 80 characters is required.',
      );
      return;
    }
    const thread = await service.threads.rename(
      request.params.id,
      input.data.name,
    );
    if (thread === undefined) {
      missing(response, 'thread');
      return;
    }
    response.json(thread);
  });
  router.get('/:id', async (request, response) => {
    const thread = await service.threads.find(request.params.id);
    if (thread === undefined) {
      missing(response, 'thread');
      return;
    }
    response.json(thread);
  });
  router.post('/:id/prompt', async (request, response) => {
    const input = promptInput.safeParse(request.body);
    if (!input.success) {
      sendError(
        response,
        422,
        'invalid_prompt',
        'Only a non-empty prompt is accepted.',
      );
      return;
    }
    const result = await service.threads.prompt(
      request.params.id,
      input.data.prompt,
    );
    if (result.status === 'missing') {
      missing(response, 'thread');
      return;
    }
    if (result.status !== 'accepted') {
      conflict(response, 'thread', 'inactive');
      return;
    }
    response.status(202).json({ promptId: result.promptId });
  });
  router.post('/:id/rewind', async (request, response) => {
    const input = rewindInput.safeParse(request.body);
    if (!input.success) {
      sendError(
        response,
        422,
        'invalid_rewind',
        'A prompt ID and a non-empty prompt are required.',
      );
      return;
    }
    const result = await service.threads.rewind(
      request.params.id,
      input.data.promptId,
      input.data.prompt,
    );
    if (result.status === 'missing') {
      missing(response, 'thread');
      return;
    }
    if (result.status === 'unknown_prompt') {
      sendError(
        response,
        404,
        'prompt_not_found',
        'The prompt was not found in this Thread.',
      );
      return;
    }
    if (result.status === 'busy') {
      sendError(
        response,
        409,
        'thread_busy',
        'The Thread is running or has queued input and cannot be rewound.',
      );
      return;
    }
    if (result.status !== 'accepted') {
      conflict(response, 'thread', 'inactive');
      return;
    }
    response.status(202).json({ promptId: result.promptId });
  });
  router.get('/:id/events', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const input = eventsInput.safeParse(request.query);
    if (!input.success) {
      sendError(
        response,
        400,
        'invalid_event_cursor',
        'The event cursor is invalid.',
      );
      return;
    }
    const events = await service.threads.events(
      request.params.id,
      input.data.afterSequence,
    );
    if (events === undefined) {
      missing(response, 'thread');
      return;
    }
    response.json(events);
  });
  router.post('/:id/interrupt', async (request, response) => {
    const input = interruptInput.safeParse(request.body);
    if (!input.success) {
      sendError(response, 422, 'invalid_interrupt', 'A promptId is required.');
      return;
    }
    const result = await service.threads.interrupt(
      request.params.id,
      input.data.promptId,
    );
    if (result === 'missing') {
      missing(response, 'thread');
      return;
    }
    if (result !== 'interrupted') {
      conflict(response, 'thread', result);
      return;
    }
    response.json({ status: result });
  });
  router.post('/:id/terminate', async (request, response) => {
    const thread = await service.threads.terminate(request.params.id);
    if (thread === undefined) {
      missing(response, 'thread');
      return;
    }
    response.json(thread);
  });
  router.delete('/:id', async (request, response) => {
    const result = await service.threads.delete(request.params.id);
    if (result === 'missing') {
      missing(response, 'thread');
      return;
    }
    if (result === 'active') {
      conflict(response, 'thread', 'active');
      return;
    }
    response.status(204).end();
  });
  router.use(handleHttpError);
  return router;
};
