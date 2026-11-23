// The host SDK's log facade (spec `docs/designs/grpc-processes.md`,
// "`log/v1` and the other synchronous commands", A7): `context.log` queues
// each record and sends the queue to `log/v1.WriteBatch`; what is not sent
// goes to stdout, one redacted JSON line per record.
//
// Queueing: each level call keeps `{ level, message, fields, trace?, scope? }`.
// `fields` follow `JSON.stringify` (`toJSON` honored, `undefined` and
// functions dropped, a `bigint` as its decimal string); fields that cannot be
// serialized (a cycle, a throwing `toJSON`) become `{ unserializable:
// <error message> }`. A record whose encoded `WriteBatchRequest` would pass
// 4 MiB (`maxMessageBytes`) goes to stdout at once. `fields` never carry the
// instance, trace or scope: `log/v1`'s provider stamps them from the batch
// call.
//
// Sending (after `start`): at most one batch is in flight. A batch is sent
// when none is in flight and either `batchSize` records wait or the oldest
// has waited `intervalMs`. A batch is the longest prefix of the waiting
// records, up to `batchSize`, whose trace and scope are equal; it is sent in
// that trace and scope, outside the asynchronous context of any handler,
// with a signal of its own aborted after `deadlineMs`. A failed batch goes
// to stdout at once, in order, and is not retried. A failure whose Doric
// code is `undeclared_requirement` or `unknown_contract` turns sending off
// for the rest of the process: what waits, and every later record, goes to
// stdout.
//
// The cap: at most `capacity` records wait (the batch in flight is not
// counted). A record that arrives when the queue is full writes the oldest
// waiting record to stdout and joins the queue. Nothing is dropped.
//
// Redactions: after `start` the queue keeps the last list
// `sink.watchRedactions` gave, across the watch's ends and failures. It
// applies only to stdout lines (message and every string leaf of the fields,
// not keys; each non-empty secret replaced by `[REDACTED]`), read when the
// line is written. Records sent to `log/v1` are not redacted here.
//
// Stdout lines: `JSON.stringify({ ...fields, level, message, bundleId,
// generation, incarnation, traceId? }) + '\n'`, `traceId` the second field
// of the record's `traceparent`.
//
// Timers are armed with `setTimeout` and time is read with `Date.now()`.

import { AsyncLocalStorage } from 'node:async_hooks';
import { writeSync as fsWriteSync } from 'node:fs';

import { create, type JsonObject, toBinary } from '@bufbuild/protobuf';
import { ConnectError, createClient } from '@connectrpc/connect';
import type { Http2SessionManager } from '@connectrpc/connect-node';
import { createAsyncIterable } from '@connectrpc/connect/protocol';

import type { Log, LogFields } from '../../contracts/basic/log.js';
import {
  type CallArg,
  type CallScope,
  isCall,
  type TraceContext,
} from '../../contracts/call.js';
import { ContractError, isContractError } from '../../contracts/error.js';
import {
  type LogRecord,
  LogRecordSchema,
  LogService,
  WriteBatchRequestSchema,
} from '../../contracts/gen/doric/log/v1/log_pb.js';
import { CallStartSchema } from '../../contracts/gen/doric/platform/v1/control_pb.js';
import { SecretsService } from '../../contracts/gen/doric/secrets/v1/secrets_pb.js';
import { maxMessageBytes } from '../../contracts/metadata.js';
import { fromConnectError } from '../../contracts/status.js';
import { reopenResumable } from '../../runtime/resumable.js';
import { newTrace } from '../../runtime/trace.js';
import { createRouterTransport } from './client.js';
import type { BundleInstance } from './context.js';
import { callFromStart, currentCall } from './serve.js';

