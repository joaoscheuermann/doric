// <core-region name>: the items of a regions/v1 region, in order. Each item
// is created once with ui/v1 and disposed when it leaves the region.

import {
  type Disposable,
  type RegionEntry,
  RegionsV1,
  UiV1,
} from 'bundle/contracts';

import { coreServices } from '../core-services.js';
import { afterDisconnect, showContents } from './lifecycle.js';

interface Created {
  readonly entry: RegionEntry;
  readonly element: Node;
}

export class CoreRegion extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['name'];
  }

  #name: string | undefined;
  #subscribed:
    | { readonly name: string; readonly subscription: Disposable }
    | undefined;
  readonly #created = new Map<string, Created>();

  get name(): string {
    return this.#name ?? this.getAttribute('name') ?? '';
  }

  set name(value: string) {
    this.#name = String(value);
    this.#sync();
  }

  attributeChangedCallback(): void {
    if (this.#name === undefined) {
      this.#sync();
    }
  }

  connectedCallback(): void {
    showContents(this);
    this.#sync();
  }

  disconnectedCallback(): void {
    afterDisconnect(this, () => {
      this.#unsubscribe();
      this.#disposeAll();
    });
  }

  #unsubscribe(): void {
    this.#subscribed?.subscription.dispose();
    this.#subscribed = undefined;
  }

  #disposeAll(): void {
    const ui = coreServices().use(UiV1);

    for (const created of this.#created.values()) {
      ui.dispose(created.element);
    }

    this.#created.clear();
  }

  #sync(): void {
    if (!this.isConnected) {
      return;
    }

    const name = this.name;

    if (this.#subscribed?.name !== name) {
      this.#unsubscribe();
      this.#disposeAll();

      if (name === '') {
        return;
      }

      this.#subscribed = {
        name,
        subscription: coreServices()
          .use(RegionsV1)
          .subscribe(name, () => this.#render()),
      };
    }

    this.#render();
  }

  #render(): void {
    if (!this.isConnected || this.#subscribed === undefined) {
      return;
    }

    const services = coreServices();
    const ui = services.use(UiV1);
    const entries = services.use(RegionsV1).items(this.#subscribed.name);
    const wanted = new Set(entries);

    for (const [id, created] of [...this.#created]) {
      if (!wanted.has(created.entry)) {
        this.#created.delete(id);
        ui.dispose(created.element);
      }
    }

    entries.forEach((entry, index) => {
      let created = this.#created.get(entry.id);

      if (created === undefined) {
        created = {
          entry,
          element: ui.create(entry.tag, entry.props ?? {}) as Node,
        };
        this.#created.set(entry.id, created);
      }

      const at = this.childNodes[index] ?? null;

      if (at !== created.element) {
        this.insertBefore(created.element, at);
      }
    });
  }
}
