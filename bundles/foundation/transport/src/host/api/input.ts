import { isValidName, normalizeName, type RestError } from 'runtime/contracts';
import { z } from 'zod';

import type { ApiAnswer } from './answer.js';

export const pageInput = z.object({
  limit: z.coerce.number().int().safe().positive().max(100).default(50),
  cursor: z.uuid().optional(),
});
export const nameInput = z
  .string()
  .transform(normalizeName)
  .refine(isValidName);
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
