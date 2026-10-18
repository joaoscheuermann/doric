// Stand-ins for the shell's own elements the layout writes into its tree:
// `<core-region name>` (the items other bundles add to a region) and
// `<core-outlet>` (the child route, the Thread's conversation). They are
// defined only where the shell has not defined them, read the story's fake
// host when they connect, and draw one labelled placeholder per item.

import { describedThread } from '../../src/client/domain/route-selection.js';
import { workspaceStore } from '../../src/client/stores/workspace.js';
import type { FakeHost } from './fake-host.js';
import { placeholderElement } from './placeholder.js';

let current: FakeHost | undefined;

/** Regions whose items place themselves; their stand-in draws nothing. */
const silentRegions = new Set(['layout.overlay']);

const defineOnce = (
  tag: string,
  create: () => CustomElementConstructor,
): void => {
  if (customElements.get(tag) === undefined)
    customElements.define(tag, create());
};

/** Points the stand-ins at `host` and defines them on first use. */
export const defineStoryElements = (host: FakeHost): void => {
  current = host;

  defineOnce(
    'core-region',
    () =>
      class StoryRegion extends HTMLElement {
        connectedCallback(): void {
          this.style.display = 'contents';
          const name = this.getAttribute('name') ?? '';
          if (silentRegions.has(name)) {
            this.replaceChildren();
            return;
          }
          const items = current?.regionItems(name) ?? [];
          this.replaceChildren(
            ...items.map((item) => placeholderElement(item.tag, item.props)),
          );
        }
      },
  );

  defineOnce(
    'core-outlet',
    () =>
      class StoryOutlet extends HTMLElement {
        #stop: (() => void) | undefined;

        connectedCallback(): void {
          this.style.display = 'contents';
          const draw = () => {
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
          this.#stop = workspaceStore.subscribe(draw);
        }

        disconnectedCallback(): void {
          this.#stop?.();
          this.#stop = undefined;
        }
      },
  );
};
