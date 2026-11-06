# Papercraft bundle

**Stop describing UI changes. Show them, point at them, and steer them.**

Papercraft lets a Doric agent show a visual change instead of describing it.
The agent writes a short [OpenUI Lang](../openui/README.md) program in a
`papercraft` fence of its answer, and the conversation draws it as a live
canvas node, with your Project's own components, while the answer streams. You
click the element you mean and leave a comment pinned to it, like in Figma. The
agent reads each comment, answers it, and writes a patch: a new fence with the
same identity holding only the statements that change.

It is a feature bundle with a host part (the skill, the libraries and the
builds), a desktop part (the module cache and the comment flush) and a client
part (the fence node and its canvas window), loaded by the `bundle` platform.
See the [main README](../../../README.md) for Doric as a whole,
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work and
the feature doc [`docs/features/papercraft.md`](../../../docs/features/papercraft.md)
for the concept and its decisions.

## Why it matters

- **Real code, not mockups.** `Export(path, name?, props?)` draws one of your
  Project's own exports or stories, compiled and mounted live, and a
  repository library lets the program use your components by name. State,
  hooks and interactions work, so you judge the actual thing.
- **Isolated from the app.** Each program runs in a sandboxed iframe with an
  opaque origin: its own JavaScript realm and document, no access to the
  app's DOM, globals or bridge, and in-memory `localStorage` and
  `sessionStorage` that nothing persists.
- **A real review conversation.** Comments form threads. The agent replies to
  each one with `comment_reply`, asks when a comment can be read two ways, and
  resolves it when done. Pins show each thread's state at a glance: draft,
  open, waiting on you, or done.
- **History you can compare.** Every patch is a new revision of the same
  program. Earlier revisions and their comments stay in the conversation.
- **Works with what you already have.** Papercraft reads your Storybook setup:
  existing CSF3 stories, `.storybook/preview` decorators and providers, args
  and parameters. Your Tailwind v4 theme renders in light and dark.
- **Your source tree stays clean.** No Project file is written for a preview.
  The only writes are under `.doric/papercraft/`: its `.gitignore`, the
  runner copy and temporary job folders, all ignored by Git except
  `schemas/`.

## How it works

1. **The agent writes a fence.** After loading the `openui` and `papercraft`
   skills, the agent opens a fence with `papercraft <identity>` (lowercase
   letters, digits and hyphens, starting with a letter, at most 64
   characters). A fence without an identity starts a new program.
2. **You explore.** Interact with the program in place, or open it in its own
   canvas window to pan, zoom, fit, isolate an element, browse the element tree
   and switch between revisions, from the toolbar or the keyboard.
3. **You comment.** Arm the comment tool and click an element; hold `Alt` to
   pin a free point instead. Comments collect as drafts in the chat composer,
   and `Cmd/Ctrl+Enter` sends them together as your next prompt, under a
   target of kind `papercraft-program` whose id is the program's identity.
4. **The agent revises.** It answers each comment with `comment_reply` and
   writes a patch under the same identity; the app merges it into the program
   by statement name.

A papercraft fence has no actions: `Query` and `Mutation` do not exist in it,
and nothing in it sends anything to the conversation. Errors of a drawn fence
reach the agent at its next prompt through `openui.programs/v1`.

## What it provides

- **Fence:** `papercraft`, drawn by `<papercraft-fence>`, registered with
  `chat.views/v1.registerFenceRenderer`. The canvas window reads the Thread's
  fences through `watchFences`.
- **Skill:** `papercraft`, registered at activation: the fence, `Export`,
  local state only, repository libraries and how to write schema files, and
  how to answer comments.
- **Repository libraries:** the components declared under
  `.doric/papercraft/schemas/` (one `defineComponent` per entry file, named for
  the file; at most 100 entry files, 16 KiB each, 1 MiB in all), built in the
  Project's sandbox. Their signatures reach the agent in a library instruct at
  a prompt's start or a move to another repository.
- **Event:** `papercraft.cwd/v1`, the Thread's working directory, appended at
  each prompt start and move; a fence binds to the library of the last one
  before it.
- **UI:** the fence node inside the conversation and the canvas window at
  `/papercraft/:projectId/:threadId/:identity`, which follows the Thread live.
  A chat window keeps at most three programs live, the ones used last; the
  others show a snapshot until a pointer or click brings them back.
- **Contracts:** `papercraft.programs/v1` (host: `library`, `export`, `read`),
  `papercraft.cache/v1` (desktop: verified module files under
  `userData/papercraft/`, served at `doric://app/papercraft-modules/*`), the
  canvas commands (`papercraft.open-canvas/v2`, the `select`, `comment` and
  `pan` tools, `isolate`, `show-all`, the zoom commands, `select-revision` and
  `send`) and `papercraft.snapshot/v1`, with which a window captures its own
  pixels.
- **Frame runtime:** `client/frames/openui.js`, the module the program iframe
  loads. It draws the program with OpenUI's renderer and talks to the app over
  one `MessageChannel` (`src/client/frame-protocol.ts`).
- **Old rows:** the `artifacts.*` rows of earlier Threads replay as nothing,
  and comments on old artifact previews are not listed.

## Previewing your components

- **Use an export or a story.** `Export` names a workspace file and, optionally,
  the export or story to draw; `path` and `name` are string literals, at most 8
  distinct exports per program.
- **Providers come from a harness.** The nearest `.storybook/preview.*` or
  `.papercraft/preview.*` wraps every component preview with its decorators,
  parameters and args, in Storybook's order; the search stops at the
  repository root. `@storybook/addon-themes` decorators work; most other
  addons do not.
- **Imports resolve like your app.** Relative imports and `tsconfig.json`
  `paths` aliases resolve. `react`, `react-dom` and `@base-ui/react` come from
  the frame's import map (the platform's files, evaluated in the frame),
  `lucide-react` comes from the host, and other packages are read from the
  Project's `node_modules` when small enough.
- **Styles are your Project's.** The global CSS the harness imports is compiled
  with Tailwind v4. Without one, the preview uses the utilities its sources use
  over a generic neutral theme. Dark mode is `class="dark"` on the frame's
  `<html>`. A Tailwind v3 sheet is skipped with a warning.
- **Overlays stay inside the preview.** Dialogs, popovers and tooltips portal
  into the frame's `document.body` as they would in your app.

Component sources are bundled with esbuild inside the Project's sandbox when
the sandbox image installs it under `/opt/doric/bundler`, as the image
`app/backend/doric-host/.sandbox.Dockerfile` builds does.

## Design

The living description is the feature doc
[`docs/features/papercraft.md`](../../../docs/features/papercraft.md), with its
specs [`docs/designs/papercraft-openui.md`](../../../docs/designs/papercraft-openui.md)
and [`docs/designs/openui.md`](../../../docs/designs/openui.md). The earlier
design, in Portuguese, is kept in
[`docs/architecture/bundles/papercraft`](../../../docs/architecture/bundles/papercraft/README.md)
for its frame decisions. `GROUNDING.md` remains the contract for what is
implemented.

## Development

```console
npx nx build bundle-papercraft
npx nx typecheck bundle-papercraft
npx nx test bundle-papercraft
```

To rebuild and stage every bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
