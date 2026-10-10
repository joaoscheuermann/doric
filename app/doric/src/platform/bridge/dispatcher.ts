// The single IPC dispatcher of every window and the splash (decision 71,
// section 14.3): one `ipcMain.handle('doric:desktop')`. Main is the trust
// point: it checks the sender, pins the window's generation, fills the
// caller and the window key, validates inputs and outputs against the
// published JSON Schemas and routes to the generation process or the host.

import {
  ContractError,
  type JsonObject,
  toContractError,
} from 'bundle/contracts';
import {
  type ProviderRecord,
  restoreCall,
  type SchemaValidators,
  type WireCall,
} from 'bundle/runtime';
import {
  type BridgeCallEnvelope,
  type BridgeError,
  type BridgeResultPayload,
  type CloseAnswer,
  type DesktopRequest,
  desktopRequestSchema,
  SHELL_CONTRACT,
  type ShellKeybinding,
  shellCommandResultSchema,
  shellDiagnosticSchema,
  type WindowChrome,
  type WindowDescription,
  type WindowFailure,
  type WindowMode,
} from 'desktop-client/protocol';
import { z } from 'zod';

import type { GenerationProcess } from '../generation/process';
import type { PlatformLog } from '../log';
import {
  recoveryActionSchema,
  SPLASH_CONTRACT,
  type SplashState,
} from '../splash/state';
import { type PushTarget, push } from '../windows/push';
import type { WindowEntry, WindowRegistry } from '../windows/registry';
import {
  clientPartOf,
  type GenerationView,
  mayUse,
  routeOf,
} from './client-routing';
import type { HostBridge } from './host-bridge';
import { hostUnavailable } from './host-bridge';
import { isShellSender, SENDER_REFUSED_MESSAGE } from './sender';
import { describeSchemaIssues } from './validation';

/** What Electron hands an `ipcMain.handle` listener. */
export interface DesktopEvent {
  readonly sender: PushTarget & {
    readonly id: number;
    readonly mainFrame?: unknown;
    getURL(): string;
    reload(): void;
    once(event: 'destroyed', listener: () => void): void;
  };
  readonly senderFrame?: { readonly url: string } | null;
}

export interface DispatcherDeps {
  readonly registry: WindowRegistry;
  readonly validators: SchemaValidators;
  readonly host: HostBridge;
  readonly log: PlatformLog;
  /** The splash's webContents, while it is open. */
  readonly splashContents: () => number | undefined;
  readonly splashStates: {
    subscribe(listener: (state: SplashState) => void): () => void;
  };
  readonly splashAct: (
    action: z.output<typeof recoveryActionSchema>,
  ) => Promise<void>;
  /** The generation's view while main retains it. */
  readonly view: (generation: number) => GenerationView | undefined;
  readonly process: (generation: number) => GenerationProcess | undefined;
  /** The generation a window that never pinned one is told to use. */
  readonly pinWindow: (entry: WindowEntry, generation: number) => boolean;
  readonly chrome: (entry: WindowEntry | undefined) => WindowChrome;
  readonly tokens: () => Readonly<Record<string, string>>;
  readonly answerClose: (id: string, answer: CloseAnswer) => void;
  readonly windowReady: (entry: WindowEntry) => void;
  readonly windowFailure: (entry: WindowEntry, failure: WindowFailure) => void;
  readonly bindingsFor: (entry: WindowEntry) => readonly ShellKeybinding[];
  readonly dispatchCommand: (
    command: string,
    origin: { readonly windowKey: string | null },
  ) => Promise<void>;
  /** Client diagnostics a window forwards (main reports them to the host). */
  readonly diagnostic: (entry: WindowEntry, diagnostic: unknown) => void;
  readonly now?: () => number;
}

const ok = (output: unknown): BridgeResultPayload => ({ ok: true, output });

const failure = (error: unknown): BridgeResultPayload => {
  const contractError = toContractError(error);
  const bridgeError: BridgeError = {
    code: contractError.code,
    message: contractError.message,
    ...(contractError.details === undefined
      ? {}
      : { details: contractError.details }),
  };

  return { ok: false, error: bridgeError };
};

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
};

interface OpenCall {
  readonly controller: AbortController;
  readonly contents: number;
}

