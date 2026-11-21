# state-machine

Typed, reusable state machines built from a plain map of handlers. Each handler does its work and returns what happens next: move to another handler, finish with a value, or fail with a domain error. TypeScript infers the handler names from the map, so a typo in a transition is a compile error, and every outcome of a handler, a thrown exception included, comes back as a result instead of a rejected promise (see [Results](#results) for the inputs that still reject).

Part of [Doric](../../README.md).

The package is a library for any bundle, application or package that needs a sequence of typed steps; it holds no workflow policy of its own. No unit of the repository imports it. It is process-local: it has no persistence, listeners, timers, network, files, recovery hooks or other side effects, and depends only on `tslib` ([`package.json`](package.json)).

## Entry point

The package is ESM (`"type": "module"`) and has one entry point, `state-machine` (`.` in `exports`), which resolves to `./src/index.ts` under the workspace's `@org/source` condition and to the built `./dist/index.js` with `./dist/index.d.ts` otherwise; `./package.json` is exported as well ([`package.json`](package.json)). The entry point re-exports everything public from three modules ([`src/index.ts`](src/index.ts)):

| Module                                                             | Exports                              |
| ------------------------------------------------------------------ | ------------------------------------ |
| [`state-machine.ts`](src/lib/state-machine.ts)                     | `createStateMachine`                 |
| [`state-machine-error.ts`](src/lib/classes/state-machine-error.ts) | `StateMachineError`                  |
| [`types/state-machine.ts`](src/lib/types/state-machine.ts)         | Every type listed in [Types](#types) |

## Usage

```ts
import { createStateMachine } from 'state-machine';

type Context = {
  readonly cancelled: boolean;
};
type State = {
  draft: string;
  answer?: string;
};
type Failure = {
  readonly code: 'cancelled';
};

const definition = createStateMachine<Context, State, string, Failure>()({
  draft: (state, _context, { transition }) => {
    state.draft = state.draft.trim();
    return transition('review', state);
  },
  review: (state, context, { transition, fail }) => {
    if (context.cancelled) {
      return fail({ code: 'cancelled' });
    }

    state.answer = state.draft;
    return transition('complete', state);
  },
  complete: (state, _context, { finish }) => finish(state.answer ?? ''),
});

const result = await definition.run({
  initial: 'draft',
  state: { draft: ' hello ' },
  context: { cancelled: false },
});
// result: { status: 'finished', value: 'hello', handler: 'complete', state, context }
```

## `createStateMachine`

```ts
const createStateMachine: <
  Context,
  State extends StateMachineState,
  Finished = void,
  Failed = unknown,
>() => <Handlers extends string>(
  handlers: Readonly<
    Record<
      Handlers,
      StateMachineHandler<Context, State, NoInfer<Handlers>, Finished, Failed>
    >
  >,
) => StateMachineDefinition<Handlers, State, Context, Finished, Failed>;
```

The function is curried so that the caller names the configured types and TypeScript still infers the handler names ([`state-machine.ts`](src/lib/state-machine.ts)):

- The first call takes the types only: `Context` (the run context), `State` (the state record every handler receives), `Finished` (the value of `finish`, default `void`) and `Failed` (the domain error of `fail`, default `unknown`). `Context` and `State` are the only types a caller must give.
- The second call takes the handler map. Its keys become `Handlers`; because the handlers' own parameter uses `NoInfer<Handlers>`, the names a handler passes to `transition` are checked against the keys and do not widen them. The map is exhaustive: every key is a handler.

The returned definition copies the map's own enumerable entries once with a spread, `{ ...handlers }`: each getter of the map runs once, and an exception from a getter is thrown synchronously by the second call. Because of the copy, adding or replacing an entry of the caller's object afterwards does not change the definition. The definition stores nothing else: it has one member, `run`, and keeps no state between runs, so one definition can run any number of times, one after another or concurrently ([`state-machine.ts`](src/lib/state-machine.ts)).

## Handlers and actions

```ts
type StateMachineHandler<
  Context,
  State extends StateMachineState,
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
```

A handler receives the current state, the run's context and the actions object, and returns an action, synchronously or as a promise ([`types/state-machine.ts`](src/lib/types/state-machine.ts)). It may mutate the state it receives. The actions object has three functions, each of which only builds the action object and returns it:

| Function     | Signature                           | Returns                                                                    |
| ------------ | ----------------------------------- | -------------------------------------------------------------------------- |
| `transition` | `(handler: Handlers, state: State)` | `{ type: 'transition', handler, state }`                                   |
| `finish`     | `(value?: Finished)`                | `{ type: 'finish', value }` (`value` is present, `undefined` when omitted) |
| `fail`       | `(error: Failed)`                   | `{ type: 'fail', error }`                                                  |

Each run creates one actions object, frozen with `Object.freeze`, and passes that same object to every handler of the run; a handler cannot replace a function on it for a later handler ([`state-machine.ts`](src/lib/state-machine.ts)). A handler may also return a literal action of the same shape, such as `{ type: 'transition', handler: 'review', state }`; the engine treats it exactly as the result of the helper.

## Runs

```ts
definition.run(input: StateMachineRunInput<Handlers, State, Context>):
  Promise<StateMachineResult<Handlers, State, Context, Finished, Failed>>;

interface StateMachineRunInput<Handlers extends string, State extends StateMachineState, Context> {
  readonly initial: Handlers;
  readonly state: State;
  readonly context: Context;
}
```

A run keeps its current handler and current state in local variables of the call, so concurrent runs of one definition do not share execution control. It reads `context` from the input object each time it calls a handler or builds a result, so replacing `input.context` during a run changes what later handlers receive and what the result carries. A run does not isolate the values the caller owns: a context or state object passed to two runs is the same object in both ([`state-machine.ts`](src/lib/state-machine.ts)).

The run proceeds as follows ([`state-machine.ts`](src/lib/state-machine.ts)):

1. It checks that the initial state is [plain state](#state). The initial state is passed by reference: the first handler receives the caller's own object, and its mutations are visible to the caller.
2. It looks up the current handler: an own property of the handler map whose value is a function. A name inherited from `Object.prototype` (such as `toString`) or a non-function value is no handler.
3. It awaits the handler with `(state, context, actions)`.
4. It reads the returned action once (see [Action validation](#action-validation)).
5. On `finish` or `fail` it resolves with the result. On `transition` it makes a shallow copy of the action's state, `{ ...state }`, makes the action's handler the current handler and that copy the current state, and goes back to step 2.

The copy is made after the handler returns or its promise resolves, not when `transition` is called: a mutation the handler makes to the state between `transition(...)` and its completion is in the copy. The copy has a new top-level identity with the source's own enumerable properties, shares every nested value with it (there is no deep clone), and always has `Object.prototype`, even when the source has a `null` prototype.

The loop has no limit on the number of transitions, no timeout and no cancellation: a run whose handlers transition forever never resolves, and a handler that never settles leaves the run pending.

## State

```ts
type StateMachineState = Record<string, unknown>;
```

State is a top-level data record ([`types/state-machine.ts`](src/lib/types/state-machine.ts)). At runtime the engine accepts as state only an object that is not an array and whose prototype is this realm's `Object.prototype` or `null`; arrays, `Date`, `Map`, class instances and objects from another realm are refused ([`state-machine.ts`](src/lib/state-machine.ts)). The engine checks the initial state and the state of every transition. Property values are unrestricted: nested objects, arrays, class instances, functions and promises are accepted and never inspected.

The type constraint cannot prove a prototype, so it filters common mistakes only: structural typing, type assertions and JavaScript callers can still supply an unsupported object, which the runtime check catches. Declare the state as a type alias of a record, as `State` in [Usage](#usage): an interface without an index signature may not satisfy `Record<string, unknown>`.

## Results

```ts
type StateMachineResult<
  Handlers extends string,
  State extends StateMachineState,
  Context,
  Finished,
  Failed,
> =
  | StateMachineFinishedResult<Handlers, State, Context, Finished>
  | StateMachineFailedResult<Handlers, State, Context, Failed>
  | StateMachineErrorResult<Handlers, State, Context>;
```

Once `run` has read a valid input object, every outcome resolves as one of three results. `run` rejects when `input` is not an object, when reading `initial`, `state` or `context` throws, or when a handler name cannot be converted to a string (a Symbol), because the error messages interpolate it. Each result also carries the terminal `handler`, the current `state` and the run's `context` ([`types/state-machine.ts`](src/lib/types/state-machine.ts), [`state-machine.ts`](src/lib/state-machine.ts)):

| `status`   | Carries                                                      | Produced when                           |
| ---------- | ------------------------------------------------------------ | --------------------------------------- |
| `finished` | `value: Finished \| undefined`, the value passed to `finish` | A handler returns a `finish` action     |
| `failed`   | `error: Failed`, the exact value passed to `fail`            | A handler returns a `fail` action       |
| `error`    | `error: StateMachineError<Handlers>`                         | The engine fails; see [Errors](#errors) |

On `finished` and `failed`, `handler` is the handler that returned the action and `state` is the state object that handler received.

## Errors

```ts
class StateMachineError<Handlers extends string = string> extends Error {
  readonly data: StateMachineErrorData<Handlers>;
  constructor(data: StateMachineErrorData<Handlers>, options?: ErrorOptions);
}

type StateMachineErrorCode =
  | 'handler_failed'
  | 'invalid_handler_return'
  | 'missing_handler';

interface StateMachineErrorData<Handlers extends string = string> {
  readonly code: StateMachineErrorCode;
  readonly message: string;
  readonly handler: Handlers;
}
```

A `StateMachineError` has the name `StateMachineError`, the message of its `data`, and its `data` ([`state-machine-error.ts`](src/lib/classes/state-machine-error.ts)). `data.handler` names a handler; the state is in the result's `state`, not in the error. The engine uses three codes, and each error result carries the current handler and state at the moment of the failure ([`state-machine.ts`](src/lib/state-machine.ts)):

| Code                     | Message                                               | When                                                                                                                                  | `handler` and `state` of the result                                                                                      | `cause`                                                                    |
| ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `handler_failed`         | `State handler execution failed: <handler>`           | The initial state is not plain state, before any handler runs                                                                         | The `initial` handler and the supplied state                                                                             | A `TypeError` with the message `Initial state must be a plain data object` |
| `handler_failed`         | Same                                                  | A handler throws, its promise rejects, or reading the action or copying the transition state throws (a throwing getter, for instance) | The source handler and the state it received                                                                             | The thrown value, unchanged                                                |
| `invalid_handler_return` | `State handler returned an invalid action: <handler>` | The handler returns no valid action, or a transition whose state is not plain state                                                   | The source handler and the state it received                                                                             | None                                                                       |
| `missing_handler`        | `No state handler defined for: <handler>`             | The `initial` handler or a transition's destination is not a handler of the map                                                       | For the initial handler, it and the supplied state; for a destination, the destination and the transition's shallow copy | None                                                                       |

In every case the destination of an invalid transition is not invoked. The run's `context` is the value of `input.context` when the result is built.

### Action validation

The engine reads the returned value once and validates only the action's envelope ([`state-machine.ts`](src/lib/state-machine.ts)). Properties are checked with `in`, so own and inherited properties both count (an object created with `Object.create({ type: 'finish', value: 1 })` finishes with `1`). A valid action is an object with an own or inherited `type` property and, own or inherited:

- `type: 'transition'`: `handler` and `state` properties, where `handler` is a string and `state` is [plain state](#state);
- `type: 'finish'`: a `value` property, which may be `undefined` (a literal `{ type: 'finish' }` without the key is invalid);
- `type: 'fail'`: an `error` property.

Each field is read once, and the run uses the values it read and validated, so a getter that returns a different value on a second read cannot change the transition. The engine does not check the `Finished`, `Failed` or state property types. Validation does not check that a transition's handler exists; the lookup of the next step does, and reports a missing one as `missing_handler`.

## Types

Every type is exported from the entry point and defined in [`types/state-machine.ts`](src/lib/types/state-machine.ts). Fields are `readonly`. In every type that takes them, `Handlers extends string` and `State extends StateMachineState`.

| Type                                                                 | Shape                                                                              |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `StateMachineState`                                                  | `Record<string, unknown>`                                                          |
| `StateMachineTransition<Handlers, State>`                            | `{ type: 'transition'; handler: Handlers; state: State }`                          |
| `StateMachineFinish<Finished>`                                       | `{ type: 'finish'; value: Finished \| undefined }`                                 |
| `StateMachineFail<Failed>`                                           | `{ type: 'fail'; error: Failed }`                                                  |
| `StateMachineAction<Handlers, State, Finished, Failed>`              | Union of the three actions                                                         |
| `StateMachineTransitionFunction<Handlers, State>`                    | `(handler, state) => StateMachineTransition`                                       |
| `StateMachineFinishFunction<Finished>`                               | `(value?) => StateMachineFinish`                                                   |
| `StateMachineFailFunction<Failed>`                                   | `(error) => StateMachineFail`                                                      |
| `StateMachineHandlerActions<Handlers, State, Finished, Failed>`      | `{ transition; finish; fail }`                                                     |
| `StateMachineHandler<Context, State, Handlers, Finished, Failed>`    | See [Handlers and actions](#handlers-and-actions)                                  |
| `StateMachineRunInput<Handlers, State, Context>`                     | `{ initial: Handlers; state: State; context: Context }`                            |
| `StateMachineFinishedResult<Handlers, State, Context, Finished>`     | `{ status: 'finished'; value: Finished \| undefined; handler; state; context }`    |
| `StateMachineFailedResult<Handlers, State, Context, Failed>`         | `{ status: 'failed'; error: Failed; handler; state; context }`                     |
| `StateMachineErrorResult<Handlers, State, Context>`                  | `{ status: 'error'; error: StateMachineError<Handlers>; handler; state; context }` |
| `StateMachineResult<Handlers, State, Context, Finished, Failed>`     | Union of the three results                                                         |
| `StateMachineDefinition<Handlers, State, Context, Finished, Failed>` | `{ run: (input) => Promise<StateMachineResult> }`                                  |
| `StateMachineErrorCode`                                              | `'handler_failed' \| 'invalid_handler_return' \| 'missing_handler'`                |
| `StateMachineErrorData<Handlers>`                                    | `{ code; message: string; handler: Handlers }`                                     |

## Build and test

```console
npx nx build state-machine
npx nx typecheck state-machine
npx nx test state-machine
```

`build` and `typecheck` are inferred by the `@nx/js/typescript` plugin; `build` compiles `src/` with [`tsconfig.lib.json`](tsconfig.lib.json) into `dist/` ([`nx.json`](../../nx.json)). `test` compiles the source and the tests with [`tsconfig.spec.json`](tsconfig.spec.json) into `dist-tests/`, which checks the type inference and the `@ts-expect-error` cases of [`tests/types.test.ts`](tests/types.test.ts) and [`tests/state-machine.test.ts`](tests/state-machine.test.ts), then runs the behavioral tests in [`tests/`](tests/) with `node --test` ([`project.json`](project.json)).
