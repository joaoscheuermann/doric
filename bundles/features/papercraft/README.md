# Papercraft bundle

**Stop describing UI changes. Show them, point at them, and steer them.**

Papercraft lets a Doric agent publish a visual change as a live preview right
inside the conversation, built from real code instead of a screenshot or a
paragraph of prose. You click the element you mean and leave a comment pinned
to it, like in Figma. The agent reads each comment with the exact file and line
it points at, answers it, and publishes a new revision next to the old one. You
see "what I asked" and "what came back" side by side, and the code follows.

It is a feature bundle with a host part (the tool that builds previews), a
desktop part and a client part (the preview node and its canvas window),
loaded by the `bundle` platform. See the [main README](../../../README.md) for
Doric as a whole and [`packages/bundle`](../../../packages/bundle/README.md) for
how bundles work.

## Why it matters

- **Real code, not mockups.** A preview is either a self-contained HTML page or
  one of your Project's own React components, compiled and mounted live.
  State, hooks and interactions work, so you judge the actual thing.
- **Comments that land on the code.** Every element your Project renders is
  stamped with its source file and line. A comment pinned on a button tells
  the agent exactly which `file:line` to change, so your feedback becomes an
  edit instruction with no ambiguity.
- **A real review conversation.** Comments form threads. The agent replies to
  each one, asks a specific question when a comment can be read two ways (for
  example, "40px or 48px tall?"), and resolves it when done. Pins show each
  thread's state at a glance: draft, open, waiting on you, or done.
- **History you can compare.** Every adjustment is a new revision of the same
  preview. Earlier revisions and their comments stay in the conversation, and
  comment pins follow the element they were attached to across revisions.
- **Works with what you already have.** Papercraft reads your Storybook setup:
  existing CSF3 stories, `.storybook/preview` decorators and providers, args
  and parameters. Your Tailwind v4 theme renders in light and dark.
- **You decide how much control to keep.** By default the agent publishes the
  preview and implements the change, and your comments steer the next round.
  Switch a Project to **Settings → Review → Pedir revisão** and each revision
  waits for you to press **Autorizar**: the tool reports the approval as
  pending, and the skill tells the agent not to write the change into the
  Project's code until you approve. The pause is an instruction to the agent,
  not a lock on the workspace.
- **Your source tree stays clean.** Previews and draft stories live in the
  Git-ignored `.doric/artifacts/` area of the Project, never in your source
  code.

## How it works

1. **The agent publishes.** When a change is easier to judge by looking than by
   reading a diff, the agent calls `papercraft_preview` with an HTML file or a
   component, story or draft story. The preview appears as a node in the
   conversation.
2. **You explore.** Interact with the preview in place, or open it in its own
   canvas window to pan, zoom, fit, isolate an element, browse the element tree
   and switch between revisions, from the toolbar or the keyboard.
3. **You comment.** Arm the comment tool and click an element. A dashed outline
   labeled `element · file:line` shows where the comment will land; hold `Alt`
   to pin a free point instead. Comments collect as drafts in the chat
   composer, and `Cmd/Ctrl+Enter` sends them together as your next prompt.
4. **The agent revises.** The tool always returns the unresolved comments with
   their anchors and replies, so the agent never depends on you repeating
   yourself. It answers each one with `comment_reply`, publishes the next
   revision, and implements the change in the code the preview shows.

## What it provides

- **Tool:** `papercraft_preview` creates a preview (revision 1) or, given an
  `artifact_id`, publishes its next revision. It answers with the preview's
  state: the current revision, the unresolved comments with their anchors and
  replies, and the review state. A compile error fails the call before
  anything is published, naming the file and line.
- **Skill:** `papercraft-preview` teaches the agent when a preview is worth it,
  how to pick between `html` and `component`, how to write draft stories and a
  harness, and how to handle ambiguous comments.
- **Artifact kind:** `preview`, registered with the `artifacts` registry, so
  every preview has a stable id, immutable revisions and anchored comments
  from the `comments` bundle.
- **UI:** the `papercraft-preview` node inside the conversation and the canvas
  window at `/papercraft/:projectId/:threadId/:artifactId`, which follows the
  Thread live.
- **Contracts:** `papercraft.previews/v1` and the canvas commands
  (`papercraft.open-canvas/v1`, `papercraft.approve/v1`, the `select`,
  `comment` and `pan` tools, `isolate`, `show-all`, the zoom commands and
  `select-revision`).

## Previewing your components

- **Use an existing story.** Point the tool at a `*.stories.{tsx,ts,jsx,js}`
  file and name the story in `entry`.
- **Or let the agent draft one.** Without a story, the agent writes a CSF3
  draft story under `.doric/artifacts/drafts/` that imports your real
  component.
- **Providers come from a harness.** The nearest `.storybook/preview.*` or
  `.papercraft/preview.*` wraps every component preview with its decorators,
  parameters and args, in Storybook's order. `@storybook/addon-themes`
  decorators work; most other addons do not.
- **Imports resolve like your app.** Relative imports and `tsconfig.json`
  `paths` aliases resolve. `react`, `react-dom` and `@base-ui/react` are the
  app's own, `lucide-react` comes from the host, and other packages are read
  from the Project's `node_modules` when small enough.
- **Styles are your Project's.** The global CSS the harness imports is compiled
  with Tailwind v4. Without one, the preview uses the utilities its sources use
  over a generic neutral theme. A Tailwind v3 sheet is skipped with a warning.
- **Overlays stay inside the preview** when they portal into
  `context.papercraft.portalContainer`.
- **Layout follows Storybook.** A preview is as wide as its content by default;
  `parameters: { layout: 'fullscreen' }` or `'padded'` lays it out at the
  canvas width.

Component sources are bundled with esbuild inside the Project's sandbox when
the sandbox image installs it under `/opt/doric/bundler`, as the image
`app/backend/doric-host/.sandbox.Dockerfile` builds does.

## Design

The full design, in Portuguese, including the parts not built yet, is in
[`docs/architecture/bundles/papercraft`](../../../docs/architecture/bundles/papercraft/README.md),
next to the [artifacts](../../../docs/architecture/bundles/artifacts.md) and
[comments](../../../docs/architecture/bundles/comments.md) registries it builds
on. `GROUNDING.md` remains the contract for what is implemented.

## Development

```console
npx nx build bundle-papercraft
npx nx typecheck bundle-papercraft
npx nx test bundle-papercraft
```

To rebuild and stage every bundle used by the Direct host:

```console
npx nx run doric-host:build-bundles
```