/** The limits of the queue. Tests pass smaller values. */
export interface LogTimings {
  /** The most records one `WriteBatch` carries; 100. */
  readonly batchSize: number;
  /**
   * How long the oldest waiting record waits before a batch is sent even
   * with fewer than `batchSize` records waiting; 200 ms.
   */
  readonly intervalMs: number;
  /** The deadline of one batch; 5,000 ms. */
  readonly deadlineMs: number;
  /** The most records waiting, not counting the batch in flight; 10,000. */
  readonly capacity: number;
  /** The time `stop` may spend sending what waits; 5,000 ms. */
  readonly stopBudgetMs: number;
  /**
   * The deadline of each batch `stop` sends, and the longest `stop` waits
   * for the batch in flight when it is called; 2,000 ms, so `deactivate`
   * and the final send fit the platform's 10 s stop timeout. A batch past
   * it goes to stdout.
   */
  readonly finalDeadlineMs: number;
  /**
   * The wait before `WatchRedactions` is opened again after it failed or
   * ended (other than for good, see {@link LogSink.watchRedactions}); 5,000 ms.
   */
  readonly redactionRetryMs: number;
}

/** The values of spec A7. */
export const defaultLogTimings: LogTimings = Object.freeze({
  batchSize: 100,
  intervalMs: 200,
  deadlineMs: 5_000,
  capacity: 10_000,
  stopBudgetMs: 5_000,
  finalDeadlineMs: 2_000,
  redactionRetryMs: 5_000,
});

/**
 * Where the lines go that the queue does not send. Both write one complete
 * line (JSON and `\n`). Neither is expected to throw; a throw is swallowed
 * and the line is lost.
 */
export interface LogOutput {
  /** While the process runs; default `process.stdout.write`. */
  write(line: string): void;
  /**
   * At exit, so the write ends before the process does; default
   * `fs.writeSync(1, line)`.
   */
  writeSync(line: string): void;
}

/** The call context a batch is sent in: the one its records were written in. */
export interface LogBatchContext {
  /**
   * The `traceparent` of the call the records were written in. Absent:
   * records written outside every call; the batch starts a new trace.
   */
  readonly trace?: TraceContext;
  /** That call's scope; absent when it had none. */
  readonly scope?: CallScope;
  /** Aborted at the batch's deadline and when the queue gives up on it. */
  readonly signal: AbortSignal;
}

/**
 * What the queue writes to and reads the redaction list from. The default
 * (`routerLogSink`) is the router: `log/v1` and `secrets/v1` of whichever
 * bundle provides them. A part that provides `log/v1` itself (`core`) passes
 * its own through `BundleDefinition.logSink`.
 */
export interface LogSink {
  /**
   * Writes `records` (1 to `batchSize`, in order) as one
   * `log/v1.WriteBatch` made in `context`: its caller is this instance, and
   * its trace and scope are `context`'s, never those of the asynchronous
   * context the queue happens to run in. Resolves when the provider
   * answered. Rejects for anything else: an error answer, the signal, a
   * transport failure. The queue then writes the records to stdout. When the
   * rejection is a `ConnectError` or `ContractError` whose Doric code is
   * `undeclared_requirement` or `unknown_contract`, the queue sends no more
   * batches for the rest of the process.
   */
  writeBatch(
    records: readonly LogRecord[],
    context: LogBatchContext,
  ): Promise<void>;
  /**
   * The redaction lists of `secrets/v1.WatchRedactions`, each complete,
   * until `signal` aborts or the iteration fails. A failure with Doric code
   * `undeclared_requirement` or `unknown_contract` ends the watching for
   * good. Any other failure, or an end without error, makes the queue
   * iterate again after `redactionRetryMs`.
   */
  watchRedactions(signal: AbortSignal): AsyncIterable<readonly string[]>;
}

