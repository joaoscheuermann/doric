import type { Logger } from 'pino';

import type { SandboxSession } from 'sandbox';

import type {
  PooledSandbox,
  SandboxLease,
  Sandpool,
  SandpoolOptions,
  SandpoolStatus,
  SandpoolWaitOptions,
} from './types/sandpool.js';

type SessionRecord = {
  readonly session: SandboxSession;
  phase: 'idle' | 'leased' | 'disposing';
  disposal: Promise<void> | undefined;
};

type AcquireWaiter = {
  readonly resolve: (lease: SandboxLease) => void;
  readonly reject: (cause: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
};

type HeatWaiter = {
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
};

type State = {
  readonly options: SandpoolOptions;
  readonly maxCreateAttempts: number;
  readonly logger: Logger;
  readonly idle: SessionRecord[];
  readonly records: Set<SessionRecord>;
  readonly acquisitions: AcquireWaiter[];
  readonly heatWaiters: Set<HeatWaiter>;
  lifecycle: 'active' | 'disposing' | 'disposed';
  creating: number;
  createFailures: number;
  creationExhausted: boolean;
  creationBackoffMs: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  lastFailure: unknown | undefined;
  disposePromise: Promise<void> | undefined;
  finishDispose: (() => void) | undefined;
  wasHeated: boolean;
};

const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5_000;
const DEFAULT_MAX_CREATE_ATTEMPTS = 3;

/** Creates a process-local pool and begins warming it in the background. */
export const createSandpool = (options: SandpoolOptions): Sandpool => {
  validateOptions(options);

  const logger = options.logger.child({ component: 'sandpool' });

  if (typeof logger?.debug !== 'function') {
    throw new TypeError(
      'logger.child must return a logger with a debug method',
    );
  }

  const state: State = {
    options,
    maxCreateAttempts: options.maxCreateAttempts ?? DEFAULT_MAX_CREATE_ATTEMPTS,
    logger,
    idle: [],
    records: new Set(),
    acquisitions: [],
    heatWaiters: new Set(),
    lifecycle: 'active',
    creating: 0,
    createFailures: 0,
    creationExhausted: false,
    creationBackoffMs: INITIAL_BACKOFF_MS,
    retryTimer: undefined,
    lastFailure: undefined,
    disposePromise: undefined,
    finishDispose: undefined,
    wasHeated: false,
  };

  const pool: Sandpool = {
    heated: () => isHeated(state),
    waitUntilHeated: async (waitOptions = {}) =>
      waitUntilHeated(state, waitOptions),
    acquire: async (waitOptions = {}) => acquire(state, waitOptions),
    status: () => status(state),
    dispose: () => dispose(state),
  };

  log(state, 'sandpool started');

  pump(state);

  return pool;
};

const validateOptions = (options: SandpoolOptions): void => {
  if (!Number.isInteger(options.minIdle) || options.minIdle < 0) {
    throw new RangeError('minIdle must be a non-negative integer');
  }

  if (!Number.isInteger(options.maxSandboxes) || options.maxSandboxes <= 0) {
    throw new RangeError('maxSandboxes must be a positive integer');
  }

  if (options.minIdle > options.maxSandboxes) {
    throw new RangeError('minIdle must not exceed maxSandboxes');
  }

  if (
    options.maxCreateAttempts !== undefined &&
    (!Number.isInteger(options.maxCreateAttempts) ||
      options.maxCreateAttempts <= 0)
  ) {
    throw new RangeError('maxCreateAttempts must be a positive integer');
  }

  if (typeof options.create !== 'function') {
    throw new TypeError('create must be a function');
  }

  if (typeof options.logger?.debug !== 'function') {
    throw new TypeError('logger.debug must be a function');
  }

  if (typeof options.logger.child !== 'function') {
    throw new TypeError('logger.child must be a function');
  }
};

const waitUntilHeated = (
  state: State,
  options: SandpoolWaitOptions,
): Promise<void> => {
  ensureActive(state);

  ensureNotAborted(options.signal);

  if (isHeated(state)) {
    return Promise.resolve();
  }

  resumeCreationAttempts(state);

  log(state, 'waiting for sandpool to heat');

  return new Promise<void>((resolve, reject) => {
    const waiter: HeatWaiter = {
      resolve,
      reject,
      signal: options.signal,
      onAbort: () => {
        state.heatWaiters.delete(waiter);

        log(state, 'sandpool heat wait cancelled');

        reject(abortError());
      },
    };

    state.heatWaiters.add(waiter);

    options.signal?.addEventListener('abort', waiter.onAbort, { once: true });

    pump(state);
  });
};

const acquire = (
  state: State,
  options: SandpoolWaitOptions,
): Promise<SandboxLease> => {
  ensureActive(state);

  ensureNotAborted(options.signal);

  resumeCreationAttempts(state);

  return new Promise<SandboxLease>((resolve, reject) => {
    const waiter: AcquireWaiter = {
      resolve,
      reject,
      signal: options.signal,
      onAbort: () => {
        const index = state.acquisitions.indexOf(waiter);

        if (index >= 0) {
          state.acquisitions.splice(index, 1);
        }

        log(state, 'sandbox acquisition cancelled');

        reject(abortError());

        pump(state);
      },
    };

    state.acquisitions.push(waiter);

    log(state, 'sandbox acquisition queued');

    options.signal?.addEventListener('abort', waiter.onAbort, { once: true });

    pump(state);
  });
};

const pump = (state: State): void => {
  if (state.lifecycle !== 'active') {
    finishDisposeIfPossible(state);

    return;
  }

  while (state.idle.length > 0 && state.acquisitions.length > 0) {
    const record = state.idle.shift();
    const waiter = state.acquisitions.shift();

    if (record === undefined || waiter === undefined) {
      break;
    }

    waiter.signal?.removeEventListener('abort', waiter.onAbort);

    record.phase = 'leased';

    log(state, 'sandbox leased', { sandboxId: record.session.id });

    waiter.resolve(lease(state, record));
  }

  announceHeatTransition(state);

  resolveHeatWaiters(state);

  startRequiredCreations(state);
};

const startRequiredCreations = (state: State): void => {
  if (state.retryTimer !== undefined || state.creationExhausted) {
    return;
  }

  const known = state.records.size + state.creating;
  const capacity = state.options.maxSandboxes - known;
  const deficit =
    state.acquisitions.length + state.options.minIdle - state.idle.length;
  const remainingAttempts =
    state.maxCreateAttempts - state.createFailures - state.creating;
  const count = Math.max(0, Math.min(capacity, deficit, remainingAttempts));

  for (let index = 0; index < count; index += 1) {
    state.creating += 1;

    log(state, 'sandbox creation started');

    void createOne(state);
  }
};

const createOne = async (state: State): Promise<void> => {
  try {
    const session = await state.options.create();

    state.creating -= 1;

    state.createFailures = 0;

    state.creationExhausted = false;

    state.creationBackoffMs = INITIAL_BACKOFF_MS;

    const record: SessionRecord = {
      session,
      phase: 'idle',
      disposal: undefined,
    };

    state.records.add(record);

    if (state.lifecycle === 'active') {
      state.idle.push(record);

      log(state, 'sandbox created', { sandboxId: session.id });
    } else {
      log(state, 'sandbox created', { sandboxId: session.id });

      void startDisposal(state, record);
    }
  } catch (cause) {
    state.creating -= 1;

    state.createFailures += 1;

    state.lastFailure = cause;

    log(state, 'sandbox creation failed', {
      reason: 'sandbox_factory_rejected',
      hint: 'Check sandbox provider availability, image access, and resource support.',
    });

    if (
      state.lifecycle === 'active' &&
      state.createFailures >= state.maxCreateAttempts
    ) {
      exhaustCreationAttempts(state);
    } else {
      scheduleCreationRetry(state);
    }
  }

  pump(state);
};

const exhaustCreationAttempts = (state: State): void => {
  state.creationExhausted = true;

  state.creationBackoffMs = INITIAL_BACKOFF_MS;

  if (state.retryTimer !== undefined) {
    clearTimeout(state.retryTimer);

    state.retryTimer = undefined;
  }

  const fields = {
    reason: 'sandbox_creation_attempts_exhausted',
    hint: 'Retry the acquisition after restoring sandbox provider availability.',
  } as const;

  log(state, 'sandbox creation attempts exhausted', fields);

  const cause = new Error(
    `Sandpool could not create a sandbox after ${String(state.maxCreateAttempts)} attempts`,
  );

  rejectCreationWaiters(state, cause, fields);
};

const resumeCreationAttempts = (state: State): void => {
  if (!state.creationExhausted) {
    return;
  }

  state.creationExhausted = false;

  state.createFailures = 0;

  state.creationBackoffMs = INITIAL_BACKOFF_MS;

  log(state, 'sandbox creation attempts resumed');
};

const scheduleCreationRetry = (state: State): void => {
  if (state.lifecycle !== 'active' || state.retryTimer !== undefined) {
    return;
  }

  const delay = state.creationBackoffMs;

  state.creationBackoffMs = Math.min(delay * 2, MAX_BACKOFF_MS);

  log(state, 'sandbox creation retry scheduled', { retryDelayMs: delay });

  state.retryTimer = setTimeout(() => {
    state.retryTimer = undefined;

    pump(state);
  }, delay);
};

const lease = (state: State, record: SessionRecord): SandboxLease => {
  const sandbox = guardedSession(record);
  let releasePromise: Promise<void> | undefined;

  return {
    sandbox,
    release: () => {
      if (releasePromise === undefined) {
        log(state, 'sandbox lease released', {
          sandboxId: record.session.id,
        });

        releasePromise = startDisposal(state, record);
      }

      return releasePromise;
    },
  };
};

const guardedSession = (record: SessionRecord): PooledSandbox => {
  const active = () => {
    if (record.phase !== 'leased') {
      throw new Error('Sandbox lease is no longer active');
    }
  };

  return {
    id: record.session.id,
    root: record.session.root,
    exec: async (input) => {
      active();

      return record.session.exec(input);
    },
    cloneRepo: async (input) => {
      active();

      return record.session.cloneRepo(input);
    },
    readFile: async (path) => {
      active();

      return record.session.readFile(path);
    },
    writeFile: async (path, content) => {
      active();

      return record.session.writeFile(path, content);
    },
    putFile: async (path, bytes) => {
      active();

      return record.session.putFile(path, bytes);
    },
    getFile: async (path) => {
      active();

      return record.session.getFile(path);
    },
    diff: async (input) => {
      active();

      return record.session.diff(input);
    },
    ssh: async () => {
      active();

      return record.session.ssh();
    },
  };
};

const startDisposal = (state: State, record: SessionRecord): Promise<void> => {
  if (record.disposal !== undefined) {
    return record.disposal;
  }

  record.phase = 'disposing';

  const idleIndex = state.idle.indexOf(record);

  if (idleIndex >= 0) {
    state.idle.splice(idleIndex, 1);
  }

  log(state, 'sandbox disposal started', { sandboxId: record.session.id });

  record.disposal = disposeWithRetry(state, record);

  pump(state);

  return record.disposal;
};

const disposeWithRetry = async (
  state: State,
  record: SessionRecord,
): Promise<void> => {
  let delay = INITIAL_BACKOFF_MS;

  for (;;) {
    try {
      await record.session.dispose();

      state.records.delete(record);

      log(state, 'sandbox disposed', { sandboxId: record.session.id });

      pump(state);

      return;
    } catch (cause) {
      state.lastFailure = cause;

      log(state, 'sandbox disposal failed', { sandboxId: record.session.id });

      log(state, 'sandbox disposal retry scheduled', {
        sandboxId: record.session.id,
        retryDelayMs: delay,
      });

      await wait(delay);

      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
    }
  }
};

const dispose = (state: State): Promise<void> => {
  if (state.disposePromise !== undefined) {
    return state.disposePromise;
  }

  state.lifecycle = 'disposing';

  log(state, 'sandpool disposal started');

  if (state.retryTimer !== undefined) {
    clearTimeout(state.retryTimer);

    state.retryTimer = undefined;
  }

  rejectWaiters(state, new Error('Sandpool is disposing'));

  state.disposePromise = new Promise<void>((resolve) => {
    state.finishDispose = resolve;
  });

  [...state.records].forEach((record) => void startDisposal(state, record));

  finishDisposeIfPossible(state);

  return state.disposePromise;
};

const finishDisposeIfPossible = (state: State): void => {
  if (
    state.lifecycle !== 'disposing' ||
    state.creating > 0 ||
    state.records.size > 0
  ) {
    return;
  }

  state.lifecycle = 'disposed';

  log(state, 'sandpool disposed');

  state.finishDispose?.();

  state.finishDispose = undefined;
};

const rejectWaiters = (state: State, cause: unknown): void => {
  state.acquisitions.splice(0).forEach((waiter) => {
    waiter.signal?.removeEventListener('abort', waiter.onAbort);

    log(state, 'sandbox acquisition cancelled');

    waiter.reject(cause);
  });

  [...state.heatWaiters].forEach((waiter) => {
    waiter.signal?.removeEventListener('abort', waiter.onAbort);

    log(state, 'sandpool heat wait cancelled');

    waiter.reject(cause);
  });

  state.heatWaiters.clear();
};

const rejectCreationWaiters = (
  state: State,
  cause: unknown,
  fields: Readonly<Record<string, unknown>>,
): void => {
  state.acquisitions.splice(0).forEach((waiter) => {
    waiter.signal?.removeEventListener('abort', waiter.onAbort);

    log(state, 'sandbox acquisition failed', fields);

    waiter.reject(cause);
  });

  [...state.heatWaiters].forEach((waiter) => {
    waiter.signal?.removeEventListener('abort', waiter.onAbort);

    log(state, 'sandpool heat failed', fields);

    waiter.reject(cause);
  });

  state.heatWaiters.clear();
};

const resolveHeatWaiters = (state: State): void => {
  if (!isHeated(state)) {
    return;
  }

  [...state.heatWaiters].forEach((waiter) => {
    waiter.signal?.removeEventListener('abort', waiter.onAbort);

    waiter.resolve();
  });

  state.heatWaiters.clear();
};

const status = (state: State): SandpoolStatus => {
  const leased = [...state.records].filter(
    (record) => record.phase === 'leased',
  ).length;

  const disposing = [...state.records].filter(
    (record) => record.phase === 'disposing',
  ).length;

  return {
    lifecycle: state.lifecycle,
    idle: state.idle.length,
    leased,
    creating: state.creating,
    disposing,
    queued: state.acquisitions.length,
    total: state.records.size + state.creating,
    heated: isHeated(state),
    lastFailure: state.lastFailure,
  };
};

const isHeated = (state: State): boolean =>
  state.lifecycle === 'active' && state.idle.length >= state.options.minIdle;

const announceHeatTransition = (state: State): void => {
  const heated = isHeated(state);

  if (heated && !state.wasHeated) {
    log(state, 'sandpool heated');
  }

  state.wasHeated = heated;
};

const log = (
  state: State,
  message: string,
  fields: Readonly<Record<string, unknown>> = {},
): void => {
  const phases = [...state.records].map(({ phase }) => phase);

  state.logger.debug(
    {
      lifecycle: state.lifecycle,
      idle: state.idle.length,
      leased: phases.filter((phase) => phase === 'leased').length,
      creating: state.creating,
      disposing: phases.filter((phase) => phase === 'disposing').length,
      queued: state.acquisitions.length,
      total: state.records.size + state.creating,
      heated: isHeated(state),
      minIdle: state.options.minIdle,
      maxSandboxes: state.options.maxSandboxes,
      createFailures: state.createFailures,
      maxCreateAttempts: state.maxCreateAttempts,
      ...fields,
    },
    message,
  );
};

const ensureActive = (state: State): void => {
  if (state.lifecycle !== 'active') {
    throw new Error('Sandpool is not active');
  }
};

const ensureNotAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw abortError();
  }
};

const abortError = (): Error =>
  Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError',
  });

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
