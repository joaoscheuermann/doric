// `terminal/v1` as the window reaches it from slice S65d: the generated
// `TerminalService` over Connect, served by a fake `HostClients`
// (`./connect.js`) behind today's domain `TerminalHost`. Each RPC calls the
// domain method the tests give (with the call's `doric-scope-bin` read back),
// and writes its answer as the host writes it; a `watchProject` call is one
// opening the test drives.

import type { MessageInitShape } from '@bufbuild/protobuf';
import type { ServiceImpl } from '@connectrpc/connect';
import type { CallScope, ClientServices } from 'bundle/contracts';

import type { TerminalHost } from '../../src/client/api.js';

export type { TerminalHost };

import type { Terminal } from '../../src/client/domain/terminals.js';
import {
  TerminalService,
  type TerminalSessionSchema,
  type WatchProjectResponseSchema,
} from '../../src/contracts/gen/doric/terminal/v1/terminal_pb.js';
import {
  connectFailure,
  fakeClientServices,
  fakeHostClients,
  type HostCall,
  scopeOf,
  streamOf,
} from './connect.js';

/** Runs `answer`; a failure fails the call as the host sends it. */
const answered = async <T>(answer: () => Promise<T>): Promise<T> => {
  try {
    return await answer();
  } catch (error) {
    throw connectFailure(error);
  }
};

/** One session as `TerminalSession`; an absent `timeoutMs` answers no field. */
export const sessionOf = (
  session: Terminal,
): MessageInitShape<typeof TerminalSessionSchema> => ({
  id: session.id,
  projectId: session.projectId,
  threadId: session.threadId,
  origin: session.origin,
  command: session.command,
  cwd: session.cwd,
  startedAt: session.startedAt,
  ...(session.timeoutMs === null ? {} : { timeoutMs: session.timeoutMs }),
  state: session.state,
  pty: session.pty,
  ...(session.name === undefined ? {} : { name: session.name }),
});

/** The `watchProject` stream one test drives. */
type WatchItemMessage = MessageInitShape<typeof WatchProjectResponseSchema>;

type TerminalStream = ReturnType<
  typeof streamOf<{ projectId: string }, WatchItemMessage>
>;

/**
 * `TerminalService` over the domain `TerminalHost` of each call's scope, and
 * the openings of its `watchProject`.
 */
const terminalsOver = (
  host: (scope: CallScope | undefined) => TerminalHost,
) => {
  const stream = streamOf<{ projectId: string }, WatchItemMessage>();
  const of = (context: { readonly requestHeader: Headers }): TerminalHost =>
    host(scopeOf(context));

  return {
    stream,
    implementation: {
      list: (request, context) =>
        answered(
          async () =>
            ({
              terminals: [...(await of(context).list(request.projectId))].map(
                sessionOf,
              ),
            }) as never,
        ),
      create: (request, context) =>
        answered(async () => {
          const session = await of(context).create(request.threadId, {});

          return {
            ...(session === undefined
              ? {}
              : { terminalSession: sessionOf(session) }),
          };
        }),
      snapshot: (request, context) =>
        answered(async () => {
          const read = await of(context).snapshot(
            request.terminalId,
            request.after,
          );

          return {
            ...(read === undefined
              ? {}
              : {
                  terminalSnapshot: {
                    terminal: sessionOf(read.terminal),
                    output: read.output,
                    offset: read.offset,
                    truncated: read.truncated,
                  },
                }),
          };
        }),
      input: (request, context) =>
        answered(async () => ({
          sent: await of(context).input(request.terminalId, request.data),
        })),
      resize: (request, context) =>
        answered(async () => ({
          resized: await of(context).resize(
            request.terminalId,
            request.cols,
            request.rows,
          ),
        })),
      stop: (request, context) =>
        answered(async () => ({
          stopped: await of(context).stop(request.terminalId),
        })),
      rename: (request, context) =>
        answered(async () => ({
          renamed: await of(context).rename(
            request.terminalId,
            request.name ?? null,
          ),
        })),
      watchProject: stream.serve,
    } satisfies Partial<ServiceImpl<typeof TerminalService>>,
  };
};

/**
 * The terminal client part's window services: `services.use(TerminalService,
 * scope)` reaches today's `TerminalHost` of that scope over Connect as the
 * part `terminal`.
 */
export const terminalWindow = (
  host: (scope: CallScope | undefined) => TerminalHost,
): {
  readonly services: ClientServices;
  readonly calls: HostCall[];
  readonly stream: TerminalStream;
} => {
  const { stream, implementation } = terminalsOver(host);
  const { hostClients, calls } = fakeHostClients((router) => {
    router.service(TerminalService, implementation);
  });

  return {
    services: fakeClientServices({ bundleId: 'terminal', hostClients })
      .services,
    calls,
    stream,
  };
};
