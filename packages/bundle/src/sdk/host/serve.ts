// The bundle's side of host-to-bundle calls (spec
// `docs/designs/grpc-processes.md`, section 5, "Host-to-bundle calls" and
// "Flow control"; section 10): the SDK runs the implementation of the method
// a `CallStart` names and answers with `CallMessage` and `CallEnd` frames.

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  create,
  type DescMessage,
  type DescMethod,
  type DescService,
  fromBinary,
  type MessageInitShape,
  type MessageShape,
  toBinary,
} from '@bufbuild/protobuf';
import { createValidator, type Violation } from '@bufbuild/protovalidate';
import {
  Code,
  createContextValues,
  createHandlerContext,
  type HandlerContext,
} from '@connectrpc/connect';

import {
  type Call,
  type CallScope,
  callBrand,
  callDeadline,
} from '../../contracts/call.js';
import { ContractError, toContractError } from '../../contracts/error.js';
import type {
  CallStart,
  ConnectRequestSchema,
  ConnectResponse,
} from '../../contracts/gen/doric/platform/v1/control_pb.js';
import { StatusSchema } from '../../contracts/gen/google/rpc/status_pb.js';
import {
  callContextKey,
  callerIncarnationKey,
} from '../../contracts/metadata.js';
import { toStatus } from '../../contracts/status.js';
import { maxMessageBytes } from '../../platform/router/control.js';
import { abortAtDeadline } from '../../runtime/call.js';
import type { InvalidInputAnswer, ServiceEntry } from './run.js';

/**
 * The `Call` of a `CallStart`, branded so `isCall` answers true:
 * `caller` is `{ bundleId, version, generation }` of `start.caller` (the
 * router stamped it; the incarnation is not part of a `Call`); `scope` is
 * `start.scope`, frozen, and absent when it has no key; `trace` is
 * `{ traceparent: start.traceparent }`; `signal` is `signal`; `deadlineOf`
 * answers `start.deadlineUnixMs` (0: none). Pure; the answer is frozen.
 */
export const callFromStart = (start: CallStart, signal: AbortSignal): Call => {
  const { caller } = start;
  const call: { -readonly [K in keyof Call]: Call[K] } = {
    caller: Object.freeze({
      bundleId: caller?.bundleId ?? '',
      version: caller?.version ?? '',
      generation: caller?.generation ?? 0,
    }),
    signal,
    trace: Object.freeze({ traceparent: start.traceparent }),
  };

  if (Object.keys(start.scope).length > 0) {
    call.scope = Object.freeze({ ...start.scope }) as CallScope;
  }

  Object.defineProperty(call, callBrand, { value: true });
  Object.defineProperty(call, callDeadline, { value: start.deadlineUnixMs });

  return Object.freeze(call);
};

const running = new AsyncLocalStorage<Call>();

/**
 * The call whose handler is running in the current asynchronous context:
 * the `Call` the SDK passed to the handler, also inside the promises and
 * callbacks the handler starts; `undefined` outside every handler (in
 * `activate`, for example).
 */
export const currentCall = (): Call | undefined => running.getStore();

/**
 * Runs `run` as the handler of `call`: `currentCall()` answers `call` inside
 * it and in the promises and callbacks it starts. Internal: the in-memory
 * router of `bundle/testing` serves its handlers with it.
 */
export const runInCall = <T>(call: Call, run: () => T): T =>
  running.run(call, run);

/** The frames of a call the router sends on the control stream. */
export type CallControlFrame = Extract<
  ConnectResponse['frame'],
  {
    case:
      | 'callStart'
      | 'callMessage'
      | 'callHalfClose'
      | 'callCancel'
      | 'callCredit';
  }
>;

export interface CallServerOptions {
  /** The part's `services` list, the same the Hello named. */
  readonly services: readonly ServiceEntry[];
  /** Queues a frame on the control stream; a no-op after the process exits. */
  readonly send: (frame: MessageInitShape<typeof ConnectRequestSchema>) => void;
  /**
   * Aborted when the control stream ends without `Stop`: every call's signal
   * aborts and no frame of any call is sent after it. `Stop` cancels nothing
   * in flight.
   */
  readonly signal: AbortSignal;
  /** `BundleDefinition.invalidInput`; absent keeps `invalid_input`. */
  readonly invalidInput?: InvalidInputAnswer;
}

/** The calls the router started on this process's control stream. */
export interface CallServer {
  /** Takes one call frame from the router, in the order it arrived. */
  receive(frame: CallControlFrame): void;
  /** Number of calls whose `CallEnd` is not sent yet. */
  readonly inFlight: number;
}

