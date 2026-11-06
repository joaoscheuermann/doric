- Load the `openui` skill first if it is not loaded; it teaches the language and the built-in components.

## The papercraft fence

A papercraft fence holds an OpenUI Lang program that the app draws in a frame with this repository's components. Use it to preview repository components or exports; use an ```openui-lang fence for any other UI.

Open each papercraft fence with ```papercraft followed by a name for the program, its identity: lowercase letters, digits and hyphens, starting with a letter, at most 64 characters. To change a program you wrote earlier, write a new fence with the same identity holding only the statements that change; the app merges them into the program by statement name. A fence without an identity starts a new program and never changes an earlier one.

A new preview:

```papercraft settings-form
root = Stack([title, form])
title = TextContent("Settings", "large-heavy")
form = AppSettingsForm("Ada Lovelace", true)
```

A later change to its form:

```papercraft settings-form
form = AppSettingsForm("Grace Hopper", false)
```

A fence with the same identity as an earlier fence is a patch: the app merges it into that program. A new program, under a new identity or without one, is always written whole and starts with its root statement, `root = …`. Never send a patch, or any fragment without `root`, as a new program: the app draws nothing for it.

## Export

`Export(path, name?, props?)` draws a module's export from the repository:

- `path`: the file, relative to the workspace root, for example `"apps/web/src/Button.tsx"`;
- `name`: the export to draw; without it, the module's default export or its story;
- `props`: an object passed to the component, or spread over the story's args.

`path` and `name` must be string literals. At most 8 distinct exports per program.

```papercraft button-states
root = Stack([primary, disabled], "row")
primary = Export("apps/web/src/Button.tsx", "Button", {"variant": "primary"})
disabled = Export("apps/web/src/Button.tsx", "Button", {"disabled": true})
```

## Data and state

`Query` and `Mutation` do not exist in papercraft fences: write all data as literal values. A papercraft fence has local state only: `$variables`, tabs, toggles, form fields, `@Set` and `@Reset` work inside the preview, but nothing in it sends anything to the conversation. The reader answers a preview with pinned comments.

## Repository libraries

A repository library is the set of components declared under `.doric/papercraft/schemas/`. When one is built, its components and signatures reach you in a repository library instruction.

If no repository library instruction is in your context and `.doric/papercraft/schemas/` exists in this repository, list it and read the file of each component you use before you write a fence that uses it.

- After moving to another repository, start a new identity: a fence uses the library of the repository it was written in, and that repository's components are unknown elsewhere.
- After editing files under `.doric/papercraft/schemas/`, the new signatures arrive at the next prompt; a fence draws the files as they are when it is drawn.

## Writing schema files

- An entry file is a `.ts`, `.tsx`, `.js` or `.jsx` file directly in `.doric/papercraft/schemas/`. Files in its subdirectories are helpers that entry files may import.
- An entry file declares exactly one component: one of its exports is a `defineComponent` result from `@openuidev/react-lang`, and its `name` equals the file's base name, so `AppButton.tsx` declares `AppButton`.
- A component name must be unique in the library and must not be a built-in of papercraft fences: no react-ui component (for example `Button` or `Table`), `Export`, `Action`, `Query`, `Mutation`, `AskForm`, or a built-in function or step of the language.
- A schema's values must come from `schemas/` or from zod. Imports from elsewhere, such as the component itself, are not evaluated when the signatures are read, so a props schema must not read a value imported from outside `schemas/`, such as `z.enum(variants)` with `variants` from `src/`.
- At most 100 entry files, each at most 16 KiB, and at most 1 MiB for all of `schemas/`.

```tsx
// .doric/papercraft/schemas/AppButton.tsx
import { defineComponent } from '@openuidev/react-lang';
import { z } from 'zod';
import { Button } from '../../../src/components/Button';

export const AppButton = defineComponent({
  name: 'AppButton',
  props: z.object({
    label: z.string(),
    variant: z.enum(['primary', 'secondary']).optional(),
  }),
  description: 'The app button.',
  component: ({ props }) => (
    <Button variant={props.variant}>{props.label}</Button>
  ),
});
```

## Comments

The reader's comments on a preview arrive in `<comments>` under a target of kind `papercraft-program`, whose id is the program's identity. Answer each with `comment_reply`: say what you changed, or ask what is unclear, and resolve it when it is done. To change the preview, write a patch under the same identity.
