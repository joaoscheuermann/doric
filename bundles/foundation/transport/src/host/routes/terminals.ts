import { Router } from 'express';
import type { TerminalService } from 'terminal/contracts';
import { z } from 'zod';

import { sendError } from '../errors.js';

const size = z
  .object({
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  })
  .strict();
/**
 * Ephemeral terminal data is never cached or stored in conversation events.
 * The sessions are the `terminal` bundle's (`terminal/v1` 1.1.0, stage 10 §4).
 */
export const createTerminalsRouter = (terminals: TerminalService): Router => {
  const router = Router();
  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/projects/:id/terminals', async (request, response) => {
    response.json({ items: await terminals.list(request.params.id) });
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
    const terminal = await terminals.create(request.params.id, {
      ...(input.data.cols === undefined ? {} : { cols: input.data.cols }),
      ...(input.data.rows === undefined ? {} : { rows: input.data.rows }),
    });
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
  router.get('/terminals/:id', async (request, response) => {
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
    const result = await terminals.snapshot(request.params.id, after.data);
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
    if (!(await terminals.input(request.params.id, input.data.data))) {
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
      !(await terminals.resize(
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
    await terminals.stop(request.params.id);
    response.status(204).end();
  });
  return router;
};