/**
 * Serves the `CallStart`s of the control stream with the implementations of
 * `options.services`. For each call:
 *
 * - a `method` of no listed service ends with `CallEnd` `UNIMPLEMENTED`,
 *   reason `unknown_contract`, and no handler runs;
 * - the request (`payload` for `unary` and `server_stream`, the
 *   `CallMessage`s up to `CallHalfClose` for the streaming kinds) is decoded
 *   with the method's input schema and validated with protovalidate; a
 *   request that does not decode or breaks its rules ends with
 *   `invalid_input` before the handler sees it;
 * - the handler runs with a `HandlerContext` whose `values` hold the call's
 *   `Call` under `callContextKey` (`callOf(context)` answers it, see
 *   {@link callFromStart}), and `currentCall()` answers it while it runs;
 *   its `signal` is the `Call`'s;
 * - the call's signal aborts on `CallCancel` and at `deadlineUnixMs`; the
 *   SDK still sends `CallEnd`, with `CANCELLED`;
 * - each response message goes out as one `CallMessage`, at most
 *   `initialCredit` before a `CallCredit` and then one per credit received;
 *   for each request message the handler takes the SDK sends
 *   `CallCredit { messages: 1 }`;
 * - the call ends with one `CallEnd`: code 0 when the handler returns, the
 *   status `toStatus` encodes for a `ContractError`, `internal` with the
 *   message for any other error, and `limit_exceeded` instead of a
 *   `CallMessage` over 4 MiB.
 *
 * A frame for an unknown `callId` other than `CallStart` is ignored.
 */
export const createCallServer = (options: CallServerOptions): CallServer => {
  const methods = new Map(
    options.services.flatMap(([service, implementation]) =>
      service.methods.map((method) => [
        `/${service.typeName}/${method.name}`,
        {
          service,
          method,
          handler: (implementation as Record<string, unknown>)[
            method.localName
          ],
        },
      ]),
    ),
  );
  const calls = new Map<bigint, ServedCall>();
  const send = (frame: MessageInitShape<typeof ConnectRequestSchema>): void => {
    if (!options.signal.aborted) {
      options.send(frame);
    }
  };

  /** Runs the call to its end, then sends its `CallEnd`. */
  const serve = async (start: CallStart, served: ServedCall): Promise<void> => {
    let status = create(StatusSchema);

    try {
      const target = methods.get(start.method);

      if (target === undefined || typeof target.handler !== 'function') {
        throw new ContractError(
          'unknown_contract',
          `This bundle does not serve ${start.method}.`,
        );
      }

      await run(
        start,
        served,
        target.service,
        target.method,
        target.handler as Handler,
      );
    } catch (error) {
      status = served.controller.signal.aborted
        ? create(StatusSchema, {
            code: Code.Canceled,
            message: 'The call was cancelled.',
          })
        : toStatus(toContractError(error));
    }

    calls.delete(start.callId);
    send({
      frame: { case: 'callEnd', value: { callId: start.callId, status } },
    });
  };

  /** Decodes the request, runs the handler and sends its responses. */
  const run = async (
    start: CallStart,
    served: ServedCall,
    service: DescService,
    method: DescMethod,
    handler: Handler,
  ): Promise<void> => {
    const streamsRequest =
      method.methodKind === 'client_streaming' ||
      method.methodKind === 'bidi_streaming';
    const call = callFromStart(start, served.signal);
    const context = createHandlerContext({
      service,
      method,
      protocolName: 'grpc',
      requestMethod: 'POST',
      url: `http://router${start.method}`,
      requestSignal: served.signal,
      contextValues: createContextValues()
        .set(callContextKey, call)
        .set(callerIncarnationKey, start.caller?.incarnation ?? 0),
    });
    const input = streamsRequest
      ? served.requests(method, options.invalidInput)
      : decode(method, start.payload, options.invalidInput);
    const output = await running.run(call, () => handler(input, context));
    const responses: AsyncIterable<unknown> | Iterable<unknown> =
      method.methodKind === 'server_streaming' ||
      method.methodKind === 'bidi_streaming'
        ? (output as AsyncIterable<unknown>)
        : [output];

    await running.run(call, async () => {
      for await (const response of responses) {
        served.signal.throwIfAborted();

        const payload = toBinary(
          method.output,
          create(method.output, response as MessageInitShape<DescMessage>),
        );

        if (payload.length > maxMessageBytes) {
          throw new ContractError(
            'limit_exceeded',
            `A response of ${start.method} exceeds ${maxMessageBytes} bytes.`,
          );
        }

        await served.spend();
        send({
          frame: {
            case: 'callMessage',
            value: { callId: start.callId, payload },
          },
        });
      }
    });
  };

  options.signal.addEventListener('abort', () => {
    for (const served of calls.values()) {
      served.controller.abort(options.signal.reason);
    }
  });

  return {
    receive: (frame) => {
      if (frame.case === 'callStart') {
        const start = frame.value;
        const served = new ServedCall(start, (messages) =>
          send({
            frame: {
              case: 'callCredit',
              value: { callId: start.callId, messages },
            },
          }),
        );

        calls.set(start.callId, served);
        void serve(start, served);

        return;
      }

      const served = calls.get(frame.value.callId);

      switch (frame.case) {
        case 'callMessage':
          served?.message(frame.value.payload);
          return;
        case 'callHalfClose':
          served?.halfClose();
          return;
        case 'callCancel':
          served?.controller.abort(
            new Error(`The call was cancelled: ${frame.value.reason}.`),
          );
          return;
        case 'callCredit':
          served?.credit(frame.value.messages);
          return;
      }
    },
    get inFlight() {
      return calls.size;
    },
  };
};

