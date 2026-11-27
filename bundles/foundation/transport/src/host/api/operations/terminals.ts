import type { RestError } from 'runtime/contracts';
import type { TerminalSession, TerminalSnapshot } from 'terminal/contracts';
import { z } from 'zod';

import type { ApiAnswer, RouteInput } from '../answer.js';
import { ok, refused } from '../input.js';
import type { TransportPorts } from '../ports.js';

type Op<V> = (input: RouteInput) => Promise<ApiAnswer<V>>;

const size = z
  .object({
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  })
  .strict();

const terminalMissing: RestError = {
  status: 404,
  code: 'terminal_missing',
  message: 'Terminal no longer exists.',
};

/**
 * The terminal route bodies over the ports. The sessions are the `terminal`
 * bundle's (`terminal/v1` 1.1.0, stage 10 §4).
 */
export const terminalOperations = ({
  terminal: terminals,
}: Pick<TransportPorts, 'terminal'>): {
  /** `GET /projects/:id/terminals`. */
  readonly list: Op<{ readonly items: readonly TerminalSession[] }>;
  /** `POST /threads/:id/terminals` → 201. */
  readonly create: Op<TerminalSession>;
  /** `GET /terminals/:id`. */
  readonly snapshot: Op<TerminalSnapshot>;
  /** `POST /terminals/:id/input` → 204. */
  readonly input: Op<undefined>;
  /** `POST /terminals/:id/resize` → 204. */
  readonly resize: Op<undefined>;
  /** `DELETE /terminals/:id` → 204. */
  readonly stop: Op<undefined>;
} => ({
  list: async ({ params }) =>
    ok({ items: await terminals.list(params.id ?? '') }),
  create: async ({ params, body }) => {
    const input = size.partial().safeParse(body ?? {});
    if (!input.success) {
      return refused({
        status: 422,
        code: 'invalid_terminal',
        message: 'Invalid terminal dimensions.',
      });
    }
    const terminal = await terminals.create(params.id ?? '', {
      ...(input.data.cols === undefined ? {} : { cols: input.data.cols }),
      ...(input.data.rows === undefined ? {} : { rows: input.data.rows }),
    });
    if (terminal === undefined) {
      return refused({
        status: 409,
        code: 'terminal_unavailable',
        message: 'The Thread has no active sandbox.',
      });
    }
    return ok(terminal, 201);
  },
  snapshot: async ({ params, query }) => {
    const after = z.coerce
      .number()
      .int()
      .safe()
      .nonnegative()
      .default(0)
      .safeParse((query as { readonly after?: unknown }).after);
    if (!after.success) {
      return refused({
        status: 422,
        code: 'invalid_cursor',
        message: 'Invalid output cursor.',
      });
    }
    const result = await terminals.snapshot(params.id ?? '', after.data);
    if (result === undefined) return refused(terminalMissing);
    return ok(result);
  },
  input: async ({ params, body }) => {
    const input = z
      .object({ data: z.string().max(65536) })
      .strict()
      .safeParse(body);
    if (!input.success) {
      return refused({
        status: 422,
        code: 'invalid_input',
        message: 'Invalid terminal input.',
      });
    }
    if (!(await terminals.input(params.id ?? '', input.data.data))) {
      return refused(terminalMissing);
    }
    return ok(undefined, 204);
  },
  resize: async ({ params, body }) => {
    const input = size.safeParse(body);
    if (!input.success) {
      return refused({
        status: 422,
        code: 'invalid_size',
        message: 'Invalid terminal dimensions.',
      });
    }
    if (
      !(await terminals.resize(
        params.id ?? '',
        input.data.cols,
        input.data.rows,
      ))
    ) {
      return refused(terminalMissing);
    }
    return ok(undefined, 204);
  },
  stop: async ({ params }) => {
    await terminals.stop(params.id ?? '');
    return ok(undefined, 204);
  },
});
