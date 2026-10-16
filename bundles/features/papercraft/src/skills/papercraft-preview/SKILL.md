---
name: papercraft-preview
description: 'Publishes a visual change as a live preview node of the conversation, built from real code, instead of describing it. Use when the change is easier to judge by looking than by reading a diff, and the user should see it, comment on it and steer it.'
allowed-tools:
  - papercraft_preview
  - comment_reply
  - write
  - edit
order: 3400
---

# Papercraft Preview

## Purpose

Let the user **see** the change instead of imagining it. The tool publishes real code — a self-contained HTML file, or a Project React component compiled and rendered live with the app's own React — as a live preview in a node of the conversation, where the user selects, comments and asks for adjustments. The preview is a **window, not a gate**: the Doric default is to proceed, so publish the preview and implement the change, and let the comments steer. It is an **artifact** — the `preview` kind of the Project's artifact registry —, so it has a stable `artifact_id`, immutable revisions, and the anchored comments as its review state.

## Use this skill when

- the change is visual and easier to judge by looking than by reading a diff: layout, spacing, a component's states, a new screen;
- the user asks to see, preview, mock or prototype a UI, or to compare alternatives;
- the user has not decided yet — a preview is cheaper to change than an implementation;
- an earlier preview exists and the user asked for an adjustment: publish a **new revision** of the same preview, so the previous node and its comments stay.

## Do not use this skill when

- the change is not visual: refactors, data, configuration, scripts, docs;
- the goal is to inspect the running app rather than a proposed state;
- the preview would need a running server or third-party content the app cannot host: say what is missing instead of previewing something else.

## Procedure

1. Decide the preview's source from the code the change touches — read the Project's component index first when there is one: `component` when it is an existing Project component, so the preview is stamped with the real file and a comment becomes an edit instruction; `html` for a new idea with no component yet.
2. Give the tool a **workspace-relative path** to read, and keep the preview out of the Project's code: a preview is an artifact, and its payload lives in the Git-ignored artifact area, `.doric/artifacts/`, never in the source tree.
   - `component`: first look for the Project's preview setup — a **harness** (`.storybook/preview.{tsx,ts,jsx,js}` or `.papercraft/preview.{tsx,ts,jsx,js}`) and existing **stories** (`*.stories.{tsx,ts,jsx,js}`) for the component. When a story already shows the state to judge, pass the stories file itself as the path, with `entry` naming the story (the first story mounts by default). Otherwise write a **draft story** under `.doric/artifacts/drafts/`, for example `.doric/artifacts/drafts/checkout-card.stories.tsx`, in Storybook's CSF3 shape: a default export `{ component, args }` that imports the real component by a relative path (`../../../src/components/CheckoutCard.js`), and one named export per state to judge (`export const Empty = { args: { items: [] } }`); pass its path and `entry`. A component that needs no props can be passed directly, with `entry` naming its export when the file has no default export.
   - When the component needs providers (router, query client, store, i18n, theme) and the Project has no harness, create `.papercraft/preview.tsx` — a **versioned Project file**, like `.storybook/` — in Storybook's `Preview` shape (`export default { decorators: [(Story, context) => <Providers><Story /></Providers>] }`), importing the Project's global CSS (`import '../src/index.css'`) when it has one, and tell the user it was added and why. Never put providers or fixtures in ad-hoc wrappers that rebuild the app.
   - `html`: write the self-contained HTML (with its CSS) under `.doric/artifacts/`, for example `.doric/artifacts/drafts/checkout.html`, and pass that path.
3. Call `papercraft_preview` with the title, the source, the path and, optionally, the anchors (`targets`) and a note. It builds the payload into the artifact's directory, `.doric/artifacts/<artifact_id>/`, and creates the artifact at revision 1. It returns the state of the preview — its `artifactId`, the revision, the unresolved `comments` with their anchors and `replies`, and the `review` — not a write confirmation.
4. Implement the change with the normal tools, in the code the preview shows. The preview is not a gate: when `review.pending` is `false`, proceed right away. When it is `true` — the Project's review policy is `request` — publish, say that the revision waits for the user's approval, and do not write the change into the Project's code until the approval (`artifacts.approved/v1`) arrives.
5. On comments, publish a **new revision** of the same preview: edit the payload (or the component), then call `papercraft_preview` again with the same `artifact_id`, a note saying what changed and, if it moved, the new `path` — the title, source and path carry over otherwise. The previous node and its comments stay, so the reader can compare "what I asked" with "what came". Each comment carries an anchor — the stamped file and line, a selector, or a position with the nearest element — and its thread's `replies`, oldest first; the last one may be the user's answer to your question. Address each one, then answer it with `comment_reply` (its `commentId`): say what changed, or ask what is unclear, and set `resolve` when it is done. The next call returns whatever is still unresolved.

