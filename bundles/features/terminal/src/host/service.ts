// `terminal`'s host part (phase 3, S54b): `terminal/v1`, the `terminal` tool
// and the `onThreadsClosingHook` handler served over the routed adapters.

import type { MessageInitShape } from '@bufbuild/protobuf';
import type { ServiceImpl } from '@connectrpc/connect';
import { ContractError, callOf } from 'bundle/contracts';
import {
  createHookHandlers,
  createToolHandlers,
  type HookHandlers,
  type HostContext,
  type ToolHandlers,
} from 'bundle/host';
import { OnThreadsClosingHookInputSchema } from 'runtime/contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';

import type {
  TerminalService,
  WatchProjectResponseSchema,
} from '../contracts/gen/doric/terminal/v1/terminal_pb.js';
import type { TerminalService as TerminalOperations } from '../contracts/index.js';
import {
  runInputOf,
  runResponseOf,
  sessionMessageOf,
  snapshotMessageOf,
  watchItemMessageOf,
} from './codec.js';
import {
  routedRuntimeThreads,
  routedRuntimeWorkspace,
  routedSecrets,
} from './routed.js';
import { createTerminalHost, type TerminalHost } from './terminals.js';
import { createTool } from './tool.js';

export interface TerminalProcessHost {
  /**
   * `terminal/v1` over the router: each method converts with `./codec.ts` and
   * runs the operations with `callOf(context)`.
   * - `Run` → `runResponseOf`; `Create` → `{terminalSession?}`; `Snapshot` →
   *   `{terminalSnapshot?}`; `Input` → `{sent}`; `Resize` → `{resized}`;
   *   `Stop` → `{stopped}`; `Rename{terminalId, name?}` → `{renamed}`;
   *   `List` → `{terminals}`.
   * - `WatchProject`: yields `watchItemMessageOf` of each item of
   *   `operations.watchProject`, the snapshot first, until the caller
   *   cancels; it never ends by itself.
   * Errors: §4 of the S54 contracts (`unavailable` before `activate`).
   */
  readonly terminal: ServiceImpl<typeof TerminalService>;
  /** The tool table `main.ts` serves as `ToolHandlerService`. */
  readonly tools: ToolHandlers;
  /** The hook table `main.ts` serves as `HookHandlerService`. */
  readonly hooks: HookHandlers;
  /**
   * In this order:
   * 1. builds `createTerminalHost` over `routedSecrets`, `routedRuntimeWorkspace`,
   *    `routedRuntimeThreads` and `context.log`;
   * 2. `tools.register(context, createTool().bind({cwd: routed Cwd, run:
   *    operations.run}), {alwaysAvailable: true, order: 500})`;
   * 3. `hooks.register(context, OnThreadsClosingHookInputSchema, (input) =>
   *    host.threadsClosing(input))`.
   * The service is served from step 3 on. Rejects with the first refusal; the
   * service then stays `unavailable`.
   */
  activate(
    context: Pick<HostContext, 'services' | 'registrations' | 'log'>,
  ): Promise<void>;
  /** `host.dispose()`. Sessions are not stopped; they end with the process (Q5). */
  deactivate(): void;
}

/** Builds the part with no I/O; never throws. */
export const createTerminalProcessHost = (): TerminalProcessHost => {
  const tools = createToolHandlers();
  const hooks = createHookHandlers();
  let host: TerminalHost | undefined;
  let active: TerminalOperations | undefined;

  const operations = (): TerminalOperations => {
    if (active === undefined) {
      throw new ContractError('unavailable', 'terminal is not activated.');
    }

    return active;
  };

  return {
    terminal: {
      run: async (request, context) =>
        runResponseOf(
          await operations().run(runInputOf(request), callOf(context)),
        ),
      list: async (request, context) => ({
        terminals: (
          await operations().list(request.projectId, callOf(context))
        ).map(sessionMessageOf),
      }),
      create: async (request, context) => {
        const session = await operations().create(
          request.threadId,
          {
            ...(request.cols === undefined ? {} : { cols: request.cols }),
            ...(request.rows === undefined ? {} : { rows: request.rows }),
          },
          callOf(context),
        );

        return session === undefined
          ? {}
          : { terminalSession: sessionMessageOf(session) };
      },
      snapshot: async (request, context) => {
        const snapshot = await operations().snapshot(
          request.terminalId,
          request.after,
          callOf(context),
        );

        return snapshot === undefined
          ? {}
          : { terminalSnapshot: snapshotMessageOf(snapshot) };
      },
      input: async (request, context) => ({
        sent: await operations().input(
          request.terminalId,
          request.data,
          callOf(context),
        ),
      }),
      resize: async (request, context) => ({
        resized: await operations().resize(
          request.terminalId,
          request.cols,
          request.rows,
          callOf(context),
        ),
      }),
      stop: async (request, context) => ({
        stopped: await operations().stop(request.terminalId, callOf(context)),
      }),
      rename: async (request, context) => ({
        renamed: await operations().rename(
          request.terminalId,
          request.name ?? null,
          callOf(context),
        ),
      }),
      watchProject: async function* (request, context) {
        const source = operations();
        const items: MessageInitShape<typeof WatchProjectResponseSchema>[] = [];
        let wake: (() => void) | undefined;
        const onAbort = () => wake?.();
        const watch = source.watchProject(
          request.projectId,
          (item) => {
            items.push(watchItemMessageOf(item));
            wake?.();
          },
          callOf(context),
        );

        context.signal.addEventListener('abort', onAbort, { once: true });

        try {
          while (!context.signal.aborted) {
            const item = items.shift();

            if (item !== undefined) {
              yield item;
              continue;
            }

            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
          }
        } finally {
          context.signal.removeEventListener('abort', onAbort);
          watch.dispose();
        }
      },
    },
    tools,
    hooks,
    activate: async (context) => {
      const workspace = routedRuntimeWorkspace(context.services);
      const threads = routedRuntimeThreads(context.services);
      const built = createTerminalHost({
        secrets: routedSecrets(context.services),
        workspace: () => workspace,
        threads: () => threads,
        log: () => context.log,
      });

      host = built;
      await tools.register(
        context,
        createTool().bind({
          cwd: () => workspace.cwd(),
          run: (input, call) => built.operations.run(input, call),
        }),
        { alwaysAvailable: true, order: 500 },
      );
      await hooks.register(context, OnThreadsClosingHookInputSchema, (input) =>
        built.threadsClosing(input),
      );
      active = built.operations;
    },
    deactivate: () => {
      host?.dispose();
    },
  };
};
