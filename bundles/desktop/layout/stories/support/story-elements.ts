// Stand-ins for the shell's own elements the layout writes into its tree:
// `<core-region name>` (the items other bundles add to a region) and
// `<core-outlet>` (the child route, the Thread's conversation). They are
// defined only where the shell has not defined them, read the story's fake
// host when they connect, and draw one labelled placeholder per item.
// `<files-toggle placement>` stands in for the files bundle's toggle (G6): it
// draws the one button its placement shows in the panel's state. Like the real
// element, it reads its services only from what the fake host's `ui/v1`
// `create` attached to it, so a toggle made any other way draws nothing.

import { describedThread } from '../../src/client/domain/route-selection.js';
import { workspaceStore } from '../../src/client/stores/workspace.js';
import { type LayoutPanel, LayoutPanelV1 } from '../../src/contracts/index.js';
import type { FakeHost } from './fake-host.js';
import { placeholderElement } from './placeholder.js';

let current: FakeHost | undefined;

/** The services the fake host's `ui/v1` `create` attached to each element. */
const attached = new WeakMap<Element, FakeHost['services']>();

/**
 * Gives `element` the services scope `ui/v1` `create` gives a bundle's
 * element (`DoricElementsV1.attach`). Only the fake host's `create` calls it.
 */
export const attachStoryServices = (
  element: Element,
  services: FakeHost['services'],
): void => {
  attached.set(element, services);
};

/** Regions whose items place themselves; their stand-in draws nothing. */
const silentRegions = new Set(['layout.overlay']);

const defineOnce = (
  tag: string,
  create: () => CustomElementConstructor,
): void => {
  if (customElements.get(tag) === undefined)
    customElements.define(tag, create());
};

/**
 * Points the stand-ins at `host` and defines them on first use: `<core-region>`,
 * `<core-outlet>` and `<files-toggle placement>` (G6). Each one is defined only
 * where nothing has defined its tag yet, so a real `files` bundle wins.
 */
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

  defineOnce(
    'files-toggle',
    () =>
      class StoryFilesToggle extends HTMLElement {
        #placement: string | undefined;
        #panel: LayoutPanel | undefined;
        #subscription: { dispose(): void } | undefined;

        /** Set by `ui/v1` `create`, which assigns the props as properties. */
        get placement(): string | undefined {
          return this.#placement;
        }

        set placement(value: string | undefined) {
          this.#placement = value;
          if (this.isConnected) this.#draw();
        }

        connectedCallback(): void {
          this.style.display = 'contents';
          try {
            const panel = attached.get(this)?.use(LayoutPanelV1);
            this.#panel = panel;
            this.#subscription = panel?.subscribe(() => this.#draw());
          } catch {
            this.#panel = undefined;
          }
          this.#draw();
        }

        disconnectedCallback(): void {
          this.#subscription?.dispose();
          this.#subscription = undefined;
          this.#panel = undefined;
        }

        #draw(): void {
          const panel = this.#panel;
          if (panel === undefined) {
            this.replaceChildren();
            return;
          }
          const open = panel.isOpen();
          const inPanel = this.#placement === 'panel';
          if (inPanel !== open) {
            this.replaceChildren();
            return;
          }
          const button = document.createElement('button');
          button.type = 'button';
          button.setAttribute('aria-label', open ? 'Hide files' : 'Show files');
          button.addEventListener('click', () => panel.toggle());
          this.replaceChildren(button);
        }
      },
  );
};
