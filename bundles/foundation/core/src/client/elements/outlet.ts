// <core-outlet>: renders the route of its depth in the active chain of
// navigation/v1. The depth is the number of <core-outlet> ancestors, across
// shadow roots. The same pattern keeps its element and gets the new params;
// another pattern disposes it and creates the new route's element.

import {
  type Disposable,
  NavigationV1,
  type RouteEntry,
  type RouteRegistration,
  UiV1,
} from 'bundle/contracts';

import { coreServices } from '../core-services.js';
import { afterDisconnect, showContents } from './lifecycle.js';

export const OUTLET_TAG = 'core-outlet';
export const NOT_FOUND_TAG = 'core-not-found';

interface Shown {
  readonly route: RouteRegistration | undefined;
  readonly pattern: string | undefined;
  readonly element: object;
}

const depthOf = (element: Node): number => {
  let depth = 0;
  let node: Node | null = element.parentNode;

  while (node !== null) {
    if (node instanceof ShadowRoot) {
      node = node.host;
      continue;
    }

    if (node instanceof Element && node.localName === OUTLET_TAG) {
      depth += 1;
    }

    node = node.parentNode;
  }

  return depth;
};

export class CoreOutlet extends HTMLElement {
  #subscription: Disposable | undefined;
  #shown: Shown | undefined;

  connectedCallback(): void {
    showContents(this);

    if (this.#subscription === undefined) {
      const navigation = coreServices().use(NavigationV1);

      this.#subscription = navigation.subscribe(() => this.#render());
    }

    this.#render();
  }

  disconnectedCallback(): void {
    afterDisconnect(this, () => {
      this.#subscription?.dispose();
      this.#subscription = undefined;
      this.#clear();
    });
  }

  #clear(): void {
    const shown = this.#shown;

    this.#shown = undefined;

    if (shown !== undefined) {
      coreServices().use(UiV1).dispose(shown.element);
    }
  }

  #show(shown: Shown): void {
    this.#clear();
    this.#shown = shown;
    this.append(shown.element as Node);
  }

  #render(): void {
    if (!this.isConnected) {
      return;
    }

    const services = coreServices();
    const chain = services.use(NavigationV1).chain();
    const depth = depthOf(this);
    const entry: RouteEntry | undefined = chain[depth];

    if (entry === undefined) {
      if (depth === 0 && chain.length === 0) {
        const path = window.location.pathname;

        if (this.#shown !== undefined && this.#shown.route === undefined) {
          Object.assign(this.#shown.element, { path });

          return;
        }

        this.#show({
          route: undefined,
          pattern: undefined,
          element: services.use(UiV1).create(NOT_FOUND_TAG, { path }),
        });

        return;
      }

      this.#clear();

      return;
    }

    if (
      this.#shown !== undefined &&
      this.#shown.route === entry.route &&
      this.#shown.pattern === entry.match.pattern
    ) {
      Object.assign(this.#shown.element, entry.match.params);

      return;
    }

    this.#clear();

    let element: object;

    try {
      element = entry.route.create(entry.match);
    } catch (error) {
      console.error(
        `Doric: the route "${entry.match.pattern}" could not create its element:`,
        error,
      );

      return;
    }

    this.#show({
      route: entry.route,
      pattern: entry.match.pattern,
      element,
    });
  }
}
