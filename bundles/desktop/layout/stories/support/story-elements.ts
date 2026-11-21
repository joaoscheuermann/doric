// Stand-ins for the shell's own elements the layout writes into its tree:
// `<core-region name>` (the items bundles add to a region) and `<core-outlet>`
// (the child route, drawn as the conversation's placeholder: the routes and
// their elements are other bundles' since bundle isolation 4(c)).
// They are defined only where the shell has not defined them, and read the
// story's fake host while connected.

import { type Disposable, RegionsV1, type Ui, UiV1 } from 'bundle/contracts';

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
 * - `<core-outlet>` draws the conversation as a labelled placeholder.
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
        connectedCallback(): void {
          this.style.display = 'contents';
          this.replaceChildren(
            placeholderElement('chat-thread', undefined, 'Conversation'),
          );
        }
      },
  );
};