/** A method of a service implementation, as the server calls it. */
type Handler = (input: unknown, context: HandlerContext) => unknown;

const validator = createValidator();

/**
 * The proto field names of a protovalidate path, from the request message: list and map subscripts are dropped
 * (`items[2].name` is `['items', 'name']`).
 */
const fieldNames = (path: Violation['field']): string[] =>
  path.flatMap((element) =>
    element.kind === 'list_sub' || element.kind === 'map_sub'
      ? []
      : [element.name],
  );

/**
 * The error a request of `method` that broke protovalidate's rules ends its call with: `invalidInput`'s answer to
 * its violations, or `ContractError('invalid_input', message)` when it is absent, answers `undefined` or throws.
 */
const refusal = (
  method: DescMethod,
  message: string,
  violations: readonly Violation[],
  invalidInput: InvalidInputAnswer | undefined,
): ContractError => {
  if (invalidInput !== undefined && violations.length > 0) {
    try {
      const answer = invalidInput(
        method,
        violations.map((violation) => ({
          field: fieldNames(violation.field),
          ruleId: violation.ruleId,
          message: violation.message,
        })),
      );

      if (answer !== undefined) {
        return answer;
      }
    } catch {
      // A throwing answer keeps `invalid_input` (InvalidInputAnswer).
    }
  }

  return new ContractError('invalid_input', message);
};

/**
 * `message`, a request of `method`, when it keeps its protovalidate rules; else throws the error
 * {@link refusal} answers. Shared with `bundle/testing`'s router.
 */
export const validRequest = (
  method: DescMethod,
  message: unknown,
  invalidInput: InvalidInputAnswer | undefined,
): MessageShape<DescMessage> => {
  const result = validator.validate(
    method.input,
    message as MessageShape<DescMessage>,
  );

  if (result.kind !== 'valid') {
    throw refusal(
      method,
      result.error.message,
      result.violations ?? [],
      invalidInput,
    );
  }

  return message as MessageShape<DescMessage>;
};

/** The request a payload carries; `invalid_input` when it does not decode, {@link validRequest}'s error when it breaks its rules. */
const decode = (
  method: DescMethod,
  payload: Uint8Array,
  invalidInput: InvalidInputAnswer | undefined,
): MessageShape<DescMessage> => {
  let message: MessageShape<DescMessage>;

  try {
    message = fromBinary(method.input, payload);
  } catch (error) {
    throw new ContractError(
      'invalid_input',
      `The request does not decode: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return validRequest(method, message, invalidInput);
};

/** The state of one call this process serves: its signal, credit and requests. */
class ServedCall {
  readonly controller = new AbortController();
  /** Aborted on `CallCancel`, at the deadline and when the stream ends. */
  readonly signal: AbortSignal;

  private available: number;
  private readonly waiters: (() => void)[] = [];
  private readonly inbox: Uint8Array[] = [];
  private closed = false;
  private wake: (() => void) | undefined;

  constructor(
    start: CallStart,
    private readonly grant: (messages: number) => void,
  ) {
    this.available = start.initialCredit;
    this.signal = this.controller.signal;

    if (start.deadlineUnixMs > 0) {
      abortAtDeadline(this.controller, start.deadlineUnixMs, Date.now);
    }

    this.signal.addEventListener('abort', () => {
      this.wake?.();

      for (const waiter of this.waiters.splice(0)) {
        waiter();
      }
    });
  }

  /** Takes one response message of credit, waiting for a `CallCredit`. */
  async spend(): Promise<void> {
    while (this.available === 0) {
      this.signal.throwIfAborted();
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    this.available -= 1;
  }

  credit(messages: number): void {
    this.available += messages;

    for (const waiter of this.waiters.splice(0)) {
      waiter();
    }
  }

  message(payload: Uint8Array): void {
    this.inbox.push(payload);
    this.wake?.();
  }

  halfClose(): void {
    this.closed = true;
    this.wake?.();
  }

  /** The request messages, decoded; one `CallCredit` per message taken. */
  async *requests(
    method: DescMethod,
    invalidInput: InvalidInputAnswer | undefined,
  ): AsyncGenerator<MessageShape<DescMessage>> {
    for (;;) {
      this.signal.throwIfAborted();

      const payload = this.inbox.shift();

      if (payload !== undefined) {
        this.grant(1);
        yield decode(method, payload, invalidInput);
        continue;
      }

      if (this.closed) {
        return;
      }

      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}
