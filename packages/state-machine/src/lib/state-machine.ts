import { StateMachineError } from './classes/state-machine-error.js';
import type {
  StateMachineAction,
  StateMachineDefinition,
  StateMachineErrorCode,
  StateMachineErrorResult,
  StateMachineFailFunction,
  StateMachineFinishFunction,
  StateMachineHandler,
  StateMachineHandlerActions,
  StateMachineResult,
  StateMachineRunInput,
  StateMachineState,
  StateMachineTransition,
  StateMachineTransitionFunction,
} from './types/state-machine.js';

type RuntimeHandlers<
  Handlers extends string,
  State extends StateMachineState,
  Context,
  Finished,
  Failed,
> = Partial<
  Record<
    Handlers,
    StateMachineHandler<Context, State, Handlers, Finished, Failed>
  >
>;

/**
 * Configures the context and plain state record types, then infers handler
 * names from the handler map passed to the returned initializer.
 */
export const createStateMachine =
  <
    Context,
    State extends StateMachineState,
    Finished = void,
    Failed = unknown,
  >() =>
  /** Creates a reusable definition whose run state is isolated to each call. */
  <Handlers extends string>(handlers: {
    readonly [Handler in Handlers]: StateMachineHandler<
      Context,
      State,
      NoInfer<Handlers>,
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
  State extends StateMachineState,
  Finished,
  Failed,
>(): StateMachineHandlerActions<Handlers, State, Finished, Failed> => {
  const transition: StateMachineTransitionFunction<Handlers, State> = (
    handler,
    state,
  ) => ({
    type: 'transition',
    handler,
    state,
  });

  const finish: StateMachineFinishFunction<Finished> = (value) => ({
    type: 'finish',
    value,
  });

  const fail: StateMachineFailFunction<Failed> = (error) => ({
    type: 'fail',
    error,
  });

  return Object.freeze({ transition, finish, fail });
};

const execute = async <
  Handlers extends string,
  State extends StateMachineState,
  Context,
  Finished,
  Failed,
>(
  input: StateMachineRunInput<Handlers, State, Context>,
  handlers: RuntimeHandlers<Handlers, State, Context, Finished, Failed>,
): Promise<StateMachineResult<Handlers, State, Context, Finished, Failed>> => {
  let step: StateMachineTransition<Handlers, State> = {
    type: 'transition',
    handler: input.initial,
    state: input.state,
  };
  const actions = createActions<Handlers, State, Finished, Failed>();
  const engineError = (
    code: StateMachineErrorCode,
    message: string,
    options?: ErrorOptions,
  ): StateMachineErrorResult<Handlers, State, Context> => ({
    status: 'error',
    error: new StateMachineError(
      { code, message, handler: step.handler },
      options,
    ),
    handler: step.handler,
    state: step.state,
    context: input.context,
  });

  try {
    if (!isPlainState(step.state)) {
      throw new TypeError('Initial state must be a plain data object');
    }

    while (true) {
      const { handler, state } = step;
      const current = ownHandler(handlers, handler);

      if (current === undefined) {
        return engineError(
          'missing_handler',
          `No state handler defined for: ${handler}`,
        );
      }

      const returned: unknown = await current(state, input.context, actions);
      const action = readAction<Handlers, State, Finished, Failed>(returned);

      if (action === undefined) {
        return engineError(
          'invalid_handler_return',
          `State handler returned an invalid action: ${handler}`,
        );
      }

      if (action.type === 'finish') {
        return {
          status: 'finished',
          value: action.value,
          handler,
          state,
          context: input.context,
        };
      }

      if (action.type === 'fail') {
        return {
          status: 'failed',
          error: action.error,
          handler,
          state,
          context: input.context,
        };
      }

      // Copy only after the handler resolves, equally for helpers and literals.
      step = {
        type: 'transition',
        handler: action.handler,
        state: { ...action.state },
      };
    }
  } catch (cause) {
    return engineError(
      'handler_failed',
      `State handler execution failed: ${step.handler}`,
      { cause },
    );
  }
};

const ownHandler = <
  Handlers extends string,
  State extends StateMachineState,
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

// Capture and validate the envelope once; getters must not change validated
// fields before use. Domain payload types remain the caller's responsibility.
const readAction = <
  Handlers extends string,
  State extends StateMachineState,
  Finished,
  Failed,
>(
  value: unknown,
): StateMachineAction<Handlers, State, Finished, Failed> | undefined => {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return undefined;
  }

  switch (value.type) {
    case 'transition': {
      if (!('handler' in value) || !('state' in value)) {
        return undefined;
      }
      const handler = value.handler;
      const state = value.state;
      return typeof handler === 'string' && isPlainState(state)
        ? {
            type: 'transition',
            handler: handler as Handlers,
            state: state as State,
          }
        : undefined;
    }
    case 'finish':
      return 'value' in value
        ? { type: 'finish', value: value.value as Finished | undefined }
        : undefined;
    case 'fail':
      return 'error' in value
        ? { type: 'fail', error: value.error as Failed }
        : undefined;
    default:
      return undefined;
  }
};

const isPlainState = (value: unknown): value is StateMachineState => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
};
