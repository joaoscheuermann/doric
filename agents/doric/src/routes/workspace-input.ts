import type { RequestHandler, Response } from 'express';
import { z } from 'zod';

import { sendError } from '../lib/http/errors.js';
import { isValidName, normalizeName } from '../lib/workspace/names.js';

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
export const missing = (response: Response, kind: Resource) =>
  sendError(response, 404, `${kind}_not_found`, `The ${kind} was not found.`);
export const conflict = (response: Response, kind: Resource, reason: string) =>
  sendError(
    response,
    409,
    `${kind}_${reason}`,
    `The ${kind} cannot perform this operation.`,
  );
