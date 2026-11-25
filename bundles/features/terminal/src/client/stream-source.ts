// The window's terminal stream over `terminal/v1.watchProject`, from slice
// S65d: `TerminalService`'s generated client in, today's `TerminalWatchItem`s
// out (`terminalOneofs` reads each case back). The stream is resumable, so the
// SDK reopens it after `generation_lost`; a failure ends it with its Doric
// error.

import { type Client, ConnectError } from '@connectrpc/connect';
import { ContractError, fromConnectError } from 'bundle/contracts';
import { decode } from 'runtime/contracts';
import type { z } from 'zod';

import {
  type TerminalService,
  type WatchProjectResponse,
  WatchProjectResponseSchema,
} from '../contracts/gen/doric/terminal/v1/terminal_pb.js';
import {
  type TerminalSession,
  type TerminalWatchItem,
  terminalOneofs,
  terminalOutputSchema,
  terminalSessionSchema,
} from '../contracts/index.js';
import type { TerminalStreamSource } from './output-watch.js';

const invalidOutput = (what: string): never => {
  throw new ContractError(
    'invalid_output',
    `terminal/v1 watchProject answered an item outside its contract: ${what}`,
  );
};

/** `value` parsed by `schema`, or `invalid_output`. */
const checked = <O extends z.ZodType>(
  schema: O,
  value: unknown,
): z.output<O> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return invalidOutput(parsed.error.message);
  return parsed.data;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};

/** A decoded session: the wire has no `null`, so an absent timeout is no limit. */
const sessionOf = (value: unknown): TerminalSession => {
  const session = asRecord(value);
  return checked(terminalSessionSchema, {
    ...session,
    timeoutMs: session.timeoutMs ?? null,
  });
};

/** One `WatchProjectResponse` as today's item. */
export const terminalItemOf = (
  message: WatchProjectResponse,
): TerminalWatchItem => {
  const item = asRecord(
    decode(WatchProjectResponseSchema, message, terminalOneofs),
  );

  switch (item.kind) {
    case 'snapshot':
      return {
        kind: 'snapshot',
        projectId: String(item.projectId),
        terminals: (Array.isArray(item.terminals) ? item.terminals : []).map(
          sessionOf,
        ),
      };
    case 'updated':
      return { kind: 'updated', terminal: sessionOf(item.terminal) };
    case 'removed':
      return {
        kind: 'removed',
        projectId: String(item.projectId),
        threadId: String(item.threadId),
        terminalId: String(item.terminalId),
      };
    case 'output':
      return {
        kind: 'output',
        output: checked(terminalOutputSchema, item.output),
      };
    default:
      return invalidOutput(String(item.kind));
  }
};

/** `watchProject` over `TerminalService` as today's observer source. */
export const terminalStreamsOf = (
  client: (projectId: string) => Client<typeof TerminalService>,
): TerminalStreamSource => ({
  watchProject: (projectId, observer) => {
    const controller = new AbortController();
    const { signal } = controller;

    void (async () => {
      try {
        for await (const message of client(projectId).watchProject(
          { projectId },
          { signal },
        )) {
          if (signal.aborted) return;
          observer.next(terminalItemOf(message));
        }
        if (!signal.aborted) observer.end?.();
      } catch (error) {
        if (signal.aborted) return;
        observer.end?.(
          error instanceof ConnectError
            ? fromConnectError(error)
            : new ContractError(
                'internal',
                error instanceof Error ? error.message : String(error),
              ),
        );
      } finally {
        controller.abort();
      }
    })();

    return { dispose: () => controller.abort() };
  },
});
