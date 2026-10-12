# bundle

`bundle` is the Doric bundle platform package. It holds the contract API that
bundles are written against, the service runtime shared by every environment,
and the Node loader and build tooling of the host.

| Entry              | Audience                      | Contents                                                                                                                 |
| ------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `bundle/contracts` | Bundle authors (browser-safe) | `define*`, `ref`, `Call`, `ContractError`, `Services`, the basic contract refs (`HooksV1`, `ToolsV1`, ...) and `doric.*` |
| `bundle/runtime`   | Platform only (browser-safe)  | Service directory, dispatcher, call propagation, manifest/composition/descriptor schemas, resolver, activation loop      |
| `bundle`           | Host (Node)                   | `startHost`, discovery, catalog, build CLI and testing helpers                                                           |
| `bundle/testing`   | Bundle unit tests             | `createTestServices`                                                                                                     |
| `bundle/schemas/*` | Anyone                        | Generated JSON Schemas of the manifest, composition, descriptor and platform contracts                                   |

`bundle/contracts` and `bundle/runtime` import only relative modules and
`zod`; `tsconfig.browser.json` typechecks them without Node types.

## Writing a bundle

```ts
import {
  defineMethod,
  defineService,
  type HostContext,
  ToolsV1,
} from 'bundle/contracts';
import { z } from 'zod';

export const greeter = defineService('greeter.api/v1', {
  greet: defineMethod({
    input: z.object({ name: z.string() }).strict(),
    output: z.object({ text: z.string() }).strict(),
    execute: ({ name }, call) => ({
      text: `${name} from ${call.caller.bundleId}`,
    }),
  }),
});

export const activate = ({ services }: HostContext) => {
  services.provide(greeter);
};
```

`manifest.json` (v1) declares identity, platform range and contracts:

```json
{
  "manifestVersion": 1,
  "id": "greeter",
  "version": "1.0.0",
  "engines": { "doric": "^1.0.0" },
  "provides": ["greeter.api/v1@1.0.0"],
  "requires": ["tools/v1@^1.0.0"]
}
```

Parts live at `host/index.js`, `desktop/index.js` and `client/index.js`;
skills at `skills/*/SKILL.md` (discovered in lexical directory order, with an
optional `alwaysAvailable` frontmatter flag). A manifest without
`manifestVersion` is read as v0 and converted in memory (`core` becomes
`files`, version `0.0.0`).

## Booting the host

```ts
import { startHost } from 'bundle';

const platform = await startHost({
  bundlesPath: 'agents/doric/dist/bundles',
  composition: { path: 'agents/doric/composition.json' },
  log: platformLog,
  sink: logSink,
});

await platform.ready();
```

`startHost` resolves the catalog (foundation, core, others; per-environment
`requires`; quarantine with reasons), activates each bundle with its own
services and disposal scope, and reports `mode: 'recovery'` when the core or a
chosen foundation provider cannot activate. `catalog()`, `diagnostics()` and the
`doric.catalog/v1`, `doric.diagnostics/v1`, `doric.bundle/v1` and `doric.log/v1`
services expose the result.

`platform.storageIdentity()` asks the active `storage.backend/v1` provider for
the host's `{ hostId, storageGeneration }` (or answers `undefined` without
one). A resolved identity is kept and published as `catalog().storage`; a
failure is not kept, so the next call asks again. The host calls it once the
database is reachable.

## Basic contracts

`bundle/contracts` defines each basic contract's interface, its `ref`
(`StorageV1`, `SecretsV1`, ...) and its method table (`storageMethods`,
`secretsMethods`, ...). A provider must implement exactly that table with the
same schemas, or `provide` fails with `contract_mismatch`. The tables are also
published under `bundle/schemas/contracts/`.

| Contract                           | Notes                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage/v1`, `storage.backend/v1` | Documents with revisions (`expect` revision 0 = must not exist), indexed queries (at most 1000 per page), streams with protocol `createdAt` and truncation marks, atomic commits (expect → delete → put → dropStreams → truncate → append), a commit feed, blobs, `health()` measurements and the backend's `identity()`                        |
| `secrets/v1`, `secrets.backend/v1` | Credentials by kind with the one field rule (`credentialFieldsSatisfied`, `credentialFieldsMessage`), `resolveByKind(kind, { exclude }?)`, `redactions()`, and the local `view()` and `registerReferences(source)`; the backend stores plaintext across the contract                                                                            |
| `settings/v1`                      | Spaces with `get`, `entry` (`value`, `revision`, `version`, `updatedAt`, `generation`), `set` with `expectedRevision`, and `subscribe`                                                                                                                                                                                                          |
| `events/v1`                        | `register`, `sink` and `append`; the owner's `sink` names the scope keys and the stream of each row (`{key}` placeholders), so the platform knows no Thread log: the runtime's sink is `runtime.thread.events/{threadId}` with `{ projectId, threadId, promptId }`, and its stored envelope is `runtime/contracts`' `threadEventEnvelopeSchema` |

Every contract documents its error codes beside it; they are listed in
`contractErrorCodes`.

## Build tooling

```console
node packages/bundle/dist/build/cli.js build <bundleDir>
node packages/bundle/dist/build/cli.js stage <dest> <bundleDir...>
```

`build` runs after `tsc`: it validates the manifest, copies skills, dry-activates
the host and desktop parts to compute each contract's environment and
cardinality, writes `dist/contracts.json` and `dist/schemas/<contract>.json`
(JSON Schema 2020-12). There is no semver check against a published
baseline yet: `contracts.published.json` files and the `baseline` command were
removed until publishing exists (stage 11), and a leftover file is ignored.
`stage` copies each `dist` into `<dest>/<id>`.

## Development

```console
npx nx run bundle:build
npx nx run bundle:typecheck
npx nx run bundle:test
```
