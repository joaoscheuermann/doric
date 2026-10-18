# session

A process-local, in-memory store for values keyed by caller-owned string IDs,
with safe lazy creation. When several callers ask for the same missing ID at
once, they share one creation instead of racing to build duplicates. Use it to
cache per-request or per-conversation resources, such as a provisioned
workspace, inside a single process.

Part of [Doric](../../README.md).

## Highlights

- **Deduplicated creation.** Concurrent `getOrCreate` calls for the same
  missing ID share one in-flight factory promise.
- **Typed values.** `createSessionStore<Value>()` keeps one value type per
  store.
- **No dependencies.** Plain `Map`s; nothing to configure.

## Usage

```ts
import { createSessionStore } from 'session';

type Workspace = { readonly path: string };
const sessions = createSessionStore<Workspace>();

const workspace = await sessions.getOrCreate('request-123', async () => ({
  path: await provisionWorkspace(),
}));

console.log(sessions.get('request-123'));
console.log(sessions.list());
sessions.delete('request-123');
```

## API

| Method                    | Behavior                                                                |
| ------------------------- | ----------------------------------------------------------------------- |
| `getOrCreate(id, create)` | Returns the stored value, joins an in-flight creation, or starts one.   |
| `get(id)`                 | Returns a completed value only, or `undefined`.                         |
| `load(id)`                | Returns a promise for the completed or in-flight value, or `undefined`. |
| `delete(id)`              | Removes a completed or in-flight entry; returns whether one existed.    |
| `clear()`                 | Removes every entry.                                                    |
| `list()`                  | Returns completed entries as `{ id, value }`, in insertion order.       |

A factory that rejects leaves nothing stored, so the next `getOrCreate` call
starts a new creation. If an entry is deleted or cleared while its factory is
running, the factory's eventual value is returned to its callers but not
stored.

## Scope

This package provides no persistence, expiry, cross-process coordination, or
factory cancellation. A host owns those policies and any cleanup required for
stored values.

## Development

```console
npx nx build session
npx nx typecheck session
npx nx test session
```
