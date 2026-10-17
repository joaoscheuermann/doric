import type { z } from 'zod';

import type { Call } from '../../contracts/call.js';
import type { Disposable } from '../../contracts/context.js';
import { ContractError } from '../../contracts/error.js';
import { PLATFORM_BUNDLE_ID } from '../../contracts/ids.js';
import type { DiagnosticReport } from '../../contracts/platform.js';
import { createHopCall } from '../call.js';
import type { ProviderRecord } from '../directory.js';
import type { Principal } from '../principal.js';
import { DisposalScope, toDisposable } from '../scope.js';
import { PLATFORM_VERSION } from '../version.js';
import { restoreCall, timeoutError, toWireCall } from './call-meta.js';
import { decodeError, type ErrorClassRegistry, encodeError } from './errors.js';
import {
  type CallMessage,
  type ControlMessage,
  type InvokeMessage,
  isControlMessage,
  type WireCall,
  type WireMessage,
  wireMessageSchema,
} from './messages.js';
import type { SchemaValidators } from './validators.js';
import {
  anyKinds,
  type CodecContext,
  type CodecHost,
  decodeValue,
  type ExportTarget,
  encodeValue,
  invokeExport,
  localOnly,
  planFor,
} from './values.js';

/** One side of a process channel. */
export interface Transport {
  /** Throws once the channel is closed. */
  send(message: WireMessage): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: (reason: LinkCloseReason) => void): () => void;
  close(): void;
}

export type LinkCloseReason =
  | { readonly kind: 'stopped' }
  | {
      readonly kind: 'exited';
      readonly code: number | null;
      readonly signal: string | null;
    }
  | { readonly kind: 'disconnected' };

export interface ResolveTarget {
  readonly contract: string;
  readonly method: string;
  readonly provider?: string;
  /** The record key the sender resolved, for a bundle with several records. */
  readonly record?: string;
}

export interface ProcessLinkOptions {
  readonly transport: Transport;
  /** The kernel overwrites `caller.generation` and checks the call generation. */
  readonly side: 'kernel' | 'generation';
  /** The generation of the process on the generation side of this link. */
  readonly generation: number;
  readonly incarnation?: number;
  readonly validators: SchemaValidators;
  readonly errors: ErrorClassRegistry;
  /** The local provider an inbound call targets; never a remote record. */
  resolve(target: ResolveTarget): ProviderRecord | undefined;
  /** The principal of a bundle of this process (scoped callbacks). */
  principalOf?(bundleId: string): Principal | undefined;
  /** Diagnostics of this process. */
  report?(entry: DiagnosticReport): void;
  /** Aborts the calls this side serves (the receiving runtime's generation). */
  readonly generationSignal?: AbortSignal;
  readonly now?: () => number;
}

interface Pending {
  resolve(output: unknown): void;
  reject(error: unknown): void;
}

interface Operations {
  readonly pending: Set<Promise<void>>;
  readonly failures: unknown[];
}

interface Run {
  readonly scope: DisposalScope;
  readonly cleanup?: () => unknown;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const describeIssues = (error: z.ZodError): string =>
  error.issues
    .map(
      (issue) =>
        `${issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : ''}${issue.message}`,
    )
    .join('; ');

const issuesOf = (error: z.ZodError) =>
  error.issues.map(({ code, path, message }) => ({
    code,
    path: path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
    message,
  }));

/**
 * One end of the RPC envelope between the kernel and a generation process:
 * request correlation, cancellation, deadlines, exported and imported
 * handles, optimistic registrations and the close of the channel.
 */
export class ProcessLink implements CodecHost {
  readonly side: 'kernel' | 'generation';
  readonly generation: number;
  readonly incarnation: number;
  readonly validators: SchemaValidators;
  readonly mirrors = new Map<string, unknown>();
  readonly #options: ProcessLinkOptions;
  readonly #tag: string;
  readonly #pending = new Map<string, Pending>();
  readonly #serving = new Map<
    string,
    { readonly controller: AbortController; readonly deadline: number }
  >();
  readonly #exports = new Map<string, ExportTarget>();
  readonly #runs = new Map<string, Run>();
  readonly #operations = new Map<string, Operations>();
  readonly #activating = new Map<string, number>();
  readonly #sentGenerations = new Set<number>();
  readonly #closeListeners = new Set<(reason: LinkCloseReason) => void>();
  readonly #idleListeners = new Set<() => void>();
  #inbound = 0;
  readonly #controlListeners = new Set<(message: ControlMessage) => void>();
  readonly #closed = new AbortController();
  readonly #detach: (() => void)[] = [];
  #counter = 0;
  #reason: LinkCloseReason | undefined;

