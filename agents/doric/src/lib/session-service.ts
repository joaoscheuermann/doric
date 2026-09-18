import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import type { SandboxSshAccess } from 'sandbox';
import type { PooledSandbox, SandboxLease, Sandpool } from 'sandpool';

import type { ConfigService } from './config-service.js';
import { runDirectPrompt } from './direct.js';
import { eventJson } from './event-json.js';
import type { Generation } from './generation.js';
import type { SessionPublisher } from './session-publisher.js';
import type { Session, SessionEvent, SessionStore } from './sessions.js';

export type SessionService = ReturnType<typeof createSessionService>;

type SessionServiceOptions = {
  readonly store: SessionStore;
  readonly config: ConfigService;
  readonly pool: Sandpool;
  readonly publisher: SessionPublisher;
  readonly logger: Logger;
  readonly execute?: SessionExecution;
};

type PromptJob = { readonly id: string; readonly prompt: string };

type Runtime = {
  readonly id: string;
  readonly generation: Generation;
  readonly controller: AbortController;
  readonly jobs: PromptJob[];
  wake?: () => void;
};

type LiveSandbox =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly sandbox: PooledSandbox }
  | { readonly status: 'unavailable' };

export type SessionSsh =
  | { readonly status: 'pending' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'expired' }
  | { readonly status: 'missing' }
  | {
      readonly status: 'ready';
      readonly vmId: string;
      readonly ssh: SandboxSshAccess;
    };

export type SessionEvents = {
  readonly events: readonly SessionEvent[];
  readonly lastSequence: number;
};

export type PromptResult =
  | { readonly status: 'accepted'; readonly promptId: string }
  | { readonly status: 'inactive' }
  | { readonly status: 'missing' };

type PromptExecutionOptions = {
  readonly sessionId: string;
  readonly promptId: string;
  readonly prompt: string;
  readonly generation: Generation;
  readonly signal: AbortSignal;
  readonly store: SessionStore;
  readonly publisher: SessionPublisher;
};

type SessionExecution = (
  options: PromptExecutionOptions,
  lease: SandboxLease,
) => Promise<void>;

/** Owns one long-lived sandbox lease and one FIFO prompt loop per session. */
export const createSessionService = ({
  store,
  config,
  pool,
  publisher,
  logger,
  execute = executeDirect,
}: SessionServiceOptions) => {
  const runtimes = new Map<string, Runtime>();
  const running = new Set<Promise<void>>();
  const live = new Map<string, LiveSandbox>();
  const sessionsByVm = new Map<string, string>();

  const start = (runtime: Runtime) => {
    const lifecycle = runLifecycle({
      runtime,
      store,
      pool,
      publisher,
      logger,
      execute,
      acquired: (sandbox) => {
        live.set(runtime.id, { status: 'ready', sandbox });

        sessionsByVm.set(sandbox.id, runtime.id);
      },
      releasing: (sandbox) => {
        sessionsByVm.delete(sandbox.id);

        live.set(runtime.id, { status: 'unavailable' });
      },
    })
      .catch(() =>
        logger.error(
          { sessionId: runtime.id },
          'Direct session persistence failed',
        ),
      )
      .finally(() => {
        runtimes.delete(runtime.id);

        live.delete(runtime.id);

        running.delete(lifecycle);
      });

    running.add(lifecycle);
  };

  return {
    async create(): Promise<Session> {
      const generation = config.current();
      const record = await store.create(generation.snapshot);

      const runtime: Runtime = {
        id: record.session.id,
        generation,
        controller: new AbortController(),
        jobs: [],
      };

      runtimes.set(runtime.id, runtime);

      live.set(runtime.id, { status: 'pending' });

      start(runtime);

      return record.session;
    },

    find: async (id: string) => (await store.find(id))?.session,
    list: store.list,

    async prompt(id: string, prompt: string): Promise<PromptResult> {
      const runtime = runtimes.get(id);

      if (runtime === undefined) {
        return (await store.find(id)) === undefined
          ? { status: 'missing' }
          : { status: 'inactive' };
      }

      const promptId = randomUUID();
      const accepted = await store.acceptPrompt(id, promptId);

      if (accepted.status !== 'accepted') {
        return accepted;
      }

      publisher.event(accepted.event);

      runtime.jobs.push({ id: promptId, prompt });

      runtime.wake?.();

      return { status: 'accepted', promptId };
    },

    ssh: (id: string) => findSessionSsh(id, live, store),
    sshForVm: (id: string) => findVmSsh(id, sessionsByVm, live),
    events: (id: string, afterSequence: number) =>
      findEvents(id, afterSequence, store),

    async terminate(id: string): Promise<Session | undefined> {
      const current = await store.requestCancellation(id);

      if (current === undefined) {
        return undefined;
      }

      runtimes.get(id)?.controller.abort();

      publisher.updated(current);

      return current;
    },

    async delete(id: string) {
      const outcome = await store.delete(id);

      if (outcome === 'deleted') {
        publisher.deleted(id);
      }

      return outcome;
    },

    async dispose(): Promise<void> {
      runtimes.forEach(({ controller, wake }) => {
        controller.abort();

        wake?.();
      });

      await Promise.allSettled([...running]);
    },
  };
};

type LifecycleOptions = {
  readonly runtime: Runtime;
  readonly store: SessionStore;
  readonly pool: Sandpool;
  readonly publisher: SessionPublisher;
  readonly logger: Logger;
  readonly execute: SessionExecution;
  readonly acquired: (sandbox: PooledSandbox) => void;
  readonly releasing: (sandbox: PooledSandbox) => void;
};

