import { StateMachineError } from './classes/state-machine-error.js';
import type {
  StateMachineAction,
  StateMachineDefinition,
  StateMachineErrorCode,
  StateMachineErrorData,
  StateMachineErrorResult,
  StateMachineFailFunction,
  StateMachineFinishFunction,
  StateMachineHandler,
  StateMachineHandlerActions,
  StateMachineResult,
  StateMachineRunInput,
  StateMachineTransition,
  StateMachineTransitionFunction,
} from './types/state-machine.js';

type RuntimeHandlers<
  Handlers extends string,
  State extends object,
  Context,
  Finished,
  Failed,
> = Partial<
  Record<
    Handlers,
    StateMachineHandler<Context, State, Handlers, Finished, Failed>
  >
>;

type HandlerCall =
  | { readonly type: 'returned'; readonly action: unknown }
  | { readonly type: 'threw'; readonly cause: unknown };

/**
 * Configures the context and state object types, then infers available handler
 * names from the handler map passed to the returned initializer.
 */
export const createStateMachine =
  <Context, State extends object, Finished = void, Failed = unknown>() =>
  /** Creates a reusable definition whose run state is isolated to each call. */
  <Handlers extends string>(handlers: {
    readonly [Handler in Handlers]: StateMachineHandler<
      Context,
      State,
      Handlers,
      Finished,
      Failed
    >;
  }): StateMachineDefinition<Handlers, State, Context, Finished, Failed> => {
    const runtimeHandlers = { ...handlers } as RuntimeHandlers<
      Handlers,
      State,
      Context,
      Finished,
      Failed
    >;

    return {
      run: (input) => execute(input, runtimeHandlers),
    };
  };

const createActions = <
  Handlers extends string,
  State extends object,
  Finished,
  Failed,
>(): StateMachineHandlerActions<Handlers, State, Finished, Failed> => {
  const transition: StateMachineTransitionFunction<Handlers, State> = (
    handler,
    state,
  ) => ({
    type: 'transition',
    handler,
    state: copy(state),
  });

  const finish: StateMachineFinishFunction<Finished> = (value) => ({
    type: 'finish',
    value,
  });

  const fail: StateMachineFailFunction<Failed> = (error) => ({
    type: 'fail',
    error,
  });

  return { transition, finish, fail };
};

const execute = async <
  Handlers extends string,
  State extends object,
  Context,
  Finished,
  Failed,
>(
  input: StateMachineRunInput<Handlers, State, Context>,
  handlers: RuntimeHandlers<Handlers, State, Context, Finished, Failed>,
): Promise<StateMachineResult<Handlers, State, Context, Finished, Failed>> => {
  let step = initialStep(input);

  while (true) {
    const { handler, state } = step;
    const current = ownHandler(handlers, handler);

    if (current === undefined) {
      return engineError(
        issue(
          'missing_handler',
          `No state handler defined for: ${handler}`,
          handler,
        ),
        state,
        input.context,
      );
    }

    const call = await callHandler(
      current,
      state,
      input.context,
      createActions(),
    );

    if (call.type === 'threw') {
      return engineError(
        issue('handler_failed', `State handler failed: ${handler}`, handler),
        state,
        input.context,
        { cause: call.cause },
      );
    }

    if (!isAction<Handlers, State, Finished, Failed>(call.action)) {
      return engineError(
        issue(
          'invalid_handler_return',
          `State handler returned an invalid action: ${handler}`,
          handler,
        ),
        state,
        input.context,
      );
    }

    if (call.action.type === 'finish') {
      return {
        status: 'finished',
        value: call.action.value,
        handler,
        state,
        context: input.context,
      };
    }

    if (call.action.type === 'fail') {
      return {
        status: 'failed',
        error: call.action.error,
        handler,
        state,
        context: input.context,
      };
    }

    step = call.action;
  }
};

const initialStep = <Handlers extends string, State extends object, Context>(
  input: StateMachineRunInput<Handlers, State, Context>,
): StateMachineTransition<Handlers, State> => ({
  type: 'transition',
  handler: input.initial,
  state: input.state,
});

const ownHandler = <
  Handlers extends string,
  State extends object,
  Context,
  Finished,
  Failed,
>(
  handlers: RuntimeHandlers<Handlers, State, Context, Finished, Failed>,
  handler: Handlers,
):
  | StateMachineHandler<Context, State, Handlers, Finished, Failed>
  | undefined =>
  Object.prototype.hasOwnProperty.call(handlers, handler) &&
  typeof handlers[handler] === 'function'
    ? handlers[handler]
    : undefined;

const callHandler = async <
  Handlers extends string,
  State extends object,
  Context,
  Finished,
  Failed,
>(
  handler: StateMachineHandler<Context, State, Handlers, Finished, Failed>,
  state: State,
  context: Context,
  actions: StateMachineHandlerActions<Handlers, State, Finished, Failed>,
): Promise<HandlerCall> => {
  try {
    return {
      type: 'returned',
      action: await handler(state, context, actions),
    };
  } catch (cause) {
    return { type: 'threw', cause };
  }
};

const issue = <Handlers extends string>(
  code: StateMachineErrorCode,
  message: string,
  state: Handlers,
): StateMachineErrorData<Handlers> => ({ code, message, state });

const engineError = <Handlers extends string, State extends object, Context>(
  data: StateMachineErrorData<Handlers>,
  state: State,
  context: Context,
  options?: ErrorOptions,
): StateMachineErrorResult<Handlers, State, Context> => ({
  status: 'error',
  error: new StateMachineError(data, options),
  handler: data.state,
  state,
  context,
});

const isTransition = <Handlers extends string, State extends object>(
  value: unknown,
): value is StateMachineTransition<Handlers, State> =>
  isRecord(value) &&
  value.type === 'transition' &&
  typeof value.handler === 'string' &&
  isObject(value.state);

const isFinish = <Finished>(
  value: unknown,
): value is {
  readonly type: 'finish';
  readonly value: Finished | undefined;
} => isRecord(value) && value.type === 'finish' && 'value' in value;

const isFail = <Failed>(
  value: unknown,
): value is {
  readonly type: 'fail';
  readonly error: Failed;
} => isRecord(value) && value.type === 'fail' && 'error' in value;

const isAction = <
  Handlers extends string,
  State extends object,
  Finished,
  Failed,
>(
  value: unknown,
): value is StateMachineAction<Handlers, State, Finished, Failed> =>
  isTransition<Handlers, State>(value) ||
  isFinish<Finished>(value) ||
  isFail<Failed>(value);

const copy = <State extends object>(state: State): State => ({ ...state });

const isObject = (value: unknown): value is object =>
  typeof value === 'object' && value !== null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  isObject(value);
