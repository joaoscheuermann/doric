# git

Apply these rules to `bundles/features/git/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to running Git for the agent inside its Project's sandbox and
to showing the reader the Git state of the selected Project and Thread: its
changes, one file's comparison with `HEAD`, the working directory and branch,
the branch switch, Discard, and the choice of the identity and token the
agent commits and pushes with. Do not add to it a file browser, a file editor
or the opening of a file: opening a file belongs to the bundle that provides
`files.open-file/v1`. Do not add terminal sessions, credential storage or the
saving of configuration: each belongs to the bundle that owns that record.

## Rules

- Read [`README.md`](README.md) for what the bundle does, its contracts and
  its sentences before adding to it.
- Run the Git commands of a `git.commands/v1` method on the live Thread
  through `runtime.workspace/v1.withThread` or on the Project's current lease
  through `runtime.lease/v1.withLease`. Never acquire a lease, and answer every
  Thread or lease state as data, never as a thrown error.
- Run the `git` tool's commands only through `leaseSandbox` and
  `currentDirectory` of `src/host/sandbox.ts`, which reach the calling
  prompt's lease and working directory.
- Run a `git.commands/v1` method that writes to a repository with
  `exclusive: true`, check every guard before the first write, and answer a
  refusal as `{ status: 'refused', message }` with a sentence the window shows
  as it is. In such a method, pass every path after `--` and with
  `--literal-pathspecs`, so that a path is never a pattern.
- Keep the `git` tool in `src/host/tools/git.ts` non-interactive: run `git`
  with an argument array and no shell, keep the environment that disables
  prompts and editors, keep the working directory under the sandbox root, and
  never take a credential in its input.
- Add a fact to the Thread summary as one more labeled line of the probe
  script in `src/host/status.ts`, never as another sandbox command: the
  summary costs one command.
- Return no file content and no patch from `changes`: only `fileDiff` reads
  file content, bounded by `CONTENT_LIMIT_BYTES` in `src/host/changes.ts`.
- Add a method to `git.commands/v1` in both the `Git` interface and
  `gitMethods` of `src/contracts/index.ts`, with `.strict()` on an object
  input and `z.looseObject` for the objects of its output (the strict `ready`
  value of `discard` is the one exception). Write every schema there;
  never import a schema from `runtime/contracts` into `src/contracts/`,
  because the client part loads that module too.
- Implement the method in `createGitService` of `src/host/service.ts` with
  `expose: 'desktop'`. Make it a Thread method (a `threadId` input, run
  through `workspace(services, call).withThread`, with `exclusive: true` when
  it writes or must not race a prompt) or a Project method (the Project from
  `call.scope.projectId`, run through `lease(services, call).withLease`), and
  answer the Thread or lease state as `ThreadOutcome` or `LeaseOutcome`.
- Call `git.commands/v1` from the client part only through
  `src/client/api/git-api.ts`, and add there the guard of each new input and
  the check of each new answer.
- Keep every client read of a Project or a Thread in the store's one query
  client, under a key of
  `gitKeys` in `src/client/changes/store.ts` that starts with
  `['files', projectId, …]` or `['thread', threadId, 'git', …]` with
  `meta: { projectId }`, so that a Project's refresh rereads it. Bind state to
  the activation's services and `src/client/state.ts`, never to an element's
  services.
- Add an element to `defineGitElements` in `src/client/elements.tsx` with the
  shared `wrap`, define its tag in `activate` of `src/client/index.ts`, and
  add its region item to `gitRegions` with the slot name written as a literal
  checked by `satisfies typeof <SLOT>`.
- Reach `files.sandbox/v1`, `files.refresh/v1`, `files.open-file/v1` and
  `chat.hooks/v2` only through the ids declared in
  `src/client/api/peers.ts`, and keep each of them, and `terminal/v1`, under
  `optional` in [`manifest.json`](manifest.json), with the bundle working
  without it. Never import `chat/contracts`; when `chat` changes the input of
  `onThreadUpdateHook`, change the structural copy `ChatHooksV2` to match it.
- Keep `files.decorations/v1` the contract `files` declares: take its types
  with `import type` from `files/contracts`, and never make `files` name a
  `git.*` contract.
- Draw every change colour with a `--git-*` variable, and declare a new one
  in `src/client/styles.css` for both `:root` and `.dark`.
- Add a skill as `src/skills/<name>/SKILL.md` with `name`, `description`,
  `allowed-tools` and an `order` that no other skill of the bundle uses.
- Read [`manifest.json`](manifest.json) for the contracts the bundle
  provides, requires and may use before using another one; before adding an
  exception for this bundle, search
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  for `"bundle": "git"`.
- Write a host test over the fakes of
  [`tests/support/runtime.ts`](tests/support/runtime.ts) and
  [`tests/support/services.ts`](tests/support/services.ts), which run real
  `git` in a temporary directory. Write a render test with `render` of
  [`tests/client/support/render.ts`](tests/client/support/render.ts) over the
  fakes of `stories/support/`, and import React DOM and the client modules
  inside its `view` with a dynamic `import()`, never statically, because they
  must load after the window. Add a story under `stories/<folder>/` for each
  new view, in the folder that mirrors its `src/client/` folder.
- Update the feature doc [Git](../../../docs/features/git.md) with every
  change of what the agent or the reader can do with Git, and also
  [Files](../../../docs/features/files.md) for a change of the Files tree's
  marks, [Terminal](../../../docs/features/terminal.md) for a change of the
  busy check, [Credentials](../../../docs/features/credentials.md) for a
  change of the `GIT` kind or the Versioning section,
  [Settings](../../../docs/features/settings.md) for a change of the
  `/settings/git` route, its `settings-link` item or the fields
  `gitCredentialId` and `githubCredentialId`,
  [`cwd` tool](../../../docs/features/cwd-tool.md) for a change of how the
  `git` tool reads the working directory or of the repository hint that
  `status` refreshes, and
  [Error messages](../../../docs/features/error-messages.md) for a change of
  the bundle's toasts or read-failure feedback. Read
  [Projects and Threads](../../../docs/features/projects-and-threads.md) and
  [UI redesign](../../../docs/features/ui-redesign.md) before changing the
  working directory footer or the panel's views.

## Verify

- `npx nx run bundle-git:typecheck`: run it after any change under `src/` or
  `stories/`.
- `npx nx run bundle-git:test`: run it after any change under `src/` or
  `tests/`, and run the tests only through this target, which builds the
  bundle and compiles the tests into `dist-tests/` first.
- `npx nx run bundle-git:build`: run it after a change to `manifest.json`,
  `package.json`, a `tsconfig*.json` file, `src/contracts/`, `src/skills/` or
  `src/host/index.ts`: the build validates the manifest and the skills and
  dry-activates the host part.

## Generated files

None.
