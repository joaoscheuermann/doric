# session

`session` is a process-local, in-memory store of values keyed by caller-owned string IDs, with lazy creation that runs at most once per ID at a time: when several callers ask for the same missing ID at once, they share one creation instead of building duplicates ([`session.ts`](src/lib/session.ts)). It is meant to hold per-request or per-conversation resources, such as a provisioned workspace, inside one process.

Part of [Doric](../../README.md).

## Who uses it

The package is a library for packages and applications; it uses no API of Node.js or of the browser. The host application lists it as a dependency and as a TypeScript project reference ([`package.json`](../../app/backend/doric-host/package.json), [`tsconfig.lib.json`](../../app/backend/doric-host/tsconfig.lib.json) and [`tsconfig.spec.json`](../../app/backend/doric-host/tsconfig.spec.json)); no source file of a bundle, package or application imports it.

## Entry point

The package is an ES module (`"type": "module"`) with one entry point, `session` ([`package.json`](package.json)):

| Export path      | Condition     | File                |
| ---------------- | ------------- | ------------------- |
| `.`              | `@org/source` | `./src/index.ts`    |
| `.`              | `types`       | `./dist/index.d.ts` |
| `.`              | `import`      | `./dist/index.js`   |
| `.`              | `default`     | `./dist/index.js`   |
| `./package.json` |               | `./package.json`    |

The workspace's TypeScript configuration sets the custom condition `@org/source`, so code in the workspace compiles against the source and needs no build of this package first ([`tsconfig.base.json`](../../tsconfig.base.json)). The entry point re-exports everything from [`session.ts`](src/lib/session.ts) ([`index.ts`](src/index.ts)). It declares one runtime dependency, `tslib`, which `importHelpers` ([`tsconfig.base.json`](../../tsconfig.base.json)) would use for compiler helpers; the compiled output of this source imports none.

## Public exports

All three exports are in [`session.ts`](src/lib/session.ts).

```ts
interface SessionEntry<Value> {
  readonly id: string;
  readonly value: Value;
}

interface SessionStore<Value> {
  get(id: string): Value | undefined;
  load(id: string): Promise<Value> | undefined;
  getOrCreate(id: string, create: () => Value | Promise<Value>): Promise<Value>;
  delete(id: string): boolean;
  list(): readonly SessionEntry<Value>[];
  clear(): void;
}

const createSessionStore: <Value>() => SessionStore<Value>;
```

`createSessionStore<Value>()` takes no options and returns a new, empty store whose values all have the type `Value`. Each store is independent: two stores share no entries.

### Usage

```ts
import { createSessionStore } from 'session';

type Workspace = { readonly path: string };
declare function provisionWorkspace(): Promise<string>; // the caller's own function
const sessions = createSessionStore<Workspace>();

const workspace = await sessions.getOrCreate('request-123', async () => ({
  path: await provisionWorkspace(),
}));

sessions.get('request-123'); // the stored Workspace
sessions.list(); // [{ id: 'request-123', value: workspace }]
sessions.delete('request-123'); // true
```

## Behavior

### Data

A store keeps two maps in memory, both keyed by the ID ([`session.ts`](src/lib/session.ts)):

- **Stored values**: the value of each ID whose creation has completed.
- **Creations in flight**: for each ID whose factory has not settled yet, the promise of that creation and a unique token that identifies it.

An ID is in at most one of the two maps. An ID is any string, the empty string included; the store does not parse it. Nothing is persisted: the entries live as long as the store object, and are lost when the process ends.

### `getOrCreate(id, create)`

Returns a promise of the value for `id` ([`session.ts`](src/lib/session.ts)):

1. If a value is stored for `id`, it returns a promise resolved with that value and does not call `create`.
2. Otherwise, if a creation is in flight for `id`, it returns that creation's promise, the same promise object every caller of the creation receives, and does not call `create`.
3. Otherwise it starts a creation: it records the creation as in flight under a new token and returns its promise. `create` is called asynchronously, on a later microtask, never during the call to `getOrCreate`; a `create` that throws synchronously therefore rejects the promise instead of throwing from `getOrCreate`. `create` may return a value or a promise of one.

