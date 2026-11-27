# web

Apply these rules to `bundles/features/web/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to letting the agent read public HTTP(S) content: searching
the web, opening a page as text and finding text in a page, with the skill that
tells the agent how to use them. Add to it no tool or action that writes to a
remote service, signs in or reads the Project's files or sandbox: acting on the
Project belongs to the bundles that own the Project's files and sandbox.

## Rules

- Read [`README.md`](README.md) for what the bundle does before adding to it.
- Add a new operation on web content as a new value of `action` in the `input`
  schema of `src/host/tools/web.ts`, with its own optional input fields, and
  dispatch it from `execute` in the same file, with its own branch before the
  final `findInPage` call, which `execute` runs for every other action.
- Keep `input` and `output` strict, and give every return path of the tool,
  `webError` included, a value that fits `output`: the tool-call layer rejects
  an unknown input key and a return that fails `output`.
- Add a new output field as optional, and set it only for the action that
  produces it, so that the other actions' returns stay valid.
- Return every failure an action can foresee (a missing or invalid argument, a
  failed request) as output through `webError`, naming the action and the
  argument in the message of an argument failure; never throw for it: the
  agent reads `error`.
- Accept a URL only through `normalizedUrl`, which admits `http:` and `https:`
  only.
- Make every request through `fetchText`, with the fetch function and timeout
  `createTool` receives: it applies the timeout and the `user-agent` header,
  and the tests replace only the fetch function it calls.
- Clamp every new numeric input to a default and a maximum with `clamp`, as
  `limit` and `maxChars` are, and state both in the README's Limits.
- Register tools only in `src/host/part.ts`, through `tools/v1`.
- Put a new tool in its own file `src/host/tools/<name>.ts`, built with
  `defineTool` of `tool` with strict `input` and `output`; register it in
  `src/host/part.ts` with an `order` no other bundle's tool uses (search
  `order:` under `bundles/*/*/src/host/`), test it in `tests/<name>.test.ts`,
  and update the registration test of `tests/router.test.ts`, which expects
  exactly one tool.
- Keep the `web` tool at `alwaysAvailable: true` and `order: 700`, and the
  `web-research` skill at `order: 1200`: these are global positions in the
  tool list and the skill catalog the model sees, and 700 sits between the
  `files` bundle's `tree` (600) and `write` (800).
- Keep `tools/v1@^1.2.0` under `requires` in [`manifest.json`](manifest.json)
  while the bundle registers with `order`: `order` exists from 1.2.0.
- Put a new skill in `src/skills/<name>/SKILL.md`, with `name`, `description`,
  `allowed-tools` and `order` in its frontmatter, and name in `allowed-tools`
  only tools that `tools/v1` registers: `skills/v1` rejects a skill that names
  a missing tool.
- Update `src/skills/web-research/SKILL.md` in the same change when an action
  is added, renamed or changes its arguments: its procedure names the actions.
- Test a change of the tool in [`tests/router.test.ts`](tests/router.test.ts),
  with a fake `fetch`, and never
  reach the network from a test.
- Test a change of registration in [`tests/router.test.ts`](tests/router.test.ts),
  through [`tests/support/router.ts`](tests/support/router.ts), and of a
  skill's frontmatter in [`tests/skill.test.ts`](tests/skill.test.ts).
- Update the feature doc [Web research](../../../docs/features/web-research.md)
  with any change to the tool's actions, inputs, outputs, limits or errors, or
  to the skill; update [Skills](../../../docs/features/skills.md) when the
  bundle adds or removes a skill.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "web"`.

## Verify

- `npx nx run bundle-web:typecheck`: run it after any change under `src/`.
- `npx nx run bundle-web:test`: run it after any change under `src/` or
  `tests/`.
- `npx nx run bundle-web:build`: run it after any change under `src/`, or to
  `manifest.json`, `package.json` or a `tsconfig*.json` file: the build
  validates the manifest and checks every skill file; the host part has no
  `dist/host/index.js` and is not dry-activated.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
