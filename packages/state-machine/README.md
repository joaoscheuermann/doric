# state-machine

Typed, reusable state-machine definitions for the TypeScript agent core.

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

`Context` and the state object are the only required configured types.
The initializer infers the available handler names from the exhaustive handler
map, so both `initial` and `transition` accept only those names.

Each handler receives the current state, the run context, and
`transition`, `finish`, and `fail` actions. Handlers may mutate their state.
Handlers explicitly pass the next state to `transition`. The machine creates a
shallow copy of that supplied object before passing it to the next handler.

A definition stores only its handler map. Every `run` keeps its context,
current handler, and current state local to that call, so the same definition
can be run repeatedly or concurrently.

## Results

`run` resolves one of three results:

- `status: 'finished'` contains the value passed to `finish`.
- `status: 'failed'` contains the exact domain value passed to `fail`.
- `status: 'error'` contains a `StateMachineError`.

Every result also contains the terminal `handler`, current `state`, and run
`context`. Engine errors use only `handler_failed`, `invalid_handler_return`,
and `missing_handler`. A value thrown by a handler is preserved unchanged at
`result.error.cause` on a `handler_failed` result.

The package is process-local and has no persistence, listeners, recovery
hooks, or external side effects.

## Testing

Run `npx nx test state-machine` to compile and run the package tests.
