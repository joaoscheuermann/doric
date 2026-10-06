import { Router } from 'express';
import { z } from 'zod';

import { handleHttpError, sendError } from '../lib/http/errors.js';
import type { WorkspaceService } from '../lib/workspace/types.js';
import { conflict, missing, nameInput, validateId } from './workspace-input.js';

/**
 * A working directory as a client may name it: absolute inside the sandbox, or
 * relative to the Thread's current directory the way `cd` reads it. What that
 * path may resolve to is the service's rule, not this input's.
 */
const cwdInput = z
  .string()
  .refine(
    (value) =>
      value.trim().length > 0 &&
      value.length <= 4096 &&
      value.includes('\0') === false,
  );
/** A patch changes the name, the working directory, or both. */
const threadInput = z
  .object({ name: nameInput.optional(), cwd: cwdInput.optional() })
  .strict()
  .refine((value) => value.name !== undefined || value.cwd !== undefined);
const promptInput = z
  .object({
    prompt: z.string().refine((value) => value.trim().length > 0),
  })
  .strict();
const interruptInput = z.object({ promptId: z.uuid() }).strict();
const editInput = z
  .object({
    text: z.string().refine((text) => text.trim().length > 0),
    revision: z.number().int().safe().nonnegative(),
  })
  .strict();
const resumeInput = z.object({ promptId: z.uuid() }).strict();
const rewindInput = z
  .object({
    promptId: z.uuid(),
    prompt: z.string().refine((value) => value.trim().length > 0),
  })
  .strict();
const eventsInput = z.object({
  afterSequence: z.coerce.number().int().safe().nonnegative().default(0),
});

/** What one refused working directory means, in one sentence per outcome. */
const cwdRefusal: Readonly<
  Record<'outside' | 'missing' | 'not-directory', string>
> = {
  outside: 'The working directory must stay inside the workspace.',
  missing: 'No such directory.',
  'not-directory': 'The working directory must be a directory.',
};