interface OpenStream {
  readonly contents: number;
  dispose(): void;
}

/** One client-command request main pushed to a window (section 18.3). */
interface PendingCommand {
  readonly resolve: (
    result: { ok: true } | { ok: false; error: BridgeError },
  ) => void;
}

export class Dispatcher {
  readonly #deps: DispatcherDeps;
  readonly #calls = new Map<string, OpenCall>();
  readonly #streams = new Map<string, OpenStream>();
  /** Per webContents: the shell `keybindings` and `commands` streams. */
  readonly #keybindingStreams = new Map<
    number,
    Map<string, (table: readonly ShellKeybinding[]) => void>
  >();
  readonly #commandStreams = new Map<
    number,
    Map<string, (request: unknown) => void>
  >();
  readonly #lastTables = new Map<number, string>();
  readonly #commands = new Map<string, PendingCommand>();
  readonly #watched = new Set<number>();
  #commandCounter = 0;

  constructor(deps: DispatcherDeps) {
    this.#deps = deps;
  }

  /** The `ipcMain.handle` listener. */
  async handle(event: DesktopEvent, raw: unknown): Promise<unknown> {
    const frameUrl = event.senderFrame?.url;
    const contentsId = event.sender.id;
    const entry = this.#deps.registry.byWebContents(contentsId);
    const splash = this.#deps.splashContents() === contentsId;

    if (
      !isShellSender(frameUrl) ||
      (entry === undefined && !splash) ||
      (event.sender.mainFrame !== undefined &&
        event.senderFrame !== event.sender.mainFrame &&
        event.senderFrame !== undefined)
    ) {
      throw new Error(SENDER_REFUSED_MESSAGE);
    }

    const parsed = desktopRequestSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error(`Invalid desktop request: ${parsed.error.message}`);
    }

    this.#watch(event.sender);

    const request = parsed.data;

    if (splash) {
      return await this.#splash(event, request);
    }

