# The chat bundle

**Status:** proposed. Part of the [bundle architecture](../bundles.md); nothing here describes behavior already implemented, and the documentation remains the contract of the current implementation.

## Summary

In the default composition, the `chat` bundle owns the desktop's conversation surface: the `<chat-view>` element, the read store, the projection, the composer, the trail and the conversation's behavior. It produces no durable events; in the client it interprets and presents the events that other bundles register and write in the host, and it sends prompts and reads Threads through `runtime.threads/v1` (`RuntimeThreadsV1`), from `runtime`. It registers the route `/projects/:projectId/threads/:threadId`, a child of `/`, which appears in the `<core-outlet>` of the [layout](./layout.md). To extend the conversation, it offers an editor-independent service, `chat.views/v1`, where other bundles register stream projectors and block renderers, and a service specific to the default implementation, `chat.lexical/v1`, for Lexical extensions and nodes. The durable log remains the source of the conversation's data.

## What the bundle owns, requires and provides

### Owns

In the default composition, `chat` owns:

- `<chat-view>`;
- the read store;
- the projection;
- the composer;
- the trail;
- the conversation's behavior;
- the Thread route `/projects/:projectId/threads/:threadId` (formerly `threads.detail/v1`, of the `threads` bundle).

The `threads` bundle remains the owner of the delegation tools and of the child Thread cards; it no longer provides a Thread commands service.

### Requires