When the creation settles:

- **It succeeds.** If the creation is still the one in flight for `id` (its token matches), the value is stored for `id` and the creation leaves the in-flight map. The promise resolves with the value.
- **It fails.** If the creation is still the one in flight for `id`, it leaves the in-flight map and nothing is stored, so the next `getOrCreate(id, …)` starts a new creation. The promise rejects with the error `create` threw or rejected with, unchanged, for every caller that joined the creation.
- **It was removed while running.** When `delete(id)` or `clear()` removed the creation before it settled, or a later creation for the same `id` has taken its place, the token no longer matches: the outcome reaches the callers of that creation (they receive its value or its error) but the store keeps nothing from it and leaves the newer entry for `id` untouched.

The store does not cancel a running factory, does not time it out and does not retry it.

### `get(id)`

Returns the stored value for `id`, or `undefined` when none is stored; a creation in flight does not count ([`session.ts`](src/lib/session.ts)). When `Value` itself admits `undefined`, a stored `undefined` and a missing entry look the same through `get`; `load` tells them apart.

### `load(id)`

Returns a promise for the value of `id` without starting a creation ([`session.ts`](src/lib/session.ts)): a promise resolved with the stored value when one is stored, the promise of the creation in flight when there is one (the same object `getOrCreate` returned), and `undefined` otherwise.

### `delete(id)`

Removes the stored value and the creation in flight for `id`, and returns `true` when either existed, `false` otherwise ([`session.ts`](src/lib/session.ts)). Removing a creation in flight does not stop its factory; its outcome follows the rule "It was removed while running" above, and the next `getOrCreate(id, …)` starts a new creation.

### `list()`

Returns a new array of `{ id, value }` objects, one per stored value, in the order the values were stored, which is the order their creations completed, not the order they were requested ([`session.ts`](src/lib/session.ts)). Creations in flight are not listed. The array and its entry objects are new on each call, so later changes to the store do not change them; each `value` is the stored value itself, not a copy. An ID deleted and created again is listed at the end.

### `clear()`

Removes every stored value and every creation in flight ([`session.ts`](src/lib/session.ts)). Running factories are not stopped; each follows the rule "It was removed while running" above.

## Side effects, limits and errors

- **Side effects.** None besides calling the factories the caller passes: the store starts no process or timer, opens no file or connection and emits no event ([`session.ts`](src/lib/session.ts)).
- **Limits.** The store has no size limit, no expiry and no eviction; an entry stays until `delete` or `clear` removes it. It is local to one process and is not coordinated across processes. It does not dispose of the values it holds: releasing a resource stored in it is the caller's work, before or after removing it.
- **Errors.** The store throws no error of its own and defines no error class. The only rejection a caller sees is the one its factory produced, as described under `getOrCreate`.

## Build and test

The package has these Nx targets, besides the inferred `build-deps` and `watch-deps` ([`project.json`](project.json); `build` and `typecheck` are inferred by the `@nx/js/typescript` plugin of [`nx.json`](../../nx.json)):

| Command                    | What it runs                                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx nx build session`     | `tsc --build tsconfig.lib.json`: compiles `src/` to `dist/`, with declarations ([`tsconfig.lib.json`](tsconfig.lib.json))                                                                                      |
| `npx nx typecheck session` | `tsc --build tsconfig.json --emitDeclarationOnly`: type-checks the package; it runs `build` first                                                                                                              |
| `npx nx test session`      | `tsc -p packages/session/tsconfig.spec.json`, which compiles `src/` and `tests/` to `dist-tests/`, then `node --test packages/session/dist-tests/tests/*.test.js` ([`tsconfig.spec.json`](tsconfig.spec.json)) |

The tests, in [`session.test.ts`](tests/session.test.ts), use `node:test` and cover typed storage, reuse of a stored value, one creation for concurrent calls, a new creation after a failure, `delete`, the order of `list`, and `clear` with a creation in flight.