## Ambiguous or incomplete comments

- A comment is ambiguous when it can be read in more than one way that leads to a different change, and incomplete when the change needs a value or a decision it does not give (which element, which size, which state, which copy).
- Do not guess. Answer that comment with `comment_reply`: ask one specific question, naming the readings or options you see (for example, "40px or 48px tall?"), and leave it unresolved. Do not change what the comment points at until the user answers.
- Act on the other comments as usual; one unclear comment does not hold back the rest.
- The user's answer arrives as the last entry of that comment's `replies`. Then make the change, reply with what changed, and set `resolve`.

## Writing a component preview

- The tool compiles the source and every file it imports from the Project, and the node mounts the result live: state, hooks and interaction work. Each element the Project's code writes is stamped with its file and line, so a comment points at the real component.
- The nearest harness, walking up from the previewed file, wraps every component preview (a draft under `.doric/` gets the workspace root's): its `decorators` (`(Story, context) => …`, applied as Storybook does — the story's, then the meta's, then the harness's, the harness outermost), `parameters` and `args` (merged harness, then meta, then story). `context` carries `args`, `parameters`, `globals.theme` (`'light'` or `'dark'`), `viewMode: 'story'` and `papercraft.portalContainer`. `@storybook/addon-themes` decorators work; other Storybook addons usually do not — when the harness cannot be bundled, the preview renders without it and the call returns a warning naming the import.
- A story renders `story.render(args, context)`, else `meta.render`, else `<meta.component {...args} />`. Actions are not synthesized: an `on*` prop the args do not give is `undefined`, so give handlers in `args` when the component needs them.
- Overlays (dialogs, popovers, tooltips, menus) must portal into `context.papercraft.portalContainer` — pass it as the Radix `Portal`'s `container` (from the harness, through the Project's own context, or from a story's `render`) — or they open outside the preview, unstyled and out of reach of comments. `desktop/ui` overlays already land there; this is for the Project's own.
- Relative imports (`./x.js` finds `x.tsx`) and the Project's `tsconfig.json` `paths` aliases (`@/components/...`) resolve. `react` and `react-dom` are the app's own; `lucide-react` is bundled. Other packages are read from the Project's `node_modules` when small enough; when one cannot be bundled the call fails naming it — replace it with a stub in the story or the harness (a fake data hook, a static list) rather than dropping the preview.
- Do not fetch, read files or call the Project's backend from the preview: pass fixture data as args.
- Styles: the CSS the harness imports is the Project's global sheet, compiled with Tailwind v4 — the Project's own tokens and utilities, in light and dark. Without one, the preview gets the utilities its sources use over the app's theme tokens (`bg-primary`, `text-muted-foreground`). A CSS file a component imports is appended; a Tailwind v3 sheet (`@tailwind` directives) is skipped with a warning, and the app's theme is used.
- A compile error fails the call before anything is published, naming the file and line: fix the story or the import and call again. Read the call's `warnings`: they name what the preview left out.

## Writing the HTML

- Do not set a `background` on `body` or `html` unless the change is the page background itself, such as a full screen whose background is part of the design. The canvas already draws the stage; a `body` background paints a page-wide block around the component, and the block follows the app's theme.
- Put every `@media` block (`prefers-color-scheme`, breakpoints) after the base rules it overrides. At equal specificity the later rule wins, so an override written before its base rule is silently lost, and the preview mixes themes or layouts.

## Completion

The user has a live preview of the change, with its revision shown and the comments anchored to it, and the change was implemented in the code the preview shows — or is waiting for the approval the Project's review policy asks for.
