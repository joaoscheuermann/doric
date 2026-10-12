import {
  type AnyHookHandler,
  type Call,
  defineMethod,
  defineService,
  functionSchema,
  HooksV1,
  hooksMethods,
  logMethods,
  type RegisteredTool,
  type StreamListener,
  secretsMethods,
  ToolsV1,
  toolsMethods,
  toStreamObserver,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import type { Sandbox } from 'sandbox';
import { isBoundTool, type Tool } from 'tool';
import { z } from 'zod';

import { TerminalServiceV1 } from '../../src/contracts/index.js';
import { activate } from '../../src/host/index.js';
import type { ThreadContext, ThreadTaskOutcome } from '../../src/host/peers.js';

const LOCAL_KEY = 'x-doric-local';

/** One live Thread as the fake runtime answers `withThread` for it. */
export interface FakeThread {
  readonly projectId: string;
  readonly cwd: string;
  readonly sandbox: Sandbox;
  /** `ready` runs the task; any other status is answered without running it. */
  status?: 'ready' | 'missing' | 'inactive' | 'pending';
  closing?: boolean;
}

export interface WithThreadCall {
  readonly threadId: string;
  readonly options: {
    readonly exclusive: boolean;
    readonly resume?: boolean;
    readonly refreshHint?: boolean;
  };
}

/**
 * Fake providers of the contracts the host part requires, standing for the
 * runtime and the core: `runtime.workspace/v1` (`cwd`, `withThread`),
 * `runtime.threads/v1` (the background results), `secrets/v1` (the
 * redaction list and its change notices), `log/v1`, `tools/v1` and the
 * minimal `hooks/v1`.
 */
export const activatedHost = async (threads: Record<string, FakeThread>) => {
  const withThreadCalls: WithThreadCall[] = [];
  const enqueued: unknown[] = [];
  const failed: unknown[] = [];
  const logs: { level: string; message: string; fields?: unknown }[] = [];
  const registered: Omit<RegisteredTool, 'bundleId'>[] = [];
  const registeredOrders: number[] = [];
  let stored: string[] = [];
  const watchers = new Set<(list: string[]) => void>();
  let enqueueFails = false;

  const workspace = defineService('runtime.workspace/v1', {
    cwd: defineMethod({
      input: z.tuple([]),
      output: z.string(),
      execute: async (_input, call) =>
        threads[call.scope?.threadId ?? '']?.cwd ?? '/workspace',
    }),
    withThread: defineMethod({
      input: z.tuple([
        z.string(),
        z.object({
          exclusive: z.boolean(),
          resume: z.boolean().optional(),
          refreshHint: z.boolean().optional(),
        }),
        functionSchema<(thread: ThreadContext) => Promise<unknown>>().meta({
          [LOCAL_KEY]: 'callback',
        }),
      ]),
      output: z
        .custom<ThreadTaskOutcome<unknown>>(() => true)
        .meta({ [LOCAL_KEY]: 'object' }),
      execute: async ([threadId, options, task]) => {
        withThreadCalls.push({ threadId, options });
        const thread = threads[threadId];
        if (thread === undefined) return { status: 'missing' as const };
        const status = thread.status ?? 'ready';
        if (status !== 'ready') return { status };
        const value = await task({
          projectId: thread.projectId,
          threadId,
          cwd: thread.cwd,
          sandbox: thread.sandbox,
          closing: () => thread.closing === true,
          busyCwds: () => [],
        });
        return { status: 'ready' as const, value };
      },
    }),
  });

  const runtimeThreads = defineService('runtime.threads/v1', {
    enqueueTerminalResult: defineMethod({
      input: z.object({
        threadId: z.string(),
        promptId: z.string(),
        terminalId: z.string(),
        text: z.string(),
      }),
      output: z.void(),
      execute: async (input) => {
        enqueued.push(input);
        if (enqueueFails) throw new Error('enqueue failed');
      },
    }),
    failTerminalResult: defineMethod({
      input: z.object({ threadId: z.string() }),
      output: z.void(),
      execute: async (input) => {
        failed.push(input);
      },
    }),
  });

  const unused = () => {
    throw new Error('Not used by the terminal bundle.');
  };
  const secrets = defineService('secrets/v1', {
    ...Object.fromEntries(
      (
        [
          'resolve',
          'list',
          'describe',
          'create',
          'update',
          'delete',
          'resolveByKind',
          'registerReferences',
          'view',
          'kinds',
          'registerKind',
        ] as const
      ).map((name) => [
        name,
        defineMethod({
          input: secretsMethods[name].input as z.ZodType,
          output: secretsMethods[name].output as z.ZodType,
          execute: unused,
        }),
      ]),
    ),
    redactions: defineMethod({
      ...secretsMethods.redactions,
      execute: async () => [...stored],
    }),
    watchRedactions: defineMethod({
      ...secretsMethods.watchRedactions,
      execute: (listener: StreamListener<string[]>) => {
        const observer = toStreamObserver(listener);
        const entry = (list: string[]) => observer.next(list);
        watchers.add(entry);
        queueMicrotask(() => entry([...stored]));
        return { dispose: () => watchers.delete(entry) };
      },
    }),
  });

  const log = defineService(
    'log/v1',
    Object.fromEntries(
      (['debug', 'info', 'warn', 'error'] as const).map((level) => [
        level,
        defineMethod({
          ...logMethods[level],
          execute: ([message, fields]: [string, unknown?]) => {
            logs.push({ level, message, fields });
          },
        }),
      ]),
    ),
  );

  const tools = defineService(ToolsV1, {
    register: defineMethod({
      input: toolsMethods.register.input,
      output: toolsMethods.register.output,
      execute: ([tool, options]) => {
        registered.push({ tool, alwaysAvailable: options.alwaysAvailable });
        registeredOrders.push(options.order ?? -1);
        return { dispose: () => undefined };
      },
    }),
    list: defineMethod({
      input: toolsMethods.list.input,
      output: toolsMethods.list.output,
      execute: () => [],
    }),
    catalog: defineMethod({
      input: toolsMethods.catalog.input,
      output: toolsMethods.catalog.output,
      execute: async () => [],
    }),
  });

  // A recording hooks/v1 provider: every contract counts as defined, and
  // `execute` awaits the handlers registered for the hook, as the runner's
  // awaited `onThreadsClosingHook` does.
  const handlers = new Map<string, AnyHookHandler[]>();
  const hooks = defineService(HooksV1, {
    define: defineMethod({
      ...hooksMethods.define,
      execute: () => ({ dispose: () => undefined }),
    }),
    register: defineMethod({
      ...hooksMethods.register,
      execute: ([contract, hook, handler]) => {
        const key = `${contract.id}#${hook}`;
        handlers.set(key, [...(handlers.get(key) ?? []), handler]);
        return {
          dispose: () =>
            handlers.set(
              key,
              (handlers.get(key) ?? []).filter((item) => item !== handler),
            ),
        };
      },
    }),
    whenDefined: defineMethod({
      ...hooksMethods.whenDefined,
      execute: ([, callback]) => {
        const cleanup = callback();
        return {
          dispose: () => {
            if (typeof cleanup === 'function') void cleanup();
          },
        };
      },
    }),
    execute: defineMethod({
      ...hooksMethods.execute,
      execute: async ([contract, hook, input], call) => {
        for (const handler of handlers.get(`${contract.id}#${hook}`) ?? [])
          await (handler as (input: unknown, call: Call) => unknown)(
            input,
            call,
          );
        return undefined;
      },
    }),
  });

  const harness = createTestServices({
    bundle: { id: 'terminal' },
    provide: [workspace, runtimeThreads, secrets, log, tools, hooks],
  });
  const cleanup = await activate({ services: harness.services });

  return {
    services: harness.services,
    terminal: harness.services.use(TerminalServiceV1),
    /** A hop into the bundle for one prompt of a Thread. */
    call: (threadId: string, promptId = 'prompt-1', signal?: AbortSignal) =>
      harness.call(
        { projectId: threads[threadId]?.projectId, threadId, promptId },
        signal,
      ),
    /** The runner's awaited `onThreadsClosingHook`. */
    threadsClosing: async (projectId: string, threadIds: string[]) => {
      for (const handler of handlers.get(
        'runtime.hooks/v1#onThreadsClosingHook',
      ) ?? [])
        await (handler as (input: unknown, call: Call) => unknown)(
          { projectId, threadIds },
          harness.call(),
        );
    },
    /** Rotates the stored secrets and notifies the watchers. */
    setSecrets: (list: string[]) => {
      stored = list;
      for (const watcher of [...watchers]) watcher([...list]);
    },
    setStored: (list: string[]) => {
      stored = list;
    },
    failEnqueue: () => {
      enqueueFails = true;
    },
    withThreadCalls,
    enqueued,
    failed,
    logs,
    /** The registered tools, bound as the agent loop sees them for `call`. */
    tools: (
      call: Call,
    ): {
      readonly alwaysAvailable: boolean;
      readonly order: number;
      readonly tool: Tool;
    }[] =>
      registered.map(({ tool, alwaysAvailable }, index) => {
        if (!isBoundTool(tool))
          throw new TypeError(`unbound tool ${tool.name}`);
        return {
          alwaysAvailable,
          order: registeredOrders[index] ?? -1,
          tool: tool.toTool(call),
        };
      }),
    dispose: async () => {
      if (typeof cleanup === 'function') await cleanup();
      await harness.dispose();
    },
  };
};