/** The queue behind `context.log`, owned by `startBundle`. */
export interface LogQueue {
  /**
   * The facade: synchronous, never throws, never awaited. Each call queues
   * one record with level, message and `fields`. The record also keeps the
   * trace and scope of `call` when `call` is a `Call` (`isCall`), else of
   * `currentCall()`, else none.
   */
  readonly log: Log;
  /**
   * Starts sending through `sink` and watching its redactions. `startBundle`
   * calls it once, on `Accepted`; until then records only wait. A second
   * call, or one after `stop` or `flushSync`, does nothing.
   */
  start(sink: LogSink): void;
  /**
   * The send "once more on `Stop`". It waits for the batch in flight (at
   * most `finalDeadlineMs`), then sends what waits, batch after batch, each
   * with the deadline `finalDeadlineMs`, until nothing waits or
   * `stopBudgetMs` has passed since `stop` was called; the last batch's
   * deadline is cut to what remains of the budget. A failed batch goes to
   * stdout with `output.write`. It then stops the redaction watch and
   * closes the queue: from then on each new record is written to stdout at
   * once with `output.write`, and whatever still waits is left for
   * `flushSync`. Never rejects. Later calls resolve with the first one.
   */
  stop(): Promise<void>;
  /**
   * The exit flush. It writes every waiting record, and every record of a
   * batch without an answer yet, to stdout with `output.writeSync`, oldest
   * first, each redacted. It then closes the queue: every later record is
   * written with `output.writeSync` at once. Idempotent; never throws.
   */
  flushSync(): void;
}

export interface LogQueueOptions {
  /** Stamped on each stdout line as `bundleId`, `generation`, `incarnation`. */
  readonly instance: BundleInstance;
  /** Default `defaultLogTimings`, overridden key by key. */
  readonly timings?: Partial<LogTimings>;
  /** Default the process's stdout (see {@link LogOutput}). */
  readonly output?: LogOutput;
}

/** Runs a function outside the asynchronous context of every handler. */
const outside = AsyncLocalStorage.snapshot();

/** The absolute deadline of each batch signal, read by `routerLogSink`. */
const deadlines = new WeakMap<AbortSignal, number>();

const redactedMarker = '[REDACTED]';

/** The codes after which the queue stops sending or watching for good. */
const refusalCodes: readonly string[] = [
  'undeclared_requirement',
  'unknown_contract',
];

const isRefusal = (error: unknown): boolean => {
  const code =
    error instanceof ConnectError
      ? fromConnectError(error).code
      : isContractError(error)
        ? error.code
        : undefined;

  return code !== undefined && refusalCodes.includes(code);
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** `fields` as JSON, following `JSON.stringify`; never throws. */
const jsonFieldsOf = (fields: LogFields | undefined): JsonObject | undefined => {
  if (fields === undefined) {
    return undefined;
  }

  try {
    const text = JSON.stringify(fields, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );

    if (text === undefined) {
      return undefined;
    }

    const parsed: unknown = JSON.parse(text);

    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : undefined;
  } catch (error) {
    return { unserializable: messageOf(error) };
  }
};

const redactText = (text: string, secrets: readonly string[]): string => {
  let redacted = text;

  for (const secret of secrets) {
    if (secret !== '') {
      redacted = redacted.split(secret).join(redactedMarker);
    }
  }

  return redacted;
};

/** `value` with every string leaf redacted; keys are kept. */
const redactValue = (value: unknown, secrets: readonly string[]): unknown => {
  if (typeof value === 'string') {
    return redactText(value, secrets);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactValue(item, secrets),
      ]),
    );
  }

  return value;
};

/** One record of the queue. */
interface QueuedRecord {
  readonly record: LogRecord;
  readonly trace?: TraceContext;
  readonly scope?: CallScope;
  /** Equal for records of one trace and scope. */
  readonly key: string;
  /** `Date.now()` when it was logged. */
  readonly at: number;
}

