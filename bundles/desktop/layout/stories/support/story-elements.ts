// Stand-ins for the shell's own elements the layout writes into its tree:
// `<core-region name>` (the items bundles add to a region) and `<core-outlet>`
// (the child route: the Thread's conversation, or the Project's empty state).
// They are defined only where the shell has not defined them, and read the
// story's fake host while connected.

import {
  type Disposable,
  NavigationV1,
  RegionsV1,
  type Ui,
  UiV1,
} from 'bundle/contracts';

import {
  describedThread,
  PROJECT_ROUTE,
} from '../../src/client/domain/route-selection.js';
import { workspaceStore } from '../../src/client/stores/workspace.js';
import type { FakeHost } from './fake-host.js';
import { placeholderElement } from './placeholder.js';

let current: FakeHost | undefined;

/** Regions whose items place themselves; their stand-in draws nothing. */
const silentRegions = new Set(['shell.conversation.overlay']);

const defineOnce = (
  tag: string,
  create: () => CustomElementConstructor,
): void => {
  if (customElements.get(tag) === undefined)
    customElements.define(tag, create());
};

/**
 * Points the stand-ins at `host` and defines them on first use. Each one is
 * defined only where nothing has defined its tag yet.
 * - `<core-region name>` creates each item through the host's `ui/v1`, as the
 *   shell's region does: an element the layout defined is the real one, any
 *   other tag a labelled placeholder. It follows the region's changes.
 * - `<core-outlet>` draws the selected Thread's conversation as a
 *   placeholder, and on `/projects/:projectId` the route's element,
 *   `layout-project-empty`, through the host's `ui/v1`.
 */
export const defineStoryElements = (host: FakeHost): void => {
  current = host;

  defineOnce(
    'core-region',
    () =>
      class StoryRegion extends HTMLElement {
        #stop: Disposable | undefined;
        #ui: Ui | undefined;
        readonly #created = new Map<string, Node>();

        connectedCallback(): void {
          this.style.display = 'contents';
          // Moved within the document: it keeps its items, as the shell's does.
          if (this.#stop !== undefined) return;
          const name = this.getAttribute('name') ?? '';
          if (silentRegions.has(name) || current === undefined) {
            this.replaceChildren();
            return;
          }
          const { services } = current;
          const ui = services.use(UiV1);
          this.#ui = ui;
          const draw = () => {
            const items = services.use(RegionsV1).items(name);
            const wanted = new Set(items.map((item) => item.id));
            for (const [id, element] of [...this.#created]) {
              if (wanted.has(id)) continue;
              this.#created.delete(id);
              ui.dispose(element);
            }
            // Moves only what is out of place, as the shell's region does, so
            // an item keeps its focus while the region changes.
            items.forEach((item, index) => {
              let element = this.#created.get(item.id);
              if (element === undefined) {
                element = ui.create(item.tag, item.props) as Node;
                this.#created.set(item.id, element);
              }
              const at = this.childNodes[index] ?? null;
              if (at !== element) this.insertBefore(element, at);
            });
          };
          this.replaceChildren();
          draw();
          this.#stop = services.use(RegionsV1).subscribe(name, draw);
        }

        disconnectedCallback(): void {
          queueMicrotask(() => {
            if (this.isConnected) return;
            this.#stop?.dispose();
            this.#stop = undefined;
            for (const element of this.#created.values())
              this.#ui?.dispose(element);
            this.#created.clear();
          });
        }
      },
  );

  defineOnce(
    'core-outlet',
    () =>
      class StoryOutlet extends HTMLElement {
        #stops: (() => void)[] = [];

        connectedCallback(): void {
          this.style.display = 'contents';
          const services = current?.services;
          if (services === undefined) return;
          const navigation = services.use(NavigationV1);
          let empty:
            | { readonly projectId: string; readonly node: Node }
            | undefined;
          const draw = () => {
            const match = navigation.current();
            const projectId = match?.params.projectId;
            if (match?.pattern === PROJECT_ROUTE && projectId !== undefined) {
              if (empty?.projectId !== projectId) {
                empty = {
                  projectId,
                  node: services
                    .use(UiV1)
                    .create('layout-project-empty', match.params) as Node,
                };
              }
              if (this.firstChild !== empty.node)
                this.replaceChildren(empty.node);
              return;
            }
            const { tree } = workspaceStore.getState();
            const threadId = tree.selection.threadId;
            const thread =
              threadId === undefined
                ? undefined
                : describedThread(tree, threadId);
            this.replaceChildren(
              placeholderElement(
                'chat-thread',
                thread === undefined ? undefined : { threadId: thread.id },
                thread === undefined
                  ? 'Conversation'
                  : `Conversation: ${thread.name || 'Untitled'}`,
              ),
            );
          };
          draw();
          const route = navigation.subscribe(draw);
          this.#stops = [workspaceStore.subscribe(draw), () => route.dispose()];
        }

        disconnectedCallback(): void {
          for (const stop of this.#stops) stop();
          this.#stops = [];
        }
      },
  );
};