  constructor(options: ProcessLinkOptions) {
    this.#options = options;
    this.side = options.side;
    this.generation = options.generation;
    this.incarnation = options.incarnation ?? 1;
    this.validators = options.validators;
    this.#tag = options.side === 'kernel' ? 'k' : 'g';
    this.#sentGenerations.add(options.generation);
    this.#detach.push(
      options.transport.onMessage((message) => this.#receive(message)),
      options.transport.onClose((reason) => this.#close(reason)),
    );
  }

  /** Set once the channel closed; every later call rejects `generation_lost`. */
  get closeReason(): LinkCloseReason | undefined {
    return this.#reason;
  }

  /** Aborted when the channel closes. */
  get closeSignal(): AbortSignal {
    return this.#closed.signal;
  }

  onClose(listener: (reason: LinkCloseReason) => void): () => void {
    if (this.#reason !== undefined) {
      listener(this.#reason);

      return () => undefined;
    }

    this.#closeListeners.add(listener);

    return () => this.#closeListeners.delete(listener);
  }

  /** Outbound calls awaiting a result plus inbound calls not yet answered. */
  get inFlight(): number {
    return this.#pending.size + this.#inbound;
  }

  /** Called each time `inFlight` drops to zero. */
  onIdle(listener: () => void): () => void {
    this.#idleListeners.add(listener);

    return () => this.#idleListeners.delete(listener);
  }

  #settled(): void {
    if (this.inFlight !== 0 || this.#reason !== undefined) {
      return;
    }

    for (const listener of [...this.#idleListeners]) {
      listener();
    }
  }

  onControl(listener: (message: ControlMessage) => void): () => void {
    this.#controlListeners.add(listener);

    return () => this.#controlListeners.delete(listener);
  }

  sendControl(message: ControlMessage): void {
    this.#send(message);
  }

  /** Closes the channel from this side. */
  close(): void {
    this.#options.transport.close();
    this.#close({ kind: 'stopped' });
  }

  // Outbound ------------------------------------------------------------------

  #lost(): ContractError {
    return new ContractError(
      'generation_lost',
      `Generation ${this.generation} exited.`,
      { generation: this.generation, incarnation: this.incarnation },
    );
  }

  #id(prefix: string): string {
    this.#counter += 1;

    return `${this.#tag}:${prefix}${this.#counter}`;
  }

  #send(message: WireMessage): void {
    if (this.#reason !== undefined) {
      throw this.#lost();
    }

    this.#options.transport.send(message);
  }

  #meta(call: Call): WireCall {
    const meta = toWireCall(call);

    this.#sentGenerations.add(meta.generation);

