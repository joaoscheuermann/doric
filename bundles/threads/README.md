# Threads bundle

`threads` contains the delegation capabilities Doric exposes to its agent. Its
build writes `bundles/threads/dist`, which `doric:build-bundles` stages into
`agents/doric/dist/bundles/threads`; the Direct host loads it through the
`bundle` loader.

## Capabilities

The bundle provides these always-available tools, which act only on the calling
prompt's direct child threads in the same project:

- `thread-spawn` — create a child chat and delegate a self-contained task;
- `thread-list`, `thread-get` — observe a direct child's state and, once a prompt
  has finished, its materialized result;
- `thread-events` — read a bounded, digested page of a child's persisted events;
- `thread-send` — queue a follow-up instruction in a child;
- `thread-interrupt`, `thread-terminate` — cancel one active prompt or close a
  child subtree.

Each tool reaches the calling prompt's children through `runtime.threads/v1`
(`runtime/contracts`), scoped by the prompt `Call` it runs under, and returns
the serialized result. The bundle never imports `agents/doric` internals.

Skills cover delegating self-contained work, inspecting delegated work, and
steering or closing children. Skills live in `src/skills/<name>/SKILL.md` and
are registered in lexical folder order; `thread-delegation` is marked
`alwaysAvailable` in its frontmatter.

## Client part

`src/client` draws another Thread's input in a conversation (a delegated
instruction or result) as `<threads-delegated-turn>`, registered as chat's
renderer for `chat.delegated-input/v1` when `chat.views/v1` is available. It
shows `Instruction from:` or `Result from:`, the sender (its name from
`layout.workspace/v1` when the tree knows it, as a link to its conversation,
else its short id), `Status: …` and the text through chat's
`<chat-readonly-markdown>`. An instruction starts open and a result closed.

## Change the bundle

1. Update a tool in `src/host/tools/<name>.ts` or add a skill at
   `src/skills/<name>/SKILL.md`; tools are registered in order in
   `src/host/index.ts`.
2. Reach the runtime only through contracts declared in `manifest.json`
   `requires`.
3. Keep each skill's `allowed-tools` references local to this bundle.
4. Build and test; the build validates the manifest and skills and
   dry-activates the host part.

## Development

```console
npx nx build bundle-threads
npx nx typecheck bundle-threads
npx nx test bundle-threads
```

To rebuild and stage every bundle used by the Direct host:

```console
npx nx run doric:build-bundles
```
