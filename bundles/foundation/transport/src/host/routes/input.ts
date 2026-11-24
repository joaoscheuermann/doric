import type { Request, RequestHandler } from 'express';
import { isValidName, normalizeName, type RestError } from 'runtime/contracts';
import { z } from 'zod';

import type { ApiAnswer, RouteInput } from '../api/answer.js';
import { sendError } from '../errors.js';

export const pageInput = z.object({
  limit: z.coerce.number().int().safe().positive().max(100).default(50),
  cursor: z.uuid().optional(),
});
export const nameInput = z
  .string()
  .transform(normalizeName)
  .refine(isValidName);
export const idInput = z.uuid();
/** The named resources whose routes answer the same validation and conflict shape. */
type Resource = 'project' | 'thread' | 'credential';
export const validateId =
  (kind: Resource): RequestHandler =>
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
/** What a route body reads from an Express request (its named path parameters are strings). */
export const routeInput = (request: Request): RouteInput => ({
  params: Object.fromEntries(
    Object.entries(request.params).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  ),
  query: request.query,
  body: request.body,
});
/** A route body's success: `value` with today's `status`. */
export const ok = <T>(
  value: T,
  status: 200 | 201 | 202 | 204 = 200,
): ApiAnswer<T> => ({ kind: 'ok', status, value });
/** A route body's refusal: `error`'s status, code and message. */
export const refused = (error: RestError): ApiAnswer<never> => ({
  kind: 'refused',
  error,
});