    return await this.#window(event, entry as WindowEntry, request);
  }

  #watch(sender: DesktopEvent['sender']): void {
    if (this.#watched.has(sender.id)) {
      return;
    }

    this.#watched.add(sender.id);

    const id = sender.id;

    sender.once('destroyed', () => {
      this.#watched.delete(id);
      this.#endFor(id);
    });
  }

  /** A navigation or a close ends every call and stream of that window. */
  #endFor(contents: number): void {
    for (const [id, call] of [...this.#calls]) {
      if (call.contents === contents) {
        this.#calls.delete(id);
        call.controller.abort();
      }
    }

    for (const [id, stream] of [...this.#streams]) {
      if (stream.contents === contents) {
        this.#streams.delete(id);
        stream.dispose();
      }
    }

    this.#keybindingStreams.delete(contents);
    this.#commandStreams.delete(contents);
    this.#lastTables.delete(contents);
  }

  /** The window's document is being replaced (main-frame navigation). */
  navigating(contents: number): void {
    this.#endFor(contents);
  }

  // Splash ---------------------------------------------------------------------

  async #splash(
    event: DesktopEvent,
    request: DesktopRequest,
  ): Promise<unknown> {
    switch (request.op) {
      case 'describeWindow':
        return {
          key: null,
          kind: 'technical',
          path: pathOf(event.sender.getURL()),
          generation: null,
          chrome: this.#deps.chrome(undefined),
          mode: 'connected',
          tokens: { ...this.#deps.tokens() },
        } satisfies WindowDescription;
      case 'ready':
      case 'reportFailure':
      case 'closeAnswer':
        return undefined;
      case 'catalog':
        throw new Error('The splash has no catalog.');
      case 'cancel':
      case 'unsubscribe':
        this.#release(request.op === 'cancel' ? request.id : request.id);
        return undefined;
      case 'call': {
        const { envelope } = request;

        if (
          envelope.bundleId !== null ||
          envelope.contract !== SPLASH_CONTRACT ||
          envelope.method !== 'act'
        ) {
          return failure(
            new ContractError(
              'unavailable',
              `The splash may call only ${SPLASH_CONTRACT} act.`,
            ),
          );
        }

        const action = recoveryActionSchema.safeParse(envelope.input);

        if (!action.success) {
          return failure(
            new ContractError('invalid_input', action.error.message),
          );
        }

        try {
          await this.#deps.splashAct(action.data);

          return ok(undefined);
        } catch (error) {
          return failure(error);
        }
      }
      case 'subscribe': {
        const { envelope } = request;

        if (
          envelope.bundleId !== null ||
          envelope.contract !== SPLASH_CONTRACT ||
          envelope.method !== 'state'
        ) {
          return failure(
            new ContractError(
              'unavailable',
              `The splash may subscribe only to ${SPLASH_CONTRACT} state.`,
            ),
          );
        }

        const sender = event.sender;
        const unsubscribe = this.#deps.splashStates.subscribe((state) =>
          push(sender, { type: 'event', id: envelope.id, event: state }),
        );

        this.#streams.set(envelope.id, {
          contents: sender.id,
          dispose: unsubscribe,
        });

        return ok(undefined);
      }
    }
  }

  #release(id: string): void {
    const call = this.#calls.get(id);

    if (call !== undefined) {
      this.#calls.delete(id);
      call.controller.abort();
    }

    const stream = this.#streams.get(id);

    if (stream !== undefined) {
      this.#streams.delete(id);
      stream.dispose();
    }
  }

  // Windows --------------------------------------------------------------------

  #pinned(
    entry: WindowEntry,
    event: DesktopEvent,
    generation: number | undefined,
  ): GenerationView {
    if (entry.pinnedGeneration === null && generation !== undefined) {
      if (!this.#deps.pinWindow(entry, generation)) {
        // The shell is of a generation main no longer retains: a reload
        // renders it again with the current one.
        event.sender.reload();

        throw new ContractError(
          'unavailable',
          `Generation ${generation} is no longer available; the window reloads.`,
        );
      }
    }

    const pinned = entry.pinnedGeneration;
    const view = pinned === null ? undefined : this.#deps.view(pinned);

    if (view === undefined) {
      throw new ContractError('unavailable', 'This window has no generation.');
    }

    return view;
  }

  async #window(
    event: DesktopEvent,
    entry: WindowEntry,
    request: DesktopRequest,
  ): Promise<unknown> {
    switch (request.op) {
      case 'describeWindow': {
        const view = this.#pinned(entry, event, request.generation);

        return {
          key: entry.key,
          kind: 'window',
          path: pathOf(event.sender.getURL()),
          generation: view.generation,
          chrome: this.#deps.chrome(entry),
          mode: view.mode,
          tokens: { ...this.#deps.tokens() },
        } satisfies WindowDescription;
      }
      case 'catalog':
        return this.#pinned(entry, event, request.generation).windowCatalog;
      case 'ready':
        this.#deps.windowReady(entry);

        return undefined;
      case 'reportFailure':
        this.#deps.windowFailure(entry, request.info);

        return undefined;
      case 'closeAnswer':
        this.#deps.answerClose(request.id, request.answer);

        return undefined;
      case 'cancel':
      case 'unsubscribe':
        this.#release(request.id);

        return undefined;
      case 'call':
        return await this.#call(event, entry, request.envelope);
      case 'subscribe':
        return this.#subscribe(event, entry, request.envelope);
    }
  }

  async #call(
    event: DesktopEvent,
    entry: WindowEntry,
    envelope: BridgeCallEnvelope,
  ): Promise<BridgeResultPayload> {
    if (envelope.bundleId === null) {
      return await this.#shellCall(entry, envelope);
    }

    let target: Resolved;

    try {
      target = this.#resolve(entry, envelope, false);
    } catch (error) {
      return failure(error);
    }

    const controller = new AbortController();

    this.#calls.set(envelope.id, { controller, contents: event.sender.id });

    try {
      const output = await this.#invoke(target, envelope, controller.signal);

      this.#check(target, envelope.method, 'output', output);

      return ok(output);
    } catch (error) {
      return failure(error);
    } finally {
      this.#calls.delete(envelope.id);
    }
  }

  #subscribe(
    event: DesktopEvent,
    entry: WindowEntry,
    envelope: BridgeCallEnvelope,
  ): BridgeResultPayload {
    const sender = event.sender;

    if (envelope.bundleId === null) {
      return this.#shellStream(sender, entry, envelope);
    }

    let target: Resolved;

    try {
      target = this.#resolve(entry, envelope, true);
    } catch (error) {
      return failure(error);
    }

    const id = envelope.id;
    const end = (error?: ContractError) => {
      if (this.#streams.delete(id)) {
        push(sender, {
          type: 'end',
          id,
          ...(error === undefined
            ? {}
            : {
                error: {
                  code: error.code,
                  message: error.message,
                  ...(error.details === undefined
                    ? {}
                    : { details: error.details }),
                },
              }),
        });
      }
    };
    const next = (item: unknown) => {
      if (this.#streams.has(id)) {
        push(sender, { type: 'event', id, event: item });
      }
    };
    const stream: OpenStream = {
      contents: sender.id,
      dispose: () => undefined,
    };

    this.#streams.set(id, stream);

    try {
      if (target.environment === 'host') {
        const close = this.#deps.host.subscribe(
          {
            contract: target.contract,
            method: envelope.method,
            input: envelope.input,
          },
          target.wire,
          {
            event: (values) => {
              for (const value of values) {
                next(value);
              }
            },
            end: (error) => end(error),
          },
        );

        stream.dispose = close;
      } else {
        const items = Array.isArray(envelope.input)
          ? envelope.input
          : [envelope.input];
        const controller = new AbortController();
        const call = restoreCall(target.wire, {
          signals: [controller.signal],
          ...(this.#deps.now === undefined ? {} : { now: this.#deps.now }),
        });
        // Across the process link the listener crosses with the callback
        // codec, which carries a function: the items, not the end.
        const disposable = (target.record as ProviderRecord).invoke(
          envelope.method,
          [...items, next],
          call,
        ) as { dispose(): void } | Promise<{ dispose(): void }>;

        stream.dispose = () => controller.abort();

        Promise.resolve(disposable).then(
          (held) => {
            if (this.#streams.has(id)) {
              stream.dispose = () => {
                controller.abort();
                held.dispose();
              };
            } else {
              held.dispose();
            }
          },
          (error: unknown) => end(toContractError(error)),
        );
      }
    } catch (error) {
      this.#streams.delete(id);

      return failure(error);
    }

    return ok(undefined);
  }

  #resolve(
    entry: WindowEntry,
    envelope: BridgeCallEnvelope,
    stream: boolean,
  ): Resolved {
    const generation = entry.pinnedGeneration;
    const view = generation === null ? undefined : this.#deps.view(generation);

    if (view === undefined || generation === null) {
      throw new ContractError('unavailable', 'This window has no generation.');
    }

    const bundleId = envelope.bundleId as string;
    const part = clientPartOf(view, bundleId);

    if (part === undefined) {
      throw new ContractError(
        'unavailable',
        `Bundle "${bundleId}" has no active client part in generation ${generation}.`,
        { bundleId, generation },
      );
    }

    if (
      envelope.contract.startsWith('doric.') ||
      !mayUse(part, envelope.contract)
    ) {
      throw new ContractError(
        'undeclared_requirement',
        `Bundle "${bundleId}" did not declare "${envelope.contract}" in requires.`,
        { bundleId, contract: envelope.contract },
      );
    }

    const route = routeOf(view, envelope.contract);
    const spec = route?.contract.methods[envelope.method];

    if (route === undefined || spec === undefined) {
      throw new ContractError(
        'unavailable',
        `No provider of ${envelope.contract} ${envelope.method} is reachable from this window.`,
        { contract: envelope.contract, method: envelope.method },
      );
    }

    if (spec.local) {
      throw new ContractError(
        'local_only',
        `${envelope.contract} ${envelope.method} cannot be called across the desktop bridge.`,
        { contract: envelope.contract, method: envelope.method },
      );
    }

    if (spec.stream !== stream) {
      throw new ContractError(
        'invalid_input',
        stream
          ? `${envelope.contract} ${envelope.method} is not a stream.`
          : `${envelope.contract} ${envelope.method} is a stream; subscribe to it.`,
        { contract: envelope.contract, method: envelope.method },
      );
    }

    const resolved: Omit<Resolved, 'wire' | 'record'> = {
      contract: envelope.contract,
      environment: route.contract.environment,
      mode: view.mode,
      schemas: route.schemas[envelope.method],
      stream,
    };

    this.#check(resolved, envelope.method, 'input', envelope.input);

    const wire: WireCall = {
      caller: { bundleId, version: part.version, generation },
      // The dispatcher fills the window key, whatever the window sent.
      scope: { ...(envelope.scope ?? {}), windowKey: entry.key },
      trace: { traceparent: envelope.traceparent },
      deadline: envelope.deadline,
      generation,
    };

    if (route.contract.environment === 'host') {
      if (view.mode !== 'connected' || !this.#deps.host.connected) {
        throw hostUnavailable();
      }

      return { ...resolved, wire };
    }

    const process = this.#deps.process(generation);
    const record = process?.records
      .providers(envelope.contract)
      .find((candidate) => candidate.bundleId === route.contract.bundleId);

    if (process === undefined || record === undefined || !process.alive) {
      throw new ContractError(
        'unavailable',
        `The desktopMain provider of ${envelope.contract} is not running.`,
        { contract: envelope.contract },
      );
    }

    return { ...resolved, wire, record };
  }

  async #invoke(
    target: Resolved,
    envelope: BridgeCallEnvelope,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (target.environment === 'host') {
      return await this.#deps.host.call(
        {
          contract: target.contract,
          method: envelope.method,
          input: envelope.input,
        },
        target.wire,
        signal,
      );
    }

    const call = restoreCall(target.wire, {
      signals: [signal],
      ...(this.#deps.now === undefined ? {} : { now: this.#deps.now }),
    });

    return await (target.record as ProviderRecord).invoke(
      envelope.method,
      envelope.input,
      call,
    );
  }

  #check(
    target: Pick<Resolved, 'schemas' | 'contract' | 'stream'>,
    method: string,
    side: 'input' | 'output',
    value: unknown,
  ): void {
    const schemas = target.schemas;

    if (schemas === undefined || (side === 'output' && target.stream)) {
      return;
    }

    let schema = schemas[side];

    // A stream's listener never crosses: its input is the tuple without it.
    if (
      side === 'input' &&
      target.stream &&
      Array.isArray(schema.prefixItems)
    ) {
      const items = (schema.prefixItems as unknown[]).slice(0, -1);

      schema = (
        items.length === 0
          ? { type: 'array', maxItems: 0 }
          : { type: 'array', prefixItems: items, maxItems: items.length }
      ) as typeof schema;
    }

    const issues = this.#deps.validators.compile(schema as JsonObject)(value);

    if (issues.length > 0) {
      throw new ContractError(
        side === 'input' ? 'invalid_input' : 'invalid_output',
        `Invalid ${side} for ${target.contract} ${method}: ${describeSchemaIssues(issues)}`,
        { contract: target.contract, method },
      );
    }
  }

  // doric.shell/v1 -------------------------------------------------------------

  async #shellCall(
    entry: WindowEntry,
    envelope: BridgeCallEnvelope,
  ): Promise<BridgeResultPayload> {
    if (envelope.contract !== SHELL_CONTRACT) {
      return failure(
        new ContractError(
          'undeclared_requirement',
          `The window platform may call only ${SHELL_CONTRACT}.`,
          { contract: envelope.contract },
        ),
      );
    }

    try {
      switch (envelope.method) {
        case 'keybinding': {
          const key = z
            .object({ key: z.string() })
            .strict()
            .parse(envelope.input).key;
          const binding = this.#deps
            .bindingsFor(entry)
            .find((candidate) => candidate.key === key);

          if (binding === undefined) {
            throw new ContractError(
              'not_found',
              `No command is bound to "${key}" in this window.`,
            );
          }

          await this.#deps.dispatchCommand(binding.command, {
            windowKey: entry.key,
          });

          return ok(undefined);
        }
        case 'commandResult': {
          const result = shellCommandResultSchema.parse(envelope.input);
          const pending = this.#commands.get(result.id);

          if (pending !== undefined) {
            this.#commands.delete(result.id);
            pending.resolve(
              result.ok ? { ok: true } : { ok: false, error: result.error },
            );
          }

          return ok(undefined);
        }
        case 'log': {
          const record = z
            .object({
              level: z.enum(['info', 'warn', 'error']).default('info'),
              message: z.string(),
              fields: z.record(z.string(), z.unknown()).optional(),
            })
            .parse(envelope.input);

          this.#deps.log[record.level](
            { windowKey: entry.key, ...(record.fields ?? {}) },
            record.message,
          );

          return ok(undefined);
        }
        case 'diagnostic':
          this.#deps.diagnostic(
            entry,
            shellDiagnosticSchema.parse(envelope.input),
          );

          return ok(undefined);
        default:
          throw new ContractError(
            'invalid_input',
            `${SHELL_CONTRACT} ${envelope.method} is not a call.`,
          );
      }
    } catch (error) {
      return failure(
        error instanceof z.ZodError
          ? new ContractError('invalid_input', error.message)
          : error,
      );
    }
  }

  #shellStream(
    sender: DesktopEvent['sender'],
    entry: WindowEntry,
    envelope: BridgeCallEnvelope,
  ): BridgeResultPayload {
    if (envelope.contract !== SHELL_CONTRACT) {
      return failure(
        new ContractError(
          'undeclared_requirement',
          `The window platform may subscribe only to ${SHELL_CONTRACT}.`,
        ),
      );
    }

    const id = envelope.id;
    const contents = sender.id;

    if (envelope.method === 'keybindings') {
      const streams =
        this.#keybindingStreams.get(contents) ??
        new Map<string, (table: readonly ShellKeybinding[]) => void>();

      streams.set(id, (table) =>
        push(sender, { type: 'event', id, event: table }),
      );
      this.#keybindingStreams.set(contents, streams);
      this.#streams.set(id, {
        contents,
        dispose: () => this.#keybindingStreams.get(contents)?.delete(id),
      });
      push(sender, { type: 'event', id, event: this.#deps.bindingsFor(entry) });

      return ok(undefined);
    }

    if (envelope.method === 'commands') {
      const streams =
        this.#commandStreams.get(contents) ??
        new Map<string, (request: unknown) => void>();

      streams.set(id, (request) =>
        push(sender, { type: 'event', id, event: request }),
      );
      this.#commandStreams.set(contents, streams);
      this.#streams.set(id, {
        contents,
        dispose: () => this.#commandStreams.get(contents)?.delete(id),
      });

      return ok(undefined);
    }

    return failure(
      new ContractError(
        'invalid_input',
        `${SHELL_CONTRACT} ${envelope.method} is not a stream.`,
      ),
    );
  }

  /** Pushes the window's table when it changed. */
  bindingsChanged(entry: WindowEntry): void {
    const contents = entry.window.webContents.id;
    const streams = this.#keybindingStreams.get(contents);

    if (streams === undefined || streams.size === 0) {
      return;
    }

    const table = this.#deps.bindingsFor(entry);
    const text = JSON.stringify(table);

    if (this.#lastTables.get(contents) === text) {
      return;
    }

    this.#lastTables.set(contents, text);

    for (const send of streams.values()) {
      send(table);
    }
  }

  /** Whether the window serves client commands (its shell subscribed). */
  servesCommands(entry: WindowEntry): boolean {
    return (
      (this.#commandStreams.get(entry.window.webContents.id)?.size ?? 0) > 0
    );
  }

  /** Asks a window to run a client command (section 18.3 step 2). */
  runClientCommand(
    entry: WindowEntry,
    command: string,
  ): Promise<{ ok: true } | { ok: false; error: BridgeError }> {
    const streams = this.#commandStreams.get(entry.window.webContents.id);

    if (streams === undefined || streams.size === 0) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'unknown_command',
          message: `No command "${command}" is registered here.`,
        },
      });
    }

    this.#commandCounter += 1;
    const id = `command-${this.#commandCounter}`;

    return new Promise((resolve) => {
      this.#commands.set(id, { resolve });

      for (const send of streams.values()) {
        send({ id, command, input: {} });
      }
    });
  }
}

interface Resolved {
  readonly contract: string;
  readonly environment: 'desktopMain' | 'host';
  readonly mode: WindowMode;
  readonly schemas:
    | {
        readonly input: Record<string, unknown>;
        readonly output: Record<string, unknown>;
      }
    | undefined;
  readonly stream: boolean;
  readonly wire: WireCall;
  /** The generation process's record (desktopMain routes). */
  readonly record?: ProviderRecord;
}
