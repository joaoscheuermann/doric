# state-machine

Typed, reusable state machines built from a plain map of async handlers. Each
handler does its work and returns what happens next: move to another handler,
finish with a value, or fail with a domain error. TypeScript infers the handler
names from the map, so a typo in a transition is a compile error, and every
outcome, including a thrown exception, comes back as a result instead of an
unhandled rejection.

Part of [Doric](../../README.md).

## Highlights

- **Inferred handler names.** `initial` and `transition` accept only names
  that exist in the handler map.
- **Three explicit outcomes.** Every run resolves `finished`, `failed`, or
  `error`, with the terminal handler, state, and context attached.
- **Reusable definitions.** Run state is local to each call, so one definition
  can run repeatedly or concurrently.
- **No side effects.** Process-local, no persistence, listeners, or
  dependencies beyond `tslib`.

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
```

`createStateMachine<Context, State, Finished, Failed>()` takes the context,
state, finish-value, and failure types; `Finished` defaults to `void` and
`Failed` to `unknown`, so `Context` and the state object are the only required
configured types. The initializer infers the available handler names from the
exhaustive handler map, so both `initial` and `transition` accept only those
names.

Each handler receives the current state, the run context, and `transition`,
`finish`, and `fail` actions. Handlers may be synchronous or asynchronous and
may mutate their state. The actions object is read-only and frozen, created
once per run.

## State and transitions

Top-level state must be a plain data object whose prototype is this realm's
`Object.prototype` or `null`. Arrays, `Date`, `Map`, and class instances are
not supported as top-level state. Property values are unrestricted: nested
objects, arrays, class instances, functions, and promises are allowed.

The exported `StateMachineState` constraint is `Record<string, unknown>`. Use a
record-shaped type alias like `State` above; interfaces without an index
signature may not satisfy this TypeScript constraint. This filters common
unsupported types but does not prove an object's prototype: structural typing,
type assertions, and JavaScript callers can still supply unsupported objects.
Runtime validates the top-level prototype, not generic domain property types.

Handlers explicitly pass the next state to `transition`. The executor creates a
shallow copy **after the handler returns or its promise resolves**, before
calling the next handler. Calling the helper does not snapshot the state:
mutations made between `transition(...)` and handler completion are included.
Literal actions follow exactly the same rule:

```ts
return { type: 'transition', handler: 'review', state };
```

The copy has a new top-level identity, with the supplied object's own
enumerable properties, but shares nested references. A null-prototype object's
transition copy is an ordinary object with `Object.prototype`. No deep cloning
occurs. The initial state is validated but passed by reference, so mutations by
the first handler affect the caller's object.

A definition stores only its handler map. Every `run` keeps its context,
current handler, and current state local to that call, so the same definition
can be run repeatedly or concurrently. This isolates execution control, not
caller-owned state or context objects shared between runs.

## Results

`run` resolves one of three results:

| `status`   | Carries                                           |
| ---------- | ------------------------------------------------- |
| `finished` | `value`: the value passed to `finish`.            |
| `failed`   | `error`: the exact domain value passed to `fail`. |
| `error`    | `error`: a `StateMachineError`.                   |

Every result also contains the terminal `handler`, current `state`, and run
`context`. Engine errors use only `handler_failed`, `invalid_handler_return`,
and `missing_handler`. Error metadata names the handler as
`result.error.data.handler` (formerly `data.state`); `result.state` remains the
state object.

- A thrown value or asynchronous handler rejection is preserved unchanged at
  `result.error.cause` on a `handler_failed` result.
- An unsupported initial state returns `handler_failed` with a `TypeError`
  cause before invoking a handler, retaining the supplied state and context.
- An unsupported transition state or malformed action returns
  `invalid_handler_return`, retaining the source handler's current state and
  context. It does not invoke the destination handler.
- A missing initial or destination handler returns `missing_handler`. For a
  valid transition to a missing handler, the terminal state is the transition's
  shallow copy and the error identifies that missing destination.
- Exceptions while inspecting an action/state or copying a transition also
  return `handler_failed`, preserving the thrown cause and source state.

Action validation captures the discriminant and relevant fields once, then
checks only that envelope and supported top-level state; it does not validate
the generic `Finished`, `Failed`, or state property types.

The package is process-local and has no persistence, listeners, recovery
hooks, or external side effects.

## Development

```console
npx nx build state-machine
npx nx typecheck state-machine
npx nx test state-machine
```

`test` compiles the source and tests with TypeScript (including inference and
`@ts-expect-error` checks), then runs the behavioral tests with `node --test`.