    return meta;
  }

  /** Sends a request and resolves with the encoded output of its result. */
  #request(
    build: (id: string, meta: WireCall) => CallMessage | InvokeMessage,
    call: Call,
  ): Promise<unknown> {
    if (this.#reason !== undefined) {
      return Promise.reject(this.#lost());
    }

    const id = this.#id('c');
    const message = build(id, this.#meta(call));

    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        if (this.#pending.has(id)) {
          try {
            this.#send({ kind: 'cancel', id });
          } catch {
            // The channel closed; the pending call rejects on its own.
          }
        }
      };
      const done = () => call.signal.removeEventListener('abort', onAbort);

      this.#pending.set(id, {
        resolve: (output) => {
          done();
          resolve(output);
          this.#settled();
        },
        reject: (error) => {
          done();
          reject(error);
          this.#settled();
        },
      });

      try {
        this.#send(message);
      } catch (error) {
        this.#pending.delete(id);
        done();
        reject(error);
        this.#settled();

        return;
      }

      // Advisory only: the provider decides how an aborted call ends.
      if (call.signal.aborted) {
        onAbort();
      } else {
        call.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /** A service call; resolves with the encoded output. */
  request(
    target: {
      readonly contract: string;
      readonly method: string;
      readonly input: unknown;
      readonly provider?: string;
      readonly record?: string;
    },
    call: Call,
  ): Promise<unknown> {
    return this.#request(
      (id, meta) => ({ kind: 'call', id, ...target, ...meta }),
      call,
    );
  }

  /** A fire-and-forget service call; a send failure is swallowed. */
  oneway(
    target: {
      readonly contract: string;
      readonly method: string;
      readonly input: unknown;
      readonly provider?: string;
      readonly record?: string;
    },
    call: Call,
  ): void {
    try {
      this.#send({
        kind: 'call',
        id: this.#id('c'),
        ...target,
        ...this.#meta(call),
        oneway: true,
      });
    } catch {
      // Never throws, as in-process.
    }
  }

  /**
   * A synchronous registration across the envelope: returns a local
   * Disposable at once; the acknowledgement or the refusal arrives later and
   * is collected by `settle`.
   */
  optimistic(
    bundleId: string,
    target: {
      readonly contract: string;
      readonly method: string;
      readonly input: unknown;
      readonly provider?: string;
      readonly record?: string;
    },
    call: Call,
    exported: readonly string[],
  ): Disposable {
    let disposed = false;
    let remote: Disposable | undefined;
    const forget = () => {
      for (const handle of exported) {
        this.#exports.delete(handle);
      }
    };
    const operations = this.#operationsOf(bundleId);
    const operation = this.request(target, call).then(
      (output) => {
        const value = decodeValue(output, { host: this, call }) as
          | Disposable
          | undefined;

        if (disposed) {
          value?.dispose();
        } else {
          remote = value;
        }
      },
      (error: unknown) => {
        forget();
        this.#fail(bundleId, error);
      },
    );

    operations.pending.add(operation);
    void operation.finally(() => operations.pending.delete(operation));

    return toDisposable(() => {
      disposed = true;
      remote?.dispose();
      forget();
    });
  }

  #operationsOf(bundleId: string): Operations {
    let operations = this.#operations.get(bundleId);

    if (operations === undefined) {
      operations = { pending: new Set(), failures: [] };
      this.#operations.set(bundleId, operations);
    }

    return operations;
  }

  #fail(bundleId: string, error: unknown): void {
    if ((this.#activating.get(bundleId) ?? 0) > 0) {
      this.#operationsOf(bundleId).failures.push(error);

      return;
    }

    this.#options.report?.({
      bundleId,
      kind: 'registration_failed',
      message: messageOf(error),
    });
  }

  /**
   * Marks a bundle as activating: refusals of its optimistic registrations
   * are kept for `settle` instead of being reported. Returns the end mark.
   */
  activating(bundleId: string): () => void {
    this.#activating.set(bundleId, (this.#activating.get(bundleId) ?? 0) + 1);

    let ended = false;

    return () => {
      if (!ended) {
        ended = true;
        this.#activating.set(
          bundleId,
          (this.#activating.get(bundleId) ?? 1) - 1,
        );
      }
    };
  }

  /**
   * Resolves when every optimistic registration of the bundle is
   * acknowledged; rejects with the first refusal (the original error).
   */
  async settle(bundleId: string): Promise<void> {
    const operations = this.#operationsOf(bundleId);

    while (operations.pending.size > 0) {
      await Promise.allSettled([...operations.pending]);
    }

    const [first] = operations.failures.splice(0);

    if (first !== undefined) {
      throw first;
    }
  }

  // CodecHost -------------------------------------------------------------------

  exportHandle(target: ExportTarget): string {
    const handle = this.#id('h');

    this.#exports.set(handle, target);

    return handle;
  }

  exported(handle: string): ExportTarget | undefined {
    return this.#exports.get(handle);
  }

  async invoke(
    handle: string,
    method: string | undefined,
    args: readonly unknown[],
    call: Call,
  ): Promise<unknown> {
    const context: CodecContext = { host: this, call };
    const encoded = encodeValue([...args], anyKinds, context) as unknown[];
    const output = await this.#request(
      (id, meta) => ({
        kind: 'invoke',
        id,
        handle,
        ...(method === undefined ? {} : { method }),
        args: encoded,
        ...meta,
      }),
      call,
    );

    return decodeValue(output, context);
  }

  run(handle: string, call: Call): string {
    const run = this.#id('r');

    this.#request(
      (id, meta) => ({
        kind: 'invoke',
        id,
        handle,
        method: 'run',
        args: [run],
        ...meta,
      }),
      call,
    ).catch((error: unknown) =>
      this.report(call.caller.bundleId, 'when_available_failed', error),
    );

    return run;
  }

  release(handle: string): void {
    try {
      this.#send({ kind: 'release', handle });
    } catch {
      // Closed: the other side released everything already.
    }
  }

  detachedCall(): Call {
    return createHopCall({
      caller: {
        bundleId: PLATFORM_BUNDLE_ID,
        version: PLATFORM_VERSION,
        generation: this.generation,
      },
      generationSignal: this.#closed.signal,
      defaultGeneration: this.side === 'generation' ? this.generation : 0,
      ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
    });
  }

  principalOf(bundleId: string): Principal | undefined {
    return this.#options.principalOf?.(bundleId);
  }

  report(bundleId: string, kind: string, error: unknown): void {
    this.#options.report?.({ bundleId, kind, message: messageOf(error) });
  }

  // Inbound -------------------------------------------------------------------

  #reply(id: string, outcome: { output: unknown } | { error: unknown }): void {
    try {
      this.#send(
        'output' in outcome
          ? { kind: 'result', id, ok: true, output: outcome.output }
          : {
              kind: 'result',
              id,
              ok: false,
              error: encodeError(outcome.error),
            },
      );
    } catch (error) {
      if (this.#reason === undefined && 'output' in outcome) {
        // The output could not be cloned: answer with that failure instead.
        this.#reply(id, { error });
      }
    }
  }

  #protocolError(raw: unknown, message: string): void {
    this.#options.report?.({
      bundleId: PLATFORM_BUNDLE_ID,
      kind: 'protocol_error',
      message,
    });

    const record = raw as { kind?: unknown; id?: unknown } | null;

    if (
      typeof record === 'object' &&
      record !== null &&
      (record.kind === 'call' ||
        record.kind === 'invoke' ||
        record.kind === 'subscribe') &&
      typeof record.id === 'string'
    ) {
      this.#reply(record.id, {
        error: new ContractError('protocol_error', message),
      });
    }
  }

  #receive(raw: unknown): void {
    if (this.#reason !== undefined) {
      return;
    }

    const parsed = wireMessageSchema.safeParse(raw);

    if (!parsed.success) {
      this.#protocolError(
        raw,
        `Invalid envelope message: ${describeIssues(parsed.error)}`,
      );

      return;
    }

    // The original message: the parsed copy would drop undefined values.
    const message = raw as WireMessage;

    if (isControlMessage(message)) {
      for (const listener of [...this.#controlListeners]) {
        listener(message);
      }

      return;
    }

    switch (message.kind) {
      case 'result': {
        const pending = this.#pending.get(message.id);

        if (pending !== undefined) {
          this.#pending.delete(message.id);

          if (message.ok) {
            pending.resolve(message.output);
          } else {
            pending.reject(decodeError(message.error, this.#options.errors));
          }
        }

        return;
      }
      case 'cancel':
        this.#cancel(message.id);

        return;
      case 'release':
        this.#released(message.handle);

        return;
      case 'call':
      case 'invoke':
        if (
          this.side === 'kernel' &&
          !this.#sentGenerations.has(message.generation)
        ) {
          this.#protocolError(
            message,
            `A message of generation ${this.generation} carries generation ${message.generation}.`,
          );

          return;
        }

        this.#inbound += 1;
        void (
          message.kind === 'call'
            ? this.#serveCall(message)
            : this.#serveInvoke(message)
        ).finally(() => {
          this.#inbound -= 1;
          this.#settled();
        });

        return;
      default:
        // Reserved for the bridge and streaming consumers.
        this.#protocolError(
          message,
          `Envelope message kind "${message.kind}" is not supported.`,
        );
    }
  }

  #restore(
    message: CallMessage | InvokeMessage,
    hop: boolean,
  ): {
    call: Call;
    controller: AbortController;
  } {
    const controller = new AbortController();
    const signals = [controller.signal, this.#closed.signal];

    if (this.#options.generationSignal !== undefined) {
      signals.push(this.#options.generationSignal);
    }

    const call = restoreCall(message, {
      signals,
      ...(hop && this.side === 'kernel'
        ? { callerGeneration: this.generation }
        : {}),
      ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
    });

    this.#serving.set(message.id, { controller, deadline: message.deadline });

    return { call, controller };
  }

  /**
   * A cancel that arrives once the deadline elapsed is that deadline: the
   * sender's signal aborted with the timeout, so the provider sees it too.
   */
  #cancel(id: string): void {
    const serving = this.#serving.get(id);

    if (serving === undefined) {
      return;
    }

    const now = this.#options.now ?? Date.now;

    serving.controller.abort(
      serving.deadline > 0 && now() >= serving.deadline
        ? timeoutError()
        : undefined,
    );
  }

  async #serveCall(message: CallMessage): Promise<void> {
    const { contract, method } = message;
    let served = false;

    try {
      const record = this.#options.resolve({
        contract,
        method,
        ...(message.provider === undefined
          ? {}
          : { provider: message.provider }),
        ...(message.record === undefined ? {} : { record: message.record }),
      });

      if (record === undefined) {
        throw new ContractError(
          'unavailable',
          `No active provider of "${contract}".`,
          { contract },
        );
      }

      const spec = Object.hasOwn(record.methods, method)
        ? record.methods[method]
        : undefined;

      if (spec === undefined) {
        throw new ContractError(
          'unavailable',
          `Contract "${contract}" has no method "${method}".`,
          { contract, method },
        );
      }

      const plan = planFor(contract, method, spec);

      if (plan.refused !== undefined) {
        throw localOnly(plan.refused);
      }

      const { call } = this.#restore(message, true);

      served = true;

      const context: CodecContext = { host: this, call };
      const input =
        plan.input === undefined
          ? message.input
          : decodeValue(message.input, context);
      const parsed = spec.input.safeParse(input);

      if (!parsed.success) {
        throw new ContractError(
          'invalid_input',
          `Invalid input for ${contract} ${method}: ${describeIssues(parsed.error)}`,
          { contract, method, issues: issuesOf(parsed.error) },
        );
      }

      const result = await record.invoke(method, parsed.data, call);
      const checked = spec.output.safeParse(result);

      if (!checked.success) {
        throw new ContractError(
          'invalid_output',
          `Invalid output from ${contract} ${method} (bundle "${record.bundleId}"): ${describeIssues(checked.error)}`,
          { contract, method, issues: issuesOf(checked.error) },
        );
      }

      if (message.oneway !== true) {
        // The original value, never the parsed copy.
        this.#reply(message.id, {
          output:
            plan.output === undefined
              ? result
              : encodeValue(result, plan.output, context),
        });
      }
    } catch (error) {
      if (message.oneway !== true) {
        this.#reply(message.id, { error });
      }
    } finally {
      if (served) {
        this.#serving.delete(message.id);
      }
    }
  }

  async #serveInvoke(message: InvokeMessage): Promise<void> {
    const target = this.#exports.get(message.handle);

    if (target === undefined) {
      this.#reply(message.id, {
        error: new ContractError(
          'unavailable',
          `Handle "${message.handle}" was released.`,
        ),
      });

      return;
    }

    // Not a dispatcher hop: the caller is kept as sent.
    const { call } = this.#restore(message, false);
    const context: CodecContext = { host: this, call };

    try {
      const args = decodeValue(message.args, context) as unknown[];
      let result: unknown;

      if (
        message.method === 'run' &&
        target.kind === 'callback' &&
        target.mode === 'scoped'
      ) {
        this.#startRun(target, String(args[0]));
      } else {
        result = await invokeExport(target, message.method, args, call);
      }

      this.#reply(message.id, {
        output: encodeValue(result, anyKinds, context),
      });
    } catch (error) {
      this.#reply(message.id, { error });
    } finally {
      this.#serving.delete(message.id);
    }
  }

  #startRun(
    target: Extract<ExportTarget, { kind: 'callback' }>,
    run: string,
  ): void {
    const scope =
      target.parentScope?.child() ??
      new DisposalScope((error) =>
        this.report(PLATFORM_BUNDLE_ID, 'dispose_failed', error),
      );
    const result =
      target.principal === undefined
        ? target.fn()
        : target.principal.runInScope(scope, () => target.fn());

    this.#runs.set(run, {
      scope,
      ...(typeof result === 'function'
        ? { cleanup: result as () => unknown }
        : {}),
    });
  }

  #released(handle: string): void {
    const run = this.#runs.get(handle);

    if (run !== undefined) {
      this.#runs.delete(handle);
      // The run's registrations first, then the callback's own cleanup.
      void (async () => {
        await run.scope.dispose();
        await run.cleanup?.();
      })().catch((error: unknown) =>
        this.report(PLATFORM_BUNDLE_ID, 'when_available_failed', error),
      );

      return;
    }

    const target = this.#exports.get(handle);

    if (target === undefined) {
      return;
    }

    this.#exports.delete(handle);

    if (target.kind === 'disposable') {
      try {
        target.value.dispose();
      } catch (error) {
        this.report(PLATFORM_BUNDLE_ID, 'dispose_failed', error);
      }
    }
  }

  #close(reason: LinkCloseReason): void {
    if (this.#reason !== undefined) {
      return;
    }

    this.#reason = reason;

    for (const detach of this.#detach.splice(0)) {
      detach();
    }

    // Listeners first (the manager's `onLost`), then the rejections.
    for (const listener of [...this.#closeListeners]) {
      try {
        listener(reason);
      } catch (error) {
        this.report(PLATFORM_BUNDLE_ID, 'link_close_failed', error);
      }
    }

    this.#closeListeners.clear();

    const lost = this.#lost();

    this.#closed.abort(lost);

    for (const pending of [...this.#pending.values()]) {
      pending.reject(lost);
    }

    this.#pending.clear();

    // What the other side registered here ends with it.
    for (const handle of [...this.#runs.keys(), ...this.#exports.keys()]) {
      this.#released(handle);
    }
  }
}