- `runtime.threads/v1` (`RuntimeThreadsV1`), provided by `runtime` in the host, to send prompts, read Threads and subscribe to the durable stream; it also covers the child Thread controls of the current `Host`. The `threads.commands/v1` contract (`ThreadsCommandsV1`) ceases to exist. Because it is provided in the host, the client part of `chat` reaches it through the client→host bridge by declaring it in `requires` (see [services and channels](./services-and-channels.md)).
- `ui/v1`, provided by the core in the client, to define `<chat-view>` and create it with `ui.create` (see [UI in the client](./core.md#window-client)). `chat` adds no region item: the conversation appears in the workspace's main area because the route has `parent: '/'` and is shown in the `<core-outlet>` that the [layout](./layout.md) puts in its template.
- `commands/v1`, provided by the core in the client, to dispatch commands from DOM intents of the conversation's blocks, such as `git.open-comparison/v1`.
- `hooks/v1`, provided by the core by default, in which the client part of `chat` defines and executes its own hooks, `chat.hooks/v2` (`ChatHooksV2`), such as `onBeforeRenderBlockHook` (see [hooks](./hooks.md)).
- `navigation/v1`, provided by the core in the client, to register the route `/projects/:projectId/threads/:threadId` (see [navigation and routes](./navigation.md)).
- `history` is an optional optimization, not a requirement (see [storage](./storage.md)).

By the rule of `requires`, the client part of `chat` declares every contract it uses with `use`, the core's basic ones included; `doric.*` contracts and the optional ones used with `whenAvailable` stay out (see [manifest](./manifest.md)).

### Provides

- The `<chat-view>` element, defined with `ui.define('chat-view', ChatView)`. Whoever wants the conversation navigates to the Thread's path or creates the element with `ui.create('chat-view', { projectId, threadId })`, which hands the element the services of `chat` (see [`ui.create` step by step](./ui-composition.md#elements-are-the-boundary)).
- The route `/projects/:projectId/threads/:threadId`, with `parent: '/'`, registered in `navigation/v1`, which creates `<chat-view>` with the path's parameters. Switching Thread only assigns the new parameters to the same element (see [the outlet](./navigation.md#the-outlet-core-outlet)).
- Two client services:
  - `chat.views/v1` (`ChatViewsV1`), editor-independent;
  - `chat.lexical/v1`, specific to the default implementation.
- The client service `chat.send/v1`, in every window: `send({ projectId, threadId })` sends the composer's comment stack, with the draft text the host keeps, as a prompt through the same send path, and clears the draft after it is accepted. The prompt of every send uses the XML envelope `<comments>`/`<message>` ([comments](./comments.md#the-prompt-the-xml-envelope)), and `chat` reads the body of `<message>` where it shows a stored prompt. Its built-in projection claims `comments.added/v1` and `comments.resolved/v1` and folds them into threads with state ([comments](./comments.md#threads-states-and-the-agents-replies)).
- The hooks `chat.hooks/v2` (`ChatHooksV2`), defined and executed by the client part in the client's `hooks/v1`; other bundles register handlers on them, for example with `whenAvailable` (see [hooks](./hooks.md)). Since `chat` 2.0.0 (step 5(c) of [bundle isolation](../../designs/bundle-isolation-concept.md)) `chat` provides only `chat.hooks/v2`, which replaces `chat.hooks/v1`: `onSandboxActivityHook` fires when `chat` starts keeping a Thread, when the Thread's working directory changes or when its state changes to any state except `running`, and never after a finished tool. The bundle that owns a tool that writes in the sandbox observes `onThreadUpdateHook` and requests its own refresh, as `files` does for `edit` and `write` and `git` for `git`.

An alternative conversation replaces the `chat` bundle in the composition: it registers the same path with its own element and may provide `chat.views/v1` without Lexical. Two bundles that register the same path produce a route conflict, and the second is quarantined with a reason. `chat.views/v1` has cardinality `one`, the default of `defineService`; if two enabled bundles provide it, the composition chooses the provider in `providers`, and the choice applies in the client environment. Without a choice, the second provider is quarantined with a reason (see [composition and distribution](./composition-and-distribution.md)).

The two services only work in the client: they receive functions, classes or elements, described by `z.custom` in the schemas, and the dispatcher refuses a call that would cross processes (see [contracts](./contracts.md)). Each is a definition with `defineService` in which each method carries its `execute(input, call, services)`; the bundle provides them in the client activation with `services.provide(chatViews)` and `services.provide(chatLexical)`, and the loader disposes of them in reverse order on deactivation.

### Client activation of `chat`

In **pseudocode of the proposed API**, the client part of `chat` defines `<chat-view>`, provides the services and registers the route:

```ts
// chat, client/index.ts
import {
  HooksV1,
  NavigationV1,
  UiV1,
  type ClientContext,
} from 'bundle/contracts';
import { ChatHooksV2 } from '../contracts/index.js';
import { chatLexical } from './lexical.js'; // defineService('chat.lexical/v1', { ... })
import { chatViews } from './views.js'; // defineService('chat.views/v1', { ... })

export function activate({ services }: ClientContext) {
  // o dono define os próprios hooks e os executa antes de renderizar cada bloco
  const chatHooks = services.use(HooksV1).define(ChatHooksV2);
  renderer.beforeRender = (block, call) =>
    chatHooks.onBeforeRenderBlockHook.execute(block, call);

  const ui = services.use(UiV1);
  ui.define('chat-view', ChatView); // ChatView envia prompts e lê Threads por RuntimeThreadsV1 e despacha comandos por CommandsV1

  services.provide(chatViews);
  services.provide(chatLexical);

  services.use(NavigationV1).register({
    path: '/projects/:projectId/threads/:threadId',
    parent: '/',
    create: (params) => ui.create('chat-view', params), // params: { projectId, threadId }
  });
}

// chat, contracts/index.ts: referências para os consumidores
import { ref } from 'bundle/contracts';
import type { chatLexical } from '../client/lexical.js';
import type { chatViews } from '../client/views.js';
export const ChatViewsV1 = ref<typeof chatViews>('chat.views/v1');
export const ChatLexicalV1 = ref<typeof chatLexical>('chat.lexical/v1');
export { ChatHooksV2 } from './hooks.js'; // chat, contracts/hooks.ts (ver hooks)
```

`chat/contracts` exports these references, with `ref` from `bundle/contracts`, and the definitions without logic, such as `ChatHooksV2`; the `import type` disappears in the build. Whoever extends the conversation uses `services.whenAvailable(ChatViewsV1, ...)`.

Inside `<chat-view>`, sending a prompt uses the remote stub in the window's scope, for example `await services.use(RuntimeThreadsV1, { projectId }).sendPrompt({ threadId, text }, { signal })`; the dispatcher fills `call.caller` with `chat` and `call.scope.windowKey` with the window of origin.

The manifest, in the [manifest v1](./manifest.md) format, lists in `provides` the contracts that `chat` defines and in `requires` the ones this code uses with `use`. `hooks/v1`, `ui/v1` and `navigation/v1` come in through their use in the activation; `runtime.threads/v1`, through sending prompts inside `<chat-view>`; and `commands/v1`, through the dispatch of commands that `<chat-view>` does from DOM intents; `history` stays out because it is optional. The client part is found by convention at `client/index.js`:

```json
{
  "manifestVersion": 1,
  "id": "chat",
  "version": "1.0.0",
  "engines": { "doric": "^1.0.0" },
  "provides": [
    "chat.views/v1@1.0.0",
    "chat.lexical/v1@1.0.0",
    "chat.hooks/v2@2.0.0"
  ],
  "requires": [
    "hooks/v1@^1.0.0",
    "ui/v1@^1.0.0",
    "navigation/v1@^1.0.0",
    "commands/v1@^1.0.0",
    "runtime.threads/v1@^1.0.0"
  ]
}
```

## Projectors and renderers: `chat.views/v1`

The `chat.views/v1` service registers **stream projectors** and **block renderers** separately.

- **Projector.** Consumes ordered events of declared types and versions and reduces deltas, tool starts and ends, and groupings into blocks with stable IDs and their own type and version.
- **Renderer.** Associates that block type with a Web Component tag and with metadata for editing, selection, trail and actions. The tag is defined by the bundle that registers the renderer, through `ui/v1`, and starts with that bundle's ID.

Rules:

- The same reduction is applied on replay. Rewind recomposes from the surviving log, without executing effects.
- Primary-owner conflicts for a type/version are rejected.
- An event without a known projector produces a generic block with type, ID, time and the payload, without discarding the record (see [events and nodes](./events-and-nodes.md)).

### Who registers what

The schemas and the append of the **durable events** are registered by the host part of the bundle that produces them, in the host's event catalog, with `defineEvent` and `services.use(EventsV1).register(...)`. The `chat` bundle only offers the client interpretation and presentation of those events.

Thus a `git` bundle can register `git.branch-switched/v1` in the host and, in the client, use `chat.views/v1` as an optional dependency, through `services.whenAvailable(ChatViewsV1, ...)`, to project it into a `git.branch-change/v1` block rendered by `<git-branch-event>`. Git remains functional in a UI without a conversation, and there is no reverse dependency from `chat` to `git`.

## The Lexical service: `chat.lexical/v1`

- The service accepts extensions and node classes only during the client activation, **before** the editor is created. The generation's node list is then frozen.
- Common event cards use a single stable `DecoratorNode` that keeps the ID of the projected block and hosts the bundle's tag. This avoids creating a Lexical class for each card.
- Specific Lexical nodes are kept for real editing semantics.
- The platform provides the singleton of `lexical` and `@lexical/*` through the import map, externalized from the client artifacts, and `engines.doric` guarantees the compatible version before classes are accepted (see [shared packages](./platform-packages.md) and [manifest](./manifest.md)).
- Changing the list requires rebuilding the editor, preserving draft, focus and selection when possible.
- A UI that does not use Lexical consumes `chat.views/v1` and ignores this optional service.
- The durable log remains the source of the conversation's data, not a serialized Lexical state.

The two node families are in [events and nodes](./events-and-nodes.md).

## Example: the Git branch switch in the conversation

The complete flow:

1. The `git` bundle registers the schema of `git.branch-switched/v1` in the host part.
2. The client command `switchBranchCommand` calls `switchBranch` of `git.commands/v1` in the host through the client→host bridge; the `execute` of `switchBranch` writes the event, passing on the `call` it received.
3. The stream delivers it to the conversation.
4. The projector produces a block that `<git-branch-event>` presents.
5. A click on that element emits a DOM intent.
6. The conversation dispatches the command `git.open-comparison/v1` to open the comparison.

Replay goes through the same projector without repeating the branch change.

Steps 1 and 2, in the host part of `git`, in **pseudocode of the proposed API**:

```ts
// git, contracts/events.ts (exportado por git/contracts)
import { defineEvent } from 'bundle/contracts';
import { z } from 'zod';

export const branchSwitchedEvent = defineEvent({
  type: 'git.branch-switched/v1',
  payload: z
    .object({
      projectId: z.string(),
      repository: z.string(),
      from: z.string(),
      to: z.string(),
    })
    .strict(),
});

// git, host/git-commands.ts
import { defineMethod, defineService, EventsV1 } from 'bundle/contracts';
import { z } from 'zod';
import { branchSwitchedEvent } from '../contracts/index.js';

export const gitCommands = defineService('git.commands/v1', {
  switchBranch: defineMethod({
    input: z.object({ projectId: z.string(), to: z.string() }).strict(),
    output: z.object({ from: z.string(), to: z.string() }).strict(),
    // `call.caller` é quem chamou o git; o dispatcher o preenche
    execute: async (input, call, services) => {
      const repository = await resolveRepository(input.projectId, call.signal);
      const result = await checkoutBranch(repository, input.to, call.signal);
      // o novo salto herda scope, signal e trace; o caller visto por events/v1 é `git`
      await services.use(EventsV1).append(
        branchSwitchedEvent,
        {
          projectId: input.projectId,
          repository,
          from: result.from,
          to: result.to,
        },
        call,
      );
      return result;
    },
  }),
});

// git, host/index.ts
import { EventsV1, type HostContext } from 'bundle/contracts';
import { branchSwitchedEvent } from '../contracts/index.js';
import { gitCommands } from './git-commands.js';

export function activate({ services }: HostContext) {
  services.use(EventsV1).register(branchSwitchedEvent); // na ativação; descartado pelo loader na desativação
  services.provide(gitCommands);
}
```

The manifest of `git` declares `events/v1` in `requires`, because the host part uses `EventsV1` with `use` (the complete manifest is further below). The payload of `git.branch-switched/v1` is `.strict()` and requires `repository`, which comes neither in the input (`{ projectId, to }`) nor in the output (`{ from, to }`) of `switchBranch`; that is why the `execute` resolves the Project's repository before writing. The full version of the event comes from `provides` in the manifest. `EventsV1` is a basic reference exported by `bundle/contracts`, and the core provides the definition with `execute`; `services` in the `execute` are the services of `git`, bound in `services.provide(gitCommands)`. `git` imports its own contracts by relative path.

In the client, `git` defines the block's tag, registers the commands and registers the projector and the renderer through `chat.views/v1`, as an optional dependency:

```ts
// git, client/index.ts
import { CommandsV1, UiV1, type ClientContext } from 'bundle/contracts';
import { ChatViewsV1 } from 'chat/contracts';
import { openComparisonCommand, switchBranchCommand } from './commands.js';

export function activate({ services }: ClientContext) {
  services.use(UiV1).define('git-branch-event', GitBranchEvent);

  const commands = services.use(CommandsV1);
  commands.register(switchBranchCommand); // chama o stub de GitCommandsV1.switchBranch
  commands.register(openComparisonCommand); // git.open-comparison/v1

  services.whenAvailable(ChatViewsV1, (views) => {
    views.registerProjector(branchSwitchedProjector); // git.branch-switched/v1 → bloco git.branch-change/v1
    views.registerRenderer({
      blockType: 'git.branch-change/v1',
      elementTag: 'git-branch-event',
    });
  });
}
```

The complete manifest of `git`, in the [manifest v1](./manifest.md) format, covers the host and client parts of this example and those of the examples of [hooks](./hooks.md) and of the [main document](../bundles.md):

```json
{
  "manifestVersion": 1,
  "id": "git",
  "version": "1.5.0",
  "engines": { "doric": "^1.0.0" },
  "provides": [
    "git.commands/v1@1.3.0",
    "git.hooks/v1@1.0.0",
    "git.settings/v1@1.0.0",
    "git.branch-switched/v1@1.0.0"
  ],
  "requires": [
    "hooks/v1@^1.0.0",
    "events/v1@^1.0.0",
    "settings/v1@^1.0.0",
    "tools/v1@^1.0.0",
    "commands/v1@^1.0.0",
    "ui/v1@^1.0.0",
    "navigation/v1@^1.0.0",
    "regions/v1@^1.0.0",
    "windows/v1@^1.0.0",
    "menus/v1@^1.0.0",
    "git.commands/v1@^1.0.0",
    "runtime.lease/v1@^1.0.0",
    "runtime.workspace/v1@^1.0.0",
    "runtime.hooks/v1@^1.0.0"
  ],
  "optional": ["chat.hooks/v2"]
}
```

The manifest above is illustrative. That of `git` 1.2.13 (`bundles/features/git/manifest.json`) carries the same two lines for the hook of `chat`: `hooks/v1@^1.0.0` in `requires`, because the observer uses `services.use(HooksV1).whenAvailable`, and `chat.hooks/v2` in `optional`, because `chat` may be missing from the composition.

> **Out of date.** The `layout.panel` region of the paragraph below has been called
> `shell.panel` since step 4(a) of bundle isolation. The current behavior
> is in
> [docs/designs/bundle-isolation-concept.md](../../designs/bundle-isolation-concept.md#current-behavior-and-contracts);
> the documentation phase of that work (phase 12) rewrites this document.

In the client, `ui/v1` and `commands/v1` come in through the code above; `navigation/v1`, because the client part registers the routes `/git/diff/:threadId/:repository` and `/settings/git` with `services.use(NavigationV1)` (see [navigation and routes](./navigation.md)); `regions/v1`, through the `<git-changes>` item it puts in the `layout.panel` region of the [layout](./layout.md) and through the link `{ id: 'git', tag: 'settings-link', props: { label: 'Git', path: '/settings/git' } }` in the `settings.sections` region; `windows/v1`, because `openComparisonCommand` opens the comparison with `services.use(WindowsV1)` (see [opening a path in a window](./navigation.md#opening-a-path-in-a-window)); `menus/v1`, through the menu item the client part requests; and `hooks/v1`, also used by the client part to consume `chat.hooks/v2` with `whenAvailable`. `git.commands/v1` goes into `requires` although `git` itself provides it in the host, because `switchBranchCommand` uses the stub with `use` in the client, as in the [main document](../bundles.md). `chat.views/v1` and `chat.hooks/v2` stay out because they are used with `whenAvailable`. `commands/v1` exists in `desktopMain` and in the client, not in the host, so the commands are in the client part.

A click on `<git-branch-event>` emits a DOM intent, and the conversation dispatches the command `git.open-comparison/v1`, defined by `git` with `defineCommand` and registered in `commands/v1`, to open the comparison. The action is a command, not a service.

## Relations

- [Hooks](./hooks.md): defines `chat.hooks/v2`, executed by `chat`, and its optional consumption by `git`.
- [Contracts and the define\* family](./contracts.md): defines `defineService`, `defineMethod`, `ref`, `defineEvent` and the schemas with `z.custom` used by `chat` and by whoever extends it.
- [Activation contexts](./contexts.md): defines `ClientContext` and `HostContext` with only `services`, the `call` received by the handlers, its propagation across hops and the cleanup function returned by `activate`.
- [Manifest](./manifest.md): defines `requires` and `provides` per environment, as in the example manifests.
- [The core](./core.md): provides `hooks/v1`, `ui/v1`, `navigation/v1`, `regions/v1`, `commands/v1`, `windows/v1`, `menus/v1` and `events/v1`, used by `chat` and by whoever extends it; `bundle/contracts` exports the references and the types of these contracts, and the core provides the definitions with `execute`.
- [Navigation and routes](./navigation.md): the `navigation/v1` service in which `chat` registers `/projects/:projectId/threads/:threadId` and the `<core-outlet>` that shows it.
- [The layout bundle](./layout.md): the workspace of the route `/`, in whose outlet the conversation appears.
- [Services between bundles and message channels](./services-and-channels.md): describes the client→host bridge, through which `chat` consumes `runtime.threads/v1` and the durable stream.
- [Events and nodes](./events-and-nodes.md): defines the durable events, the generic event block without a projector and the two node families.
- [UI composed by bundles](./ui-composition.md): explains the DOM intents and the Light DOM of the first extraction of the conversation.
- [React inside Web Components](./react-web-components.md): how `<chat-view>` mounts React inside the element and reacts to the properties that the outlet assigns.
- [Shared packages and theme tokens](./platform-packages.md): provides `lexical` and `@lexical/*` through the import map.
- [Generic storage and history](./storage.md): defines the durable history and the optional `history`.
- [Split of the current features](./feature-split.md): places `chat`, `runtime`, `threads` and `git` among the target bundles.
- [Semantic versioning](./versioning.md): governs the majors of `chat.views/v1`, `chat.lexical/v1` and of the block types.