const runLifecycle = async (options: LifecycleOptions): Promise<void> => {
  const { runtime, store, publisher } = options;
  const signal = runtime.controller.signal;
  let lease: SandboxLease | undefined;
  let failed = false;
  let errorCode: string | undefined;

  try {
    lease = await options.pool.acquire({ signal });

    options.acquired(lease.sandbox);

    signal.throwIfAborted();

    const ready = await store.markReady(runtime.id);

    if (ready === undefined) {
      return;
    }

    publisher.updated(ready);

    while (!signal.aborted) {
      const job = await nextJob(runtime);

      if (job === undefined) {
        break;
      }

      await runJob(options, lease, job);
    }
  } catch (error) {
    failed = !signal.aborted && !isAbort(error);

    errorCode = failed ? 'sandbox_acquisition_failed' : undefined;

    await cancelJobs(
      options,
      failed ? 'agent.failed' : 'agent.cancelled',
      error,
    );
  } finally {
    if (lease !== undefined) {
      options.releasing(lease.sandbox);

      try {
        await lease.release();
      } catch {
        failed = true;

        errorCode = 'sandbox_release_failed';
      }
    }
  }

  const finished = await store.finish(
    runtime.id,
    failed ? 'failed' : 'cancelled',
    errorCode,
  );

  if (finished !== undefined) {
    publisher.updated(finished);
  }

  options.logger.debug(
    { sessionId: runtime.id, status: failed ? 'failed' : 'cancelled' },
    'Direct session finished',
  );
};

const runJob = async (
  options: LifecycleOptions,
  lease: SandboxLease,
  job: PromptJob,
): Promise<void> => {
  const { runtime, store, publisher } = options;
  const started = await store.markRunning(runtime.id);

  if (started?.state !== 'running') {
    return;
  }

  publisher.updated(started);

  let failure: unknown;

  try {
    await options.execute(
      {
        sessionId: runtime.id,
        promptId: job.id,
        prompt: job.prompt,
        generation: runtime.generation,
        signal: runtime.controller.signal,
        store,
        publisher,
      },
      lease,
    );
  } catch (error) {
    failure = error;

    await appendSynthetic(
      options,
      job.id,
      runtime.controller.signal.aborted ? 'agent.cancelled' : 'agent.failed',
      error,
    );
  } finally {
    const record = await store.find(runtime.id);

    if (record !== undefined) {
      const ready = await store.finishPrompt(runtime.id, record.messages);

      if (ready !== undefined) {
        publisher.updated(ready);
      }
    }
  }

  if (runtime.controller.signal.aborted && failure !== undefined) {
    throw failure;
  }
};

const nextJob = async (runtime: Runtime): Promise<PromptJob | undefined> => {
  while (!runtime.controller.signal.aborted) {
    const job = runtime.jobs.shift();

    if (job !== undefined) {
      return job;
    }

    await new Promise<void>((resolve) => {
      const wake = () => {
        runtime.controller.signal.removeEventListener('abort', wake);

        if (runtime.wake === wake) {
          runtime.wake = undefined;
        }

        resolve();
      };

      runtime.wake = wake;

      runtime.controller.signal.addEventListener('abort', wake, { once: true });
    });
  }

  return undefined;
};

const cancelJobs = async (
  options: LifecycleOptions,
  type: 'agent.failed' | 'agent.cancelled',
  error: unknown,
): Promise<void> => {
  for (const job of options.runtime.jobs.splice(0)) {
    await appendSynthetic(options, job.id, type, error);
  }
};

const appendSynthetic = async (
  options: LifecycleOptions,
  promptId: string,
  type: 'agent.failed' | 'agent.cancelled',
  error: unknown,
): Promise<void> => {
  const stored = await options.store.appendEvent(
    options.runtime.id,
    promptId,
    eventJson({ type, error }, options.runtime.generation.redactions()),
  );

  options.publisher.event(stored);
};

const executeDirect: SessionExecution = async (options, lease) =>
  runDirectPrompt({
    ...options,
    sandbox: lease.sandbox,
    event: options.publisher.event,
  });

const isAbort = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';
const terminal = new Set<Session['state']>(['failed', 'cancelled']);

const findSessionSsh = async (
  id: string,
  live: ReadonlyMap<string, LiveSandbox>,
  store: SessionStore,
): Promise<SessionSsh> => {
  const current = live.get(id);

  if (current?.status === 'pending') {
    return { status: 'pending' };
  }

  if (current?.status === 'unavailable') {
    return { status: 'unavailable' };
  }

  if (current?.status === 'ready') {
    const ssh = await current.sandbox.ssh();

    return ssh === undefined
      ? { status: 'unavailable' }
      : { status: 'ready', vmId: current.sandbox.id, ssh };
  }

  const record = await store.find(id);

  if (record === undefined) {
    return { status: 'missing' };
  }

  return {
    status: terminal.has(record.session.state) ? 'expired' : 'unavailable',
  };
};

const findVmSsh = async (
  id: string,
  sessionsByVm: ReadonlyMap<string, string>,
  live: ReadonlyMap<string, LiveSandbox>,
): Promise<
  { readonly sessionId: string; readonly ssh: SandboxSshAccess } | undefined
> => {
  const sessionId = sessionsByVm.get(id);

  if (sessionId === undefined) {
    return undefined;
  }

  const current = live.get(sessionId);

  if (current?.status !== 'ready' || current.sandbox.id !== id) {
    return undefined;
  }

  const ssh = await current.sandbox.ssh();

  return ssh === undefined ? undefined : { sessionId, ssh };
};

const findEvents = async (
  id: string,
  afterSequence: number,
  store: SessionStore,
): Promise<SessionEvents | undefined> => {
  const record = await store.find(id);

  if (record === undefined) {
    return undefined;
  }

  return {
    events: await store.eventsAfter(id, afterSequence),
    lastSequence: record.session.lastSequence,
  };
};
