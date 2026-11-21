# React inside Web Components

- Status: living document. It describes React-backed custom elements as implemented on 2026-11-20.

## Summary

A bundle's client part may write its UI in React and publish it as a custom element, which is the boundary between bundles. The element class comes from `defineReactElement` in the platform package `desktop/ui/react-element`: it renders a React component in the element's light DOM with the services of the bundle that owns the element and the properties set on it ([`react-element.ts`](../../../packages/desktop/src/react-element.ts)). The bundle registers the class under a tag that starts with its own id through `ui/v1.define`, as `chat` registers `<chat-view>` and `layout` registers `<layout-workspace>` ([`chat/src/client/index.ts`](../../../bundles/desktop/chat/src/client/index.ts), [`layout/src/client/index.ts`](../../../bundles/desktop/layout/src/client/index.ts)).

No bundle imports another bundle's element class ([Bundle boundaries](boundaries.md#imports), [`boundaries.mjs`](../../../tests/support/boundaries.mjs)). A consumer, including another element written in React, creates the element by its tag with `ui/v1.create` and releases it with `ui/v1.dispose`. The core's `<core-outlet>` and `<core-region>` are such consumers: they create and dispose the elements of routes and region items ([`outlet.ts`](../../../bundles/foundation/core/src/client/elements/outlet.ts), [`region.ts`](../../../bundles/foundation/core/src/client/elements/region.ts)).

## Defining an element: `defineReactElement`

`defineReactElement(options)` returns a custom element class ([`react-element.ts`](../../../packages/desktop/src/react-element.ts)):

| Option    | What it is                                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `render`  | The React component the element renders; it receives the listed properties and `services`                                                    |
| `props`   | The property names the class defines on the element; setting one stores the value and renders again                                          |
| `wrap`    | Optional. Called once per element with the element's `services`; returns a component that wraps the content, such as a query client provider |
| `display` | Optional. The element's own `display`, set when it connects; `contents` by default, which keeps the element out of the layout                |

An instance has a `services` property and a `dispose()` method. Its lifecycle:

- Setting `services` or a listed property renders the content again. Nothing renders until the element is connected and has `services`.
- `connectedCallback` sets the element's `display` and renders. The style is set on connect, not in the constructor, because an element made by `document.createElement` may not carry attributes when its constructor returns.
- `disconnectedCallback` waits one microtask and disposes the element if it is still disconnected, so moving the element within the document keeps its content and React state.
- `dispose()` unmounts the content at once, with `flushSync`, so anything the content placed outside the element, such as a popup in `document.body`, goes before the owner tears down what surrounds it. It is idempotent, and a later connect mounts the content again.

Every element of one class renders through a portal of one React root that the class shares. Elements that one commit of the page connects together therefore render and commit together, as one tree would. Each element's content sits under an error boundary: a content that throws leaves its own element empty and leaves the other elements of the class drawn.

The chat's route element is defined this way; the element's listed properties are the `:projectId` and `:threadId` segments of its route ([`chat-elements.tsx`](../../../bundles/desktop/chat/src/client/elements/chat-elements.tsx), [`chat/src/client/index.ts`](../../../bundles/desktop/chat/src/client/index.ts)):

```tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { defineReactElement } from 'desktop/ui/react-element';
import { TooltipProvider } from 'desktop/ui/tooltip';
import { type ReactNode, StrictMode } from 'react';

function ChatRoot({ children }: { readonly children?: ReactNode }) {
  return (
    <StrictMode>
      <QueryClientProvider client={chatQueryClient}>
        <TooltipProvider>{children}</TooltipProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}

export const ChatViewElement = defineReactElement<ChatViewProps>({
  props: ['projectId', 'threadId'],
  render: ChatView,
  wrap: () => ChatRoot,
});

// In the client part's `activate({ services })`:
const ui = services.use(UiV1);
ui.define('chat-view', ChatViewElement);
services.use(NavigationV1).register({
  path: '/projects/:projectId/threads/:threadId',
  parent: '/',
  create: (match) => ui.create('chat-view', match.params),
});
```

The chat's other elements, the contracts it provides and its route are in the [README of `chat`](../../../bundles/desktop/chat/README.md#elements-route-slot-items).

## Creating and disposing an element: `ui/v1`

