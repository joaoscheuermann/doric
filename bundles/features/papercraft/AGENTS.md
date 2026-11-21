# papercraft

Apply these rules to `bundles/features/papercraft/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to drawing `papercraft` fences as live previews of a
Project's code in a sandboxed frame, with the comments pinned to them, and to
the repository libraries and `Export` builds those previews load. Do not draw
the fences of another tag: a fence's drawing belongs to the bundle that owns
its tag. Do not give a program an action, a data query or any way to send to
the conversation: the reader answers a program only with pinned comments. Do
not store a program anywhere but the Thread's log, where its fences are.

## Rules

- Read [`README.md`](README.md) for what the bundle does before adding to it.
- In the window, run Project code only inside a program frame: an `<iframe>`
  whose `sandbox` is `allow-scripts` alone. Never mount a program, an
  `Export` module or a library module in the app's document.
- Parse every message a frame sends with `frameMessage` of
  `src/client/frame-protocol.ts`, and drop what does not parse: the frame runs
  the Project's code. Add a message only to the strict schemas and types of
  that module; handle an app → frame message in
  `src/client/frames/preview/shell.ts` or
  `src/client/frames/openui/runtime.ts`; take a frame → app message off the
  port in `src/client/surface/live-frame.tsx`, which parses it, and handle it
  in the `onMessage` of `src/client/surface/preview-surface.tsx`.
- In a module under `src/client/frames/`, import `frame-protocol.ts` only with
  `import type`, and take run-time values from `frame-constants.ts`: a value
  import of `frame-protocol.ts` carries zod into the frame.
- In `src/client/`, import `@openuidev/*` only in
  `src/client/openui-adapter.ts`, `src/client/frames/openui/runtime.ts` and,
  for react-ui's stylesheet, `src/client/frames/openui/sheets.ts`.
- Keep `src/sandbox/` and the host modules it imports (`src/host/bundle.ts`,
  `harness.ts`, `entry.ts`, `paths.ts`) free of host services and host disk
  reads: the build bundles them into the runner that runs in the Project's
  sandbox. Read Project files there only through the `SourceReader` passed in.
- Read Project files from the host only through `files/v1`
  (`src/host/files.ts`), and run sandbox work only through
  `runtime.lease/v1.withLease` in `src/host/sandbox.ts`; never acquire a lease.
- Write inside `.doric/papercraft/` of a Project only through the runner jobs
  of `src/host/sandbox.ts`, which write the ignore files first. Write no other
  Project file, except that `src/host/ignore.ts` alone writes
  `.doric/artifacts/.gitignore` and deletes a `.doric/.gitignore` whose whole
  content is `*`.
- Never let `papercraft.programs/v1.library` reject for a library problem:
  answer `failed` with the error cut to 4,096 characters.
- Write a file into `papercraft.cache/v1` only after its SHA-256 matches the
  entry's, staged and renamed into place (`src/desktop/cache.ts`).
- Keep `src/client/surface/canvas-source.ts` free of the DOM and React:
  `src/desktop/commands.ts` imports it into the desktop part.
- Register the flush of the `papercraft-program` comment kind only from
  `src/desktop/`, inside `whenAvailable(ChatComposerV1, …)`: `registerFlush`
  carries a function and serves only the main process.
- Never import a `files`, `comments` or `chat` package: reach `files/v1`,
  `comments/v1`, `chat.views/v1`, `chat.composer/v1` and `chat.send/v1`
  through the structural copies in `src/contracts/`. In `src/client/` and
  `src/desktop/`, reach `runtime.threads/v1` through its copy too, and import
  no `runtime` package; in `src/host/`, take the `runtime.*` contracts and
  types from `runtime/contracts`. When the owner changes a contract this
  bundle copies, change the copy to match it: nothing checks the copy against
  the owner's definition.
- Teach every change of what an agent may write in a papercraft fence or a
  schema file in [`src/host/skills/papercraft.md`](src/host/skills/papercraft.md),
  in the same change, and keep that file at most 8,000 characters.
- Within a part, put new code:
  - what the fence node or the canvas window draws or does in
    `src/client/surface/`, one module per concern, composed in
    `preview-container.tsx`;
  - what runs inside the frame in `src/client/frames/openui/` (the program
    runtime) or `src/client/frames/preview/` (the shell, input, scene,
    storage);
  - libraries, `Export` builds and the host memo in `src/host/`, and work that
    runs in the Project's sandbox in `src/sandbox/`, with each new job field in
    the schemas of `src/sandbox/protocol.ts`.
- Add a command of the canvas as its id constant in `src/contracts/index.ts`
  and, when the command has a key, its entry of `PAPERCRAFT_KEYBINDINGS`; a
  method of `PreviewController` in `src/client/canvas-registry.ts`,
  implemented in `src/client/surface/controller.ts`; a `defineCommand` in
  `src/client/commands.ts` that calls it through `controllerFor`; and an item
  of `canvasCommands`. List its id under `provides` of
  [`manifest.json`](manifest.json).
- Add a method of `papercraft.programs/v1` with `expose: 'desktop'` in
  `papercraftProgramsMethods`, and require the call's `projectId` and
  `threadId` through `scopeOf` in `src/host/programs.ts`.
- In a test of the host or the runner, script sandbox jobs through
  `ProgramsDeps.runJob`, or run them on a disk workspace
  ([`tests/support/disk-sandbox.ts`](tests/support/disk-sandbox.ts)); in a
  client test of a frame, fake the frame with
  [`tests/client/support/fake-frame.ts`](tests/client/support/fake-frame.ts).
- Update, in the same change, the feature doc
  [papercraft](../../../docs/features/papercraft.md) with any change of what
  the reader or the agent sees;
  [comments](../../../docs/features/comments.md) with any change of the
  `papercraft-program` kind, its target or its anchors;
  [skills](../../../docs/features/skills.md) with any change of the skill's
  registration (name, order, `alwaysAvailable`, `allowedTools`);
  [diagrams in OpenUI fences](../../../docs/features/openui-diagrams.md) with
  any change of the canvas's use of `desktop/ui/viewport`; and
  [Projects and Threads](../../../docs/features/projects-and-threads.md) with
  any change of how the bundle reaches a Project's sandbox.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "papercraft"`.

## Verify

- `npx nx run bundle-papercraft:typecheck`: run it after any change under
  `src/`, `stories/` or `.storybook/`.
- `npx nx run bundle-papercraft:test`: run it after any change under `src/`,
  `scripts/` or `tests/`, and run the tests only through this target, which
  builds the bundle first, because the tests load the built runner
  (`dist/sandbox/runner.mjs`) and frame (`dist/client/frames/openui.js`).
- `npx nx run bundle-papercraft:build`: run it after a change to
  `manifest.json`, `package.json`, a `tsconfig*.json` file, `src/contracts/`,
  `src/sandbox/` or `src/client/frames/`.

## Generated files

- `src/sandbox/shim-names.ts`: do not edit it by hand; run
  `node bundles/features/papercraft/scripts/shim-names.mjs` after any change
  of the installed `@openuidev/react-ui`, `@openuidev/react-lang`,
  `@openuidev/lang-core` or `zod`.