/** One `writeBatch` the queue made. */
interface Batch {
  readonly records: readonly QueuedRecord[];
  readonly controller: AbortController;
  readonly done: Promise<void>;
  finish(): void;
  settled: boolean;
  endsAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const scopeKeyOf = (scope: CallScope | undefined): string =>
  scope === undefined
    ? ''
    : JSON.stringify(
        Object.entries(scope).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );

const processOutput: LogOutput = {
  write: (line) => {
    process.stdout.write(line);
  },
  writeSync: (line) => {
    const buffer = Buffer.from(line);
    let offset = 0;

    while (offset < buffer.length) {
      try {
        offset += fsWriteSync(1, buffer, offset);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') {
          throw error;
        }
      }
    }
  },
};

/** Creates a queue in its waiting state. Makes no call and arms no timer. */
export const createLogQueue = (options: LogQueueOptions): LogQueue => {
  const limits: LogTimings = { ...defaultLogTimings, ...options.timings };
  const output = options.output ?? processOutput;
  const { instance } = options;
  const waiting: QueuedRecord[] = [];
  const watching = new AbortController();
  let phase: 'waiting' | 'running' | 'stopping' | 'stopped' | 'flushed' =
    'waiting';
  let sending = true;
  let sink: LogSink | undefined;
  let inFlight: Batch | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let redactions: readonly string[] = [];
  let stopping: Promise<void> | undefined;

  const lineOf = (queued: QueuedRecord): string => {
    const { record } = queued;
    const fields =
      record.fields === undefined
        ? {}
        : (redactValue(record.fields, redactions) as JsonObject);
    const traceId = queued.trace?.traceparent.split('-')[1];

    return `${JSON.stringify({
      ...fields,
      level: record.level,
      message: redactText(record.message, redactions),
      bundleId: instance.bundleId,
      generation: instance.generation,
      incarnation: instance.incarnation,
      ...(traceId === undefined ? {} : { traceId }),
    })}\n`;
  };

  /** Writes one record to stdout; `writeSync` once the queue is flushed. */
  const emit = (queued: QueuedRecord): void => {
    try {
      const line = lineOf(queued);

      if (phase === 'flushed') {
        output.writeSync(line);
      } else {
        output.write(line);
      }
    } catch {
      // the line is lost; the facade never throws
    }
  };

  const turnOff = (): void => {
    sending = false;
    clearTimeout(timer);
    timer = undefined;

    for (let next = waiting.shift(); next !== undefined; next = waiting.shift()) {
      emit(next);
    }
  };

  const settle = (batch: Batch, error: unknown, ok: boolean): void => {
    if (batch.settled) {
      return;
    }

    batch.settled = true;
    clearTimeout(batch.timer);

    if (inFlight === batch) {
      inFlight = undefined;
    }

    if (!ok) {
      for (const queued of batch.records) {
        emit(queued);
      }

      if (isRefusal(error)) {
        turnOff();
      }
    }

    batch.finish();
    pump();
  };

  const armDeadline = (batch: Batch, endsAt: number): void => {
    clearTimeout(batch.timer);
    batch.endsAt = endsAt;
    batch.timer = setTimeout(
      () => {
        const reason = new ContractError(
          'unavailable',
          'The log batch passed its deadline.',
        );

        batch.controller.abort(reason);
        settle(batch, reason, false);
      },
      Math.max(0, endsAt - Date.now()),
    );
  };

  /** Sends the first batch of what waits, with a deadline `deadlineMs` away. */
  const send = (current: LogSink, deadlineMs: number): Batch => {
    const [first] = waiting;
    let count = 1;

    while (
      count < limits.batchSize &&
      count < waiting.length &&
      waiting[count]?.key === first?.key
    ) {
      count += 1;
    }

    const records = waiting.splice(0, count);
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const batch: Batch = {
      records,
      controller: new AbortController(),
      done,
      finish,
      settled: false,
      endsAt: 0,
      timer: undefined,
    };
    const endsAt = Date.now() + deadlineMs;
    const { signal } = batch.controller;

    inFlight = batch;
    deadlines.set(signal, endsAt);
    armDeadline(batch, endsAt);

    const context: LogBatchContext = {
      signal,
      ...(first?.trace === undefined ? {} : { trace: first.trace }),
      ...(first?.scope === undefined ? {} : { scope: first.scope }),
    };
    let pending: Promise<void>;

    try {
      pending = outside(() =>
        current.writeBatch(
          records.map(({ record }) => record),
          context,
        ),
      );
    } catch (error) {
      pending = Promise.reject(error);
    }

    pending.then(
      () => settle(batch, undefined, true),
      (error: unknown) => settle(batch, error, false),
    );

    return batch;
  };

  /** Sends a batch when one is due, else arms the timer of the oldest. */
  function pump(): void {
    const [oldest] = waiting;

    if (
      phase !== 'running' ||
      !sending ||
      sink === undefined ||
      inFlight !== undefined ||
      oldest === undefined
    ) {
      return;
    }

    const due = oldest.at + limits.intervalMs;

    if (waiting.length >= limits.batchSize || Date.now() >= due) {
      clearTimeout(timer);
      timer = undefined;
      send(sink, limits.deadlineMs);

      return;
    }

    timer ??= setTimeout(() => {
      timer = undefined;
      pump();
    }, due - Date.now());
  }

  const recordOf = (
    level: string,
    message: string,
    fields: LogFields | undefined,
    call: CallArg | undefined,
  ): QueuedRecord => {
    const source = isCall(call) ? call : currentCall();
    const json = jsonFieldsOf(fields);
    const record = create(LogRecordSchema, {
      level,
      message,
      ...(json === undefined ? {} : { fields: json }),
    });
    const scope =
      source?.scope !== undefined && Object.keys(source.scope).length > 0
        ? source.scope
        : undefined;

    return {
      record,
      ...(source === undefined ? {} : { trace: source.trace }),
      ...(scope === undefined ? {} : { scope }),
      key: `${source?.trace.traceparent ?? ''}\u0000${scopeKeyOf(scope)}`,
      at: Date.now(),
    };
  };

  const tooLarge = (record: LogRecord): boolean => {
    try {
      return (
        toBinary(WriteBatchRequestSchema, create(WriteBatchRequestSchema, { record }))
          .byteLength > maxMessageBytes
      );
    } catch {
      return true;
    }
  };

  const level =
    (name: string) =>
    (message: string, fields?: LogFields, call?: CallArg): void => {
      try {
        const queued = recordOf(name, message, fields, call);

        if (
          phase === 'flushed' ||
          phase === 'stopped' ||
          !sending ||
          tooLarge(queued.record)
        ) {
          emit(queued);

          return;
        }

        if (waiting.length >= limits.capacity) {
          const oldest = waiting.shift();

          if (oldest !== undefined) {
            emit(oldest);
          }
        }

        waiting.push(queued);
        pump();
      } catch {
        // the facade never throws
      }
    };

  const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(wait);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const wait = setTimeout(done, ms);

      signal.addEventListener('abort', done, { once: true });
    });

  const watch = async (current: LogSink): Promise<void> => {
    const { signal } = watching;

    while (!signal.aborted) {
      try {
        for await (const list of current.watchRedactions(signal)) {
          redactions = list;

          if (signal.aborted) {
            return;
          }
        }
      } catch (error) {
        if (isRefusal(error)) {
          return;
        }
      }

      if (signal.aborted) {
        return;
      }

      await sleep(limits.redactionRetryMs, signal);
    }
  };

  const runStop = async (): Promise<void> => {
    if (phase !== 'running') {
      if (phase === 'waiting') {
        phase = 'stopped';
      }

      watching.abort();

      return;
    }

    const budgetEnd = Date.now() + limits.stopBudgetMs;

    phase = 'stopping';
    clearTimeout(timer);
    timer = undefined;

    if (inFlight !== undefined) {
      const batch = inFlight;

      armDeadline(
        batch,
        Math.min(
          batch.endsAt,
          Date.now() + Math.min(limits.finalDeadlineMs, limits.stopBudgetMs),
        ),
      );
      await batch.done;
    }

    while (
      (phase as string) === 'stopping' &&
      sending &&
      sink !== undefined &&
      waiting.length > 0
    ) {
      const remaining = budgetEnd - Date.now();

      if (remaining <= 0) {
        break;
      }

      await send(sink, Math.min(limits.finalDeadlineMs, remaining)).done;
    }

    watching.abort();

    if ((phase as string) === 'stopping') {
      phase = 'stopped';
    }
  };

  return {
    log: {
      debug: level('debug'),
      info: level('info'),
      warn: level('warn'),
      error: level('error'),
    },
    start: (given) => {
      if (phase !== 'waiting') {
        return;
      }

      sink = given;
      phase = 'running';
      outside(() => {
        void watch(given);
      });
      outside(pump);
    },
    stop: () => {
      stopping ??= outside(runStop).catch(() => undefined);

      return stopping;
    },
    flushSync: () => {
      if (phase === 'flushed') {
        return;
      }

      phase = 'flushed';
      clearTimeout(timer);
      timer = undefined;
      watching.abort();

      const batch = inFlight;

      inFlight = undefined;

      if (batch !== undefined && !batch.settled) {
        batch.settled = true;
        clearTimeout(batch.timer);

        for (const queued of batch.records) {
          emit(queued);
        }

        batch.controller.abort(
          new ContractError('unavailable', 'The process exits.'),
        );
        batch.finish();
      }

      for (
        let next = waiting.shift();
        next !== undefined;
        next = waiting.shift()
      ) {
        emit(next);
      }
    },
  };
};

