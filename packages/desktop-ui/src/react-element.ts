import type { Services } from 'bundle/contracts';
import { type ComponentType, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

export interface ReactElementOptions<P extends object> {
  /** Renders inside the element's own root, with the owner's services. */
  readonly render: ComponentType<P & { readonly services: Services }>;
  /** Property names copied from the element to the component props. */
  readonly props: readonly (keyof P & string)[];
  /** Optional wrapper (a query client or state provider), built once per element. */
  readonly wrap?: (
    services: Services,
  ) => ComponentType<{ readonly children?: ReactNode }>;
  /** The element's own `display`; `contents` keeps it out of the layout. */
  readonly display?: string;
}

export interface ReactElementInstance extends HTMLElement {
  /** The services of the bundle that created the element. */
  services: Services;
  /** Unmounts the element's root. Idempotent; a later connect mounts again. */
  dispose(): void;
}

/**
 * A custom element class that renders a React component into its own root, in
 * the element's light DOM. Setting `services` or a listed property re-renders;
 * the root is created on connect and disposed when the element stays
 * disconnected past the current task, so moving it in the document keeps it.
 */
export const defineReactElement = <P extends object>(
  options: ReactElementOptions<P>,
): (new () => ReactElementInstance) => {
  class ReactElement extends HTMLElement implements ReactElementInstance {
    #services: Services | undefined;
    #root: Root | undefined;
    #wrapper: ComponentType<{ readonly children?: ReactNode }> | undefined;
    readonly #values = new Map<string, unknown>();

    static {
      // Each listed property stores its value on the element and re-renders.
      for (const name of options.props) {
        Object.defineProperty(ReactElement.prototype, name, {
          configurable: true,
          enumerable: true,
          get(this: ReactElement) {
            return this.#values.get(name);
          },
          set(this: ReactElement, value: unknown) {
            this.#values.set(name, value);
            this.#render();
          },
        });
      }
    }

    constructor() {
      super();
      this.style.display = options.display ?? 'contents';
    }

    get services(): Services {
      return this.#services as Services;
    }

    set services(services: Services) {
      this.#services = services;
      this.#render();
    }

    connectedCallback(): void {
      this.#render();
    }

    disconnectedCallback(): void {
      queueMicrotask(() => {
        if (!this.isConnected) this.dispose();
      });
    }

    dispose(): void {
      const root = this.#root;
      if (root === undefined) return;
      this.#root = undefined;
      root.unmount();
    }

    #render(): void {
      const services = this.#services;
      if (!this.isConnected || services === undefined) return;
      this.#root ??= createRoot(this);
      if (options.wrap !== undefined && this.#wrapper === undefined) {
        this.#wrapper = options.wrap(services);
      }
      const props = Object.fromEntries(
        options.props.map((name) => [name, this.#values.get(name)]),
      ) as P;
      const content = createElement(options.render, { ...props, services });
      this.#root.render(
        this.#wrapper === undefined
          ? content
          : createElement(this.#wrapper, null, content),
      );
    }
  }

  return ReactElement;
};
