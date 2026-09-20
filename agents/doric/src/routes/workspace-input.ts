import type { RequestHandler, Response } from 'express';
import { z } from 'zod';

import { sendError } from '../lib/http/errors.js';

export const pageInput = z.object({
  limit: z.coerce.number().int().safe().positive().max(100).default(50),
  cursor: z.uuid().optional(),
});
export const idInput = z.uuid();
export const validateId =
  (kind: 'project' | 'thread'): RequestHandler =>
  (request, response, next) => {
    if (!idInput.safeParse(request.params.id).success) {
      sendError(
        response,
        400,
        `invalid_${kind}_id`,
        `The ${kind} ID is invalid.`,
      );
      return;
    }
    next();
  };
export const missing = (response: Response, kind: 'project' | 'thread') =>
  sendError(response, 404, `${kind}_not_found`, `The ${kind} was not found.`);
export const conflict = (
  response: Response,
  kind: 'project' | 'thread',
  reason: string,
) =>
  sendError(
    response,
    409,
    `${kind}_${reason}`,
    `The ${kind} cannot perform this operation.`,
  );
