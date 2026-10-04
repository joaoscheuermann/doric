import { Router } from 'express';
import { z } from 'zod';

import { sendError } from '../lib/http/errors.js';
import type { WorkspaceService } from '../lib/workspace/types.js';

const size = z
  .object({
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  })
  .strict();
/** Ephemeral terminal data is never cached or stored in conversation events. */
export const createTerminalsRouter = (service: WorkspaceService): Router => {
  const router = Router();
  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/projects/:id/terminals', (request, response) => {
    response.json({ items: service.terminals.list(request.params.id) });
  });
  router.post('/threads/:id/terminals', async (request, response) => {
    const input = size.partial().safeParse(request.body ?? {});
    if (!input.success) {
      sendError(
        response,
        422,
        'invalid_terminal',
        'Invalid terminal dimensions.',
      );
      return;
    }
    const terminal = await service.terminals.create(
      request.params.id,
      input.data.cols,
      input.data.rows,
    );
    if (terminal === undefined) {
      sendError(
        response,
        409,
        'terminal_unavailable',
        'The Thread has no active sandbox.',
      );
      return;
    }
    response.status(201).json(terminal);
  });
  router.get('/terminals/:id', (request, response) => {
    const after = z.coerce
      .number()
      .int()
      .safe()
      .nonnegative()
      .default(0)
      .safeParse(request.query.after);
    if (!after.success) {
      sendError(response, 422, 'invalid_cursor', 'Invalid output cursor.');
      return;
    }
    const result = service.terminals.snapshot(request.params.id, after.data);
    if (result === undefined) {
      sendError(
        response,
        404,
        'terminal_missing',
        'Terminal no longer exists.',
      );
      return;
    }
    response.json(result);
  });
  router.post('/terminals/:id/input', async (request, response) => {
    const input = z
      .object({ data: z.string().max(65536) })
      .strict()
      .safeParse(request.body);
    if (!input.success) {
      sendError(response, 422, 'invalid_input', 'Invalid terminal input.');
      return;
    }
    if (!(await service.terminals.input(request.params.id, input.data.data))) {
      sendError(
        response,
        404,
        'terminal_missing',
        'Terminal no longer exists.',
      );
      return;
    }
    response.status(204).end();
  });
  router.post('/terminals/:id/resize', async (request, response) => {
    const input = size.safeParse(request.body);
    if (!input.success) {
      sendError(response, 422, 'invalid_size', 'Invalid terminal dimensions.');
      return;
    }
    if (
      !(await service.terminals.resize(
        request.params.id,
        input.data.cols,
        input.data.rows,
      ))
    ) {
      sendError(
        response,
        404,
        'terminal_missing',
        'Terminal no longer exists.',
      );
      return;
    }
    response.status(204).end();
  });
  router.delete('/terminals/:id', async (request, response) => {
    await service.terminals.stop(request.params.id);
    response.status(204).end();
  });
  return router;
};