/**
 * The default sink: the router at `url`, with `token`, over the sessions of
 * `sessionManager` (shared with the control stream).
 * - `writeBatch` is `LogService.WriteBatch` with `grpc-timeout` set by the
 *   signal's deadline, and a `traceparent` that is a child of
 *   `context.trace` (a new trace without one). It carries `doric-scope-bin`
 *   for `context.scope`. It does not inherit `currentCall()`.
 * - `watchRedactions` is `SecretsService.WatchRedactions({})` as
 *   `context.services.use` iterates it, reopened on `generation_lost`
 *   (`reopenResumable`).
 * Creating it makes no call and never throws.
 */
export const routerLogSink = (options: {
  readonly url: string;
  readonly token: string;
  readonly sessionManager: Http2SessionManager;
}): LogSink => {
  /** A transport whose calls are children of a call of `start`. */
  const transportOf = (
    start: { traceparent: string; scope?: CallScope; deadlineUnixMs?: number },
    signal: AbortSignal,
  ) =>
    createRouterTransport({
      url: options.url,
      token: options.token,
      sessionManager: options.sessionManager,
      parent: callFromStart(
        create(CallStartSchema, {
          traceparent: start.traceparent,
          scope: { ...start.scope },
          deadlineUnixMs: start.deadlineUnixMs ?? 0,
        }),
        signal,
      ),
    });

  return {
    writeBatch: async (records, context) => {
      const client = createClient(
        LogService,
        transportOf(
          {
            traceparent: (context.trace ?? newTrace()).traceparent,
            ...(context.scope === undefined ? {} : { scope: context.scope }),
            deadlineUnixMs: deadlines.get(context.signal) ?? 0,
          },
          context.signal,
        ),
      );

      await client.writeBatch(
        createAsyncIterable(
          records.map((record) => create(WriteBatchRequestSchema, { record })),
        ),
        { signal: context.signal },
      );
    },
    watchRedactions: (signal) => {
      const client = createClient(
        SecretsService,
        transportOf({ traceparent: newTrace().traceparent }, signal),
      );
      const items = reopenResumable(
        (request: Record<string, never>) =>
          client.watchRedactions(request, { signal }),
        {},
      );

      return {
        async *[Symbol.asyncIterator]() {
          for await (const item of items) {
            yield item.redactions;
          }
        },
      };
    },
  };
};
