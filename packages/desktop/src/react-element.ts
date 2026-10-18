import type { Services } from 'bundle/contracts';
import {
  type ComponentType,
  createElement,
  type ReactNode,
  useSyncExternalStore,
} from 'react';
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

    get services(): Services {
      return this.#services as Services;
    }

    set services(services: Services) {
      this.#services = services;
      this.#render();
    }

    connectedCallback(): void {
      // Set on connect, not in the constructor: an element made by
      // `document.createElement` must not have attributes when its
      // constructor returns, and `style` is one.
      this.style.display = options.display ?? 'contents';
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

/** One connected portal host and the props set on it. */
export interface PortalHost<P extends object> {
  readonly element: HTMLElement;
  readonly props: Readonly<Partial<P>>;
}

export interface PortalHosts<P extends object> {
  /** The host element: `display: contents`, no React root of its own. */
  readonly Element: new () => HTMLElement;
  /**
   * The connected hosts in connection order, for `createPortal` by the root
   * that owns them; re-renders when a host connects, disconnects or a listed
   * property changes.
   */
  useHosts(): readonly PortalHost<P>[];
}

/**
 * Host elements whose content another React root renders through portals
 * (stage 9, D9-12): a bundle's region items share its root instead of each
 * owning one, so ordering and state stay in that root.
 */
export const portalHosts = <P extends object>(
  properties: readonly (keyof P & string)[],
): PortalHosts<P> => {
  const connected: PortalHostElement[] = [];
  const listeners = new Set<() => void>();
  let snapshot: readonly PortalHost<P>[] = Object.freeze([]);

  const changed = (): void => {
    snapshot = Object.freeze(
      connected.map((element) => Object.freeze(element.host())),
    );

    for (const listener of [...listeners]) {
      listener();
    }
  };

  class PortalHostElement extends HTMLElement {
    services: Services | undefined;
    readonly #values = new Map<string, unknown>();

    static {
      for (const name of properties) {
        Object.defineProperty(PortalHostElement.prototype, name, {
          configurable: true,
          enumerable: true,
          get(this: PortalHostElement) {
            return this.#values.get(name);
          },
          set(this: PortalHostElement, value: unknown) {
            this.#values.set(name, value);

            if (connected.includes(this)) {
              changed();
            }
          },
        });
      }
    }

    host(): PortalHost<P> {
      return {
        element: this,
        props: Object.freeze(
          Object.fromEntries(
            properties.map((name) => [name, this.#values.get(name)]),
          ),
        ) as Readonly<Partial<P>>,
      };
    }

    connectedCallback(): void {
      // On connect: a constructor must leave the element without attributes.
      this.style.display = 'contents';
      if (!connected.includes(this)) {
        connected.push(this);
        changed();
      }
    }

    disconnectedCallback(): void {
      const index = connected.indexOf(this);

      if (index >= 0) {
        connected.splice(index, 1);
        changed();
      }
    }
  }

  const subscribe = (listener: () => void) => {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  };
  const read = () => snapshot;

  return {
    Element: PortalHostElement,
    useHosts: () => useSyncExternalStore(subscribe, read, read),
  };
};