A bundle that calls `ui/v1` lists it under `requires` in its manifest (`"ui/v1@^1.0.0"`), and one that registers a route lists `navigation/v1` too; otherwise `services.use` throws `undeclared_requirement`; the bundle the composition names as its core is exempt ([`services.ts`](../../../packages/bundle/src/runtime/services.ts), [The manifest line of every use](contexts.md#the-manifest-line-of-every-use), [`chat/manifest.json`](../../../bundles/desktop/chat/manifest.json)).

`ui/v1` is a basic contract that the `core` bundle provides in each window; its full contract is in the [README of `core`](../../../bundles/foundation/core/README.md#uiv1). What a React-backed element relies on ([`core/src/client/ui.ts`](../../../bundles/foundation/core/src/client/ui.ts)):

1. `ui.define(tag, Class)` refuses a tag that does not start with the calling bundle's id followed by `-`, with `invalid_input`, and records the calling bundle as the tag's owner through the platform contract `doric.elements/v1`; it returns a `Disposable`. A tag already defined in the window fails with `registration_conflict`; a definition that is disposed leaves the tag taken and without an owner, because a custom element cannot be undefined ([`elements.ts`](../../../packages/desktop/src/client/elements.ts)).
2. `ui.create(tag, props?)` answers a `<core-unavailable>` whose `data-tag` names the tag when no active bundle owns it. Otherwise it creates the element, attaches it, which assigns the element's `services`, and then assigns `props`. It returns the element unconnected, so the setters run before `connectedCallback` and the first render already has its services and properties.
3. `ui.dispose(element)` acts once per element: it calls the element's `remove()` and `dispose()`, then releases the element's scope.

The shape of `doric.elements/v1` (`define`, `owner`, `attach`, `release`), which only the window's active provider of `ui/v1` may call, is in [Contexts and capabilities](contexts.md#shapes-of-the-platform-contracts).

The outlet creates a route's element through the route's `create` and connects it. When the route stays the same and only its parameters change, the outlet assigns the new parameters to the same element, which renders again with them; another route disposes the element through `ui.dispose` ([`outlet.ts`](../../../bundles/foundation/core/src/client/elements/outlet.ts), [Navigation](navigation.md#the-outlet-core-outlet)). A region creates each item's element once with `ui.create(entry.tag, entry.props)` and disposes it when the item leaves ([`region.ts`](../../../bundles/foundation/core/src/client/elements/region.ts)).

## The element's services and the activation's services

The `services` that `ui.create` assigns belong to a child scope of the owning bundle's activation scope: every `provide`, call and `whenAvailable` made through them is bound to that element and ends when `ui.dispose` releases it ([`elements.ts`](../../../packages/desktop/src/client/elements.ts), [Contexts and capabilities](contexts.md#lifetimes)). Those calls run in the owning bundle's principal, so they are the owner's calls whoever created the element ([`services.ts`](../../../packages/bundle/src/runtime/services.ts)).

Work that must outlive one element runs on the services the client part received in `activate`. `chat` keeps them in a module, and its Thread watches, history writes and notifications run on them, never on an element's services ([`chat-services.ts`](../../../bundles/desktop/chat/src/client/services/chat-services.ts)). `layout` binds its frame and its contracts to its activation services in the same way ([`layout/src/client/index.ts`](../../../bundles/desktop/layout/src/client/index.ts)).

## One React for every bundle, and the bundle's own state

A client part leaves external `react`, `react-dom`, `@base-ui/react`, `desktop/ui` and `zod` with their subpaths, `lexical`, `@lexical/*`, `bundle/contracts`, and every specifier that ends in `/contracts`, and the window resolves them through its import map, so one instance of React and of `desktop/ui/react-element` serves every bundle of the window ([`externals.ts`](../../../packages/bundle/src/build/externals.ts), [`build.mjs`](../../../app/desktop/doric-platform/build.mjs)). The map's `<id>/contracts` entries name the contracts module of each bundle of the window's generation ([`import-map.ts`](../../../app/desktop/doric/src/platform/protocol/import-map.ts)). What a client part may import is in [Bundle boundaries](boundaries.md#what-a-client-part-may-import-and-slot-names).

`@tanstack/react-query` is not among those specifiers, so a bundle that uses it builds its own copy into its client part, and its query client is the bundle's own: `chat` wraps its elements in a provider of `chatQueryClient` ([`externals.ts`](../../../packages/bundle/src/build/externals.ts), [`chat-elements.tsx`](../../../bundles/desktop/chat/src/client/elements/chat-elements.tsx)).

React context does not cross from one element to another: each element's content is its own portal at the top of its class's root, so a provider in one element reaches neither an element of another class nor a nested element of the same class. A provider inside `<layout-workspace>` does not reach the `<chat-view>` that an outlet inside the frame shows ([`react-element.ts`](../../../packages/desktop/src/react-element.ts)). An element that needs a provider supplies it with `wrap`.

## Several elements in one root: `portalHosts`

When several elements of one bundle must share React state, the bundle defines the element that holds the state with `defineReactElement` and the others with `portalHosts(properties)` from the same module. `portalHosts(properties)` returns `{ Element, useHosts }`; the bundle registers `Element` with `ui.define`. A portal host has no root of its own: it is a `display: contents` element that records itself while connected, together with the listed properties set on it, and another element of the bundle renders into it with `createPortal` through `useHosts()`, which renders again when a host connects, disconnects or a listed property changes ([`react-element.ts`](../../../packages/desktop/src/react-element.ts)).

`settings` defines `<settings-page>` with `defineReactElement` and the section elements (`<settings-profile>`, `<settings-appearance>` and the others) and the `<settings-link>` items of its sections region as its portal hosts, so the navigation and the sections share one draft and one save ([`settings/src/client/elements.ts`](../../../bundles/desktop/settings/src/client/elements.ts), [`settings-view.tsx`](../../../bundles/desktop/settings/src/client/views/settings-view.tsx), [`settings/src/client/index.ts`](../../../bundles/desktop/settings/src/client/index.ts), [README of `settings`](../../../bundles/desktop/settings/README.md#the-settings-window)). In the same way, `<settings-dashboard-providers>` draws the dashboard's Providers group and renders the open provider's page into the portal host `<settings-dashboard-provider>`, so the group and the page share their own draft ([`dashboard-providers.tsx`](../../../bundles/desktop/settings/src/client/views/dashboard-providers.tsx), [README of `settings`](../../../bundles/desktop/settings/README.md#the-dashboards-providers)).

## A React component that shows another bundle's element

A component creates another bundle's element by its tag with `ui.create`, places it in an empty element that React leaves alone, sets later properties on it directly, and disposes it when it unmounts. The terminal's result block shows the chat's `<chat-readonly-markdown>` this way; it disposes the element in a microtask after the commit, so the element's content does not unmount while the terminal's root is still rendering. Shortened here; the original also logs a creation that throws and ignores a dispose that throws ([`terminal-result.tsx`](../../../bundles/features/terminal/src/client/chat/terminal-result.tsx)):

```tsx
function ReadonlyMarkdown({
  text,
  services,
}: {
  text: string;
  services: Services;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const element = useRef<{ text?: string } | null>(null);

  useEffect(() => {
    const host = frame.current;
    if (host === null) return;
    const ui = services.use(UiV1);
    const created = ui.create('chat-readonly-markdown', { text });
    element.current = created as { text?: string };
    host.replaceChildren(created as Node);
    return () => {
      element.current = null;
      host.replaceChildren();
      queueMicrotask(() => ui.dispose(created));
    };
  }, [services]);

  useEffect(() => {
    if (element.current !== null) element.current.text = text;
  }, [text]);

  return <div ref={frame} />;
}
```

When `chat` is not active in the window, `ui.create` answers a `<core-unavailable>` in place of the element ([`core/src/client/ui.ts`](../../../bundles/foundation/core/src/client/ui.ts)).

`ElementHost` from `desktop/ui/element-host` creates the element for any tag when it mounts, with the `props` it has then, and again when `tag` changes. A later change of `props` does not reach the element. It disposes the element in the effect's cleanup, at once and not in a microtask, and ignores a dispose that throws. When `ui.create` throws, it draws a compact notice that names the element in its place ([`element-host.tsx`](../../../packages/desktop/src/element-host.tsx)). `layout`, `workspace` and `account` draw other bundles' items with it, for example in the Project panel ([`project-panel.tsx`](../../../bundles/desktop/layout/src/client/components/organisms/project-panel.tsx)).

## Related documents

- [README of `core`](../../../bundles/foundation/core/README.md): the full contract of `ui/v1`, `navigation/v1`, `regions/v1` and the structural elements.
- [Contexts and capabilities](contexts.md): the element's child scope and the shape of `doric.elements/v1`.
- [Navigation](navigation.md): routes, the outlet and the properties it assigns.
- [UI composition](ui-composition.md): elements and regions as the boundary between bundles.
- [Layout](layout.md): `<layout-workspace>`, the frame where the outlet shows `<chat-view>`, and the contracts of its tabs ([The contracts](layout.md#the-contracts)). Every viewer tab's element stays mounted, hidden, while another tab is selected ([`workspace-tabs.tsx`](../../../bundles/desktop/layout/src/client/components/organisms/workspace-tabs.tsx), [README of `layout`](../../../bundles/desktop/layout/README.md#conversation-form)).
- [Bundle boundaries](boundaries.md): what a client part may import.
- [Contracts](contracts.md) and [Manifest](manifest.md): basic contracts, `requires` and `provides`.
