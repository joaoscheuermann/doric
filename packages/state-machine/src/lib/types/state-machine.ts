import type { StateMachineError } from '../classes/state-machine-error.js';

export type StateMachineErrorCode =
  | 'handler_failed'
  | 'invalid_handler_return'
  | 'missing_handler';

export type StateMachineErrorData<Handlers extends string = string> = {
  readonly code: StateMachineErrorCode;
  readonly message: string;
  readonly state: Handlers;
};

export type StateMachineTransition<
  Handlers extends string,
  State extends object,
> = {
  readonly type: 'transition';
  readonly handler: Handlers;
  readonly state: State;
};

export type StateMachineFinish<Finished> = {
  readonly type: 'finish';
  readonly value: Finished | undefined;
};

export type StateMachineFail<Failed> = {
  readonly type: 'fail';
  readonly error: Failed;
};

export type StateMachineAction<
  Handlers extends string,
  State extends object,
  Finished,
  Failed,
> =
  | StateMachineTransition<Handlers, State>
  | StateMachineFinish<Finished>
  | StateMachineFail<Failed>;

export type StateMachineTransitionFunction<
  Handlers extends string,
  State extends object,
> = (
  handler: Handlers,
  state: State,
) => StateMachineTransition<Handlers, State>;

export type StateMachineFinishFunction<Finished> = (
  value?: Finished,
) => StateMachineFinish<Finished>;

export type StateMachineFailFunction<Failed> = (
  error: Failed,
) => StateMachineFail<Failed>;

export type StateMachineHandlerActions<
  Handlers extends string,
  State extends object,
  Finished,
  Failed,
> = {
  readonly transition: StateMachineTransitionFunction<Handlers, State>;
  readonly finish: StateMachineFinishFunction<Finished>;
  readonly fail: StateMachineFailFunction<Failed>;
};

export type StateMachineHandler<
  Context,
  State extends object,
  Handlers extends string = string,
  Finished = void,
  Failed = unknown,
> = (
  state: State,
  context: Context,
  actions: StateMachineHandlerActions<Handlers, State, Finished, Failed>,
) =>
  | StateMachineAction<Handlers, State, Finished, Failed>
  | Promise<StateMachineAction<Handlers, State, Finished, Failed>>;

export type StateMachineRunInput<
  Handlers extends string,
  State extends object,
  Context,
> = {
  readonly initial: Handlers;
  readonly state: State;
  readonly context: Context;
};

type StateMachineResultBase<
  Handlers extends string,
  State extends object,
  Context,
> = {
  readonly handler: Handlers;
  readonly state: State;
  readonly context: Context;
};

export type StateMachineFinishedResult<
  Handlers extends string,
  State extends object,
  Context,
  Finished,
> = StateMachineResultBase<Handlers, State, Context> & {
  readonly status: 'finished';
  readonly value: Finished | undefined;
};

export type StateMachineFailedResult<
  Handlers extends string,
  State extends object,
  Context,
  Failed,
> = StateMachineResultBase<Handlers, State, Context> & {
  readonly status: 'failed';
  readonly error: Failed;
};

export type StateMachineErrorResult<
  Handlers extends string,
  State extends object,
  Context,
> = StateMachineResultBase<Handlers, State, Context> & {
  readonly status: 'error';
  readonly error: StateMachineError<Handlers>;
};

export type StateMachineResult<
  Handlers extends string,
  State extends object,
  Context,
  Finished,
  Failed,
> =
  | StateMachineFinishedResult<Handlers, State, Context, Finished>
  | StateMachineFailedResult<Handlers, State, Context, Failed>
  | StateMachineErrorResult<Handlers, State, Context>;

export type StateMachineDefinition<
  Handlers extends string,
  State extends object,
  Context,
  Finished,
  Failed,
> = {
  readonly run: (
    input: StateMachineRunInput<Handlers, State, Context>,
  ) => Promise<StateMachineResult<Handlers, State, Context, Finished, Failed>>;
};