/** Human input cannot supply a privileged origin or delegation correlation. */
export const createThreadsRouter = (service: WorkspaceService): Router => {
  const router = Router();
  router.use('/:id', validateId('thread'));
  router.get('/:id/queue', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const queue = await service.threads.queue(request.params.id);
    if (queue === undefined) {
      missing(response, 'thread');
      return;
    }
    response.json(queue);
  });
  router.post('/:id/queue/resume', async (request, response) => {
    const result = await service.threads.resumeQueue(request.params.id);
    if (result.status === 'missing') {
      missing(response, 'thread');
      return;
    }
    if (result.status !== 'resumed') {
      conflict(response, 'thread', result.status);
      return;
    }
    response.json(result.thread);
  });
  router.delete('/:id/queue/:promptId', async (request, response) => {
    if (!z.uuid().safeParse(request.params.promptId).success) {
      sendError(response, 422, 'invalid_prompt', 'A promptId is required.');
      return;
    }
    const result = await service.threads.removeQueued(
      request.params.id,
      request.params.promptId,
    );
    if (result === 'missing') {
      missing(response, 'thread');
      return;
    }
    if (result !== 'removed') {
      conflict(response, 'thread', result);
      return;
    }
    response.status(204).end();
  });
  router.get('/:id/queue/:promptId', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    if (!z.uuid().safeParse(request.params.promptId).success) {
      sendError(response, 422, 'invalid_prompt', 'A promptId is required.');
      return;
    }
    const prompt = await service.threads.queuedPrompt(
      request.params.id,
      request.params.promptId,
    );
    if (prompt === undefined) {
      sendError(
        response,
        404,
        'unknown_prompt',
        'This prompt is no longer queued.',
      );
      return;
    }
    response.json(prompt);
  });
  router.patch('/:id/queue/:promptId', async (request, response) => {
    const input = editInput.safeParse(request.body);
    if (
      !input.success ||
      !z.uuid().safeParse(request.params.promptId).success
    ) {
      sendError(
        response,
        422,
        'invalid_prompt',
        'A prompt ID, non-empty text and its revision are required.',
      );
      return;
    }
    const result = await service.threads.editQueued(
      request.params.id,
      request.params.promptId,
      input.data.text,
      input.data.revision,
    );
    if (result.status === 'updated') {
      response.json(result.prompt);
      return;
    }
    const message =
      result.status === 'conflict'
        ? 'This prompt was edited elsewhere. Your changes have not been saved.'
        : result.status === 'not_editable'
          ? 'Only your prompts that have not started can be edited. Your changes have not been saved.'
          : 'This prompt is no longer available for editing. Your changes have not been saved.';
    sendError(
      response,
      result.status === 'missing' || result.status === 'unknown_prompt'
        ? 404
        : 409,
      result.status,
      message,
    );
  });
  router.get('/:id/usage', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const usage = await service.threads.usage(request.params.id);
    if (usage === undefined) {
      missing(response, 'thread');
      return;
    }
    response.json(usage);
  });
  router.patch('/:id', async (request, response) => {
    const input = threadInput.safeParse(request.body ?? {});
    if (!input.success) {
      sendError(
        response,
        422,
        'invalid_thread',
        'A Thread name, a working directory, or both are required.',
      );
      return;
    }
    const { name, cwd } = input.data;
    let thread;
    if (name !== undefined) {
      thread = await service.threads.rename(request.params.id, name);
      if (thread === undefined) {
        missing(response, 'thread');
        return;
      }
    }
    if (cwd !== undefined) {
      const result = await service.threads.setCwd(request.params.id, cwd);
      if (result.status === 'missing') {
        missing(response, 'thread');
        return;
      }
      if (result.status === 'inactive') {
        conflict(response, 'thread', 'inactive');
        return;
      }
      if (result.status === 'refused') {
        sendError(
          response,
          400,
          'invalid_cwd',
          cwdRefusal[result.change.status],
        );
        return;
      }
      thread = result.thread;
    }
    if (thread === undefined) {
      sendError(
        response,
        422,
        'invalid_thread',
        'A Thread change is required.',
      );
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
  router.post('/:id/resume', async (request, response) => {
    const input = resumeInput.safeParse(request.body);
    if (!input.success) {
      sendError(response, 422, 'invalid_resume', 'A promptId is required.');
      return;
    }
    const result = await service.threads.resume(
      request.params.id,
      input.data.promptId,
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
    if (result.status !== 'resumed') {
      conflict(response, 'thread', result.status);
      return;
    }
    response.status(202).json(result.thread);
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
  router.get('/:id/git', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const result = await service.threads.git(request.params.id);
    if (result.status === 'missing') {
      missing(response, 'thread');
      return;
    }
    if (result.status !== 'ready') {
      response.json({
        status: result.status === 'pending' ? 'pending' : 'unavailable',
      });
      return;
    }
    response.json(result.git);
  });
  router
    .route('/:id/branches')
    .get(async (request, response) => {
      response.set('Cache-Control', 'no-store');
      const result = await service.threads.branches(request.params.id);
      if (result.status === 'missing') {
        missing(response, 'thread');
        return;
      }
      if (result.status !== 'ready') {
        response.json({
          status: result.status === 'pending' ? 'pending' : 'unavailable',
        });
        return;
      }
      response.json(result.value);
    })
    .post(async (request, response) => {
      const input = z
        .object({
          branch: z
            .string()
            .min(1)
            .max(1024)
            .refine((value) => !value.includes('\0') && !value.startsWith('-')),
          cwd: cwdInput,
        })
        .strict()
        .safeParse(request.body);
      if (!input.success) {
        sendError(
          response,
          422,
          'invalid_branch',
          'An existing local branch name is required.',
        );
        return;
      }
      const result = await service.threads.branches(
        request.params.id,
        input.data.branch,
        input.data.cwd,
      );
      if (result.status === 'missing') {
        missing(response, 'thread');
        return;
      }
      if (result.status === 'refused') {
        sendError(response, 409, 'branch_refused', result.message);
        return;
      }
      if (result.status !== 'ready') {
        conflict(response, 'thread', 'inactive');
        return;
      }
      response.json(result.value);
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
