# files

Apply these rules to `bundles/features/files/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to the agent's work on the files of its Project's workspace
and the window's view of that workspace: the file tools and their skills,
`files/v1`, the Files view, file tabs, the tree read and the Project refresh
coordinator. Do not add to it a tool, view or read of another kind (shell,
Git, web, terminals): those belong to the bundles that own them, which reach
this one only through its contracts. Do not provide `files.decorations/v1`
here, and never name a bundle or contract of a provider of it: marks belong to
the bundle that knows what they mean.

## Rules

- Read [`README.md`](README.md) for what the bundle does, and the feature doc
  [Files](../../../docs/features/files.md) for the flow across bundles, before
  adding to it.
- Put a new tool in `src/host/tools/<name>.ts`, built with `defineTool` from
  `tool`, with a strict `zod` input object and a `zod` output schema (strict
  when it is an object), and register it in `src/host/index.ts` with
  `alwaysAvailable: true` and an `order` no other tool holds. Before choosing
  one, list the taken positions with
  `grep -rnE "order: [0-9]|_ORDER = [0-9]|^\s+\[[a-zA-Z]+, [0-9]+\]," bundles/*/*/src/host --include=*.ts`.
- Reach the sandbox from a tool only through `leaseSandbox` and
  `currentDirectory` of `src/host/sandbox.ts`, resolve a relative path
  against `currentDirectory`, and never acquire a lease.
- Answer every failure a tool detects itself in its output (an `error` field,
  `success: false` or an error line), never by throwing.
- Read listings only through the listing functions of `sandbox`, which hold the
  workspace's visibility rules; `find` and `grep` filter only through
  `src/host/tools/visible-files.ts`. Never restate those rules in a tool or a
  read.
- Add a `files/v1` method to `Files` and `filesMethods` in
  `src/contracts/index.ts`, implement it in `src/host/reads.ts` (or, for a
  write, `src/host/writes.ts`) with `expose: 'desktop'`, and run it only
  through `runtime.lease/v1.withLease`, answering every expected failure as a
  status in its value. Call it from the window only through
  `src/client/api/reads.ts` or `src/client/api/writes.ts`.
- Make no workspace write from the client part other than `createFile` and
  `createDirectory`, and never let either overwrite an existing entry.
- Keep `src/contracts/reads.ts` free of imports.
- Add a skill as `src/skills/<NN>-<name>/SKILL.md`, with `name`, `description`
  and `order` in its frontmatter and `NN` equal to `order / 100` in two
  digits, and never use an `order` another skill holds: find them with
  `grep -rn '^order:' bundles/*/*/src` and, for skills registered in code,
  the tool `grep` above.
- Bind the client's persistent state only through `src/client/state.ts`
  (`setFilesClient`, `filesClient`), set and cleared by `activate` in
  `src/client/index.ts`.
- Key every query of the bundle's query client `['files', projectId, …]`
  through `filesKeys` in `src/client/sandbox-store.ts`, so a Project refresh
  rereads it, and register every view that reads a Project with
  `useProjectReads` of `src/client/hooks/use-project-reads.ts` while it is
  mounted. Never reread a query of another bundle.
- Put new window code in the folder of `src/client/` that holds its kind:
  `api/` for adapters of contracts, `reads/` for pure transforms of read
  answers, `refresh/` for the coordinator, `stores/` for view state, `tree/`
  for the Files view, `file/` for the file tab, `chat/` for drawings in the
  conversation and `hooks/` for React hooks. Define a new element in
  `src/client/elements.tsx` (a drawing in the conversation in `src/client/chat/`)
  and register it with `ui.define` in `activate` of `src/client/index.ts`;
  add a region item to `filesRegions` in `src/client/index.ts` and a command
  beside `openFileCommand` in `src/client/commands.ts`, registered in
  `activate`; and dispose of each registration in the cleanup `activate`
  returns.
- Read another bundle's contract from an element only through `useService` of
  `src/client/hooks/use-service.ts`, and render nothing while it is absent;
  reach `files/v1` only through `src/client/api/`.
- Draw a tool's call in the conversation by adding its spec to
  `filesToolRenderers` in `src/client/chat/views.ts`; when the tool writes the
  sandbox, add its name to `WRITING_TOOLS` in
  `src/client/refresh/tool-refresh.ts`.
- Never import `chat/contracts` except with `import type`: reach
  `chat.hooks/v2` only through the structural copy `ChatHooksV2` in
  `src/client/api/peers.ts`, inside `HooksV1.whenAvailable`, and
  `chat.views/v1` only through the `ChatViewsV1` reference in
  `src/client/chat/views.ts`, each registration in a `whenAvailable` of its
  own. Keep both under `optional` in [`manifest.json`](manifest.json). When
  chat changes the input of a hook the copy names, change the copy to match:
  nothing checks it against chat's definition.
- Merge the marks of `files.decorations/v1` only in
  `src/client/tree/decorations.ts`, and keep the tree's own read error ahead of
  any provider's error.
- When you raise `version` in `manifest.json` or a `provides` entry, update
  `tests/manifest.test.ts` and `tests/workspace-sheet.test.ts`, which pin them;
  when you add or reorder a tool, update `tests/activate.test.ts`.
- Keep the Monaco slider rule of `src/client/styles.css` unlayered and after
  its `@source` lines.
- Add the test of each change in the same change: a tool test as
  `tests/<tool>.test.ts` over `createFakeSandbox` of
  [`tests/fake-sandbox.ts`](tests/fake-sandbox.ts) and the services of
  [`tests/support/services.ts`](tests/support/services.ts); a `files/v1` test
  in `tests/reads.test.ts` or `tests/write-entry.test.ts`; a test of DOM-free
  client logic in `tests/`; and a rendered-view test in `tests/client/`
  through [`tests/client/support/render.ts`](tests/client/support/render.ts).
  Add or update the story of a changed view under [`stories/`](stories).
- Record a change of this bundle's behavior in the feature doc
  [Files](../../../docs/features/files.md), and also in each other feature doc
  the README's intro lists that describes the changed behavior.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "files"`.

## Verify

- `npx nx run bundle-files:typecheck`: run it after any change under `src/`
  or `stories/`.
- `npx nx run bundle-files:test`: run it after any change under `src/`,
  `tests/` or `manifest.json`, and run the tests only through this target,
  which builds the bundle first.
- `npx nx run bundle-files:build`: run it after a change to `manifest.json`,
  `package.json`, a `tsconfig*.json` file, `src/contracts/` or `src/skills/`;
  it validates the manifest and the skills and dry-activates the host part.

## Generated files

None.
