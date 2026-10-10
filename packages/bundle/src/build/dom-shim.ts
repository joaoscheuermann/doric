// The DOM-capable recorder's globals (stage 9, §3.2): the minimum a client
// part needs to be imported and dry-activated in Node. A client module may
// touch the DOM at import time only through `class … extends HTMLElement`;
// anything heavier (Monaco, xterm) is loaded with a dynamic `import()` inside
// a component, so it never runs here.

/** A shim element: enough for constructors, property sets and appends. */
class ShimNode {
  readonly childNodes: ShimNode[] = [];
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly #attributes = new Map<string, string>();
  textContent = '';

  get isConnected(): boolean {
    return false;
  }

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.#attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.#attributes.has(name);
  }

  appendChild<T extends ShimNode>(node: T): T {
    this.childNodes.push(node);

    return node;
  }

  append(...nodes: unknown[]): void {
    for (const node of nodes) {
      if (node instanceof ShimNode) {
        this.childNodes.push(node);
      }
    }
  }

  replaceChildren(...nodes: unknown[]): void {
    this.childNodes.length = 0;
    this.append(...nodes);
  }

  addEventListener(): void {}

  removeEventListener(): void {}

  dispatchEvent(): boolean {
    return true;
  }
}

class ShimHTMLElement extends ShimNode {
  tagName = 'DIV';

  get localName(): string {
    return this.tagName.toLowerCase();
  }
}

class ShimObserver {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}

  takeRecords(): unknown[] {
    return [];
  }
}

const shimStorage = () => {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
  };
};

const shimDocument = () => {
  const head = new ShimHTMLElement();
  const body = new ShimHTMLElement();
  const documentElement = new ShimHTMLElement();

  head.tagName = 'HEAD';
  body.tagName = 'BODY';
  documentElement.tagName = 'HTML';

  return {
    head,
    body,
    documentElement,
    createElement: (tag: string) => {
      const element = new ShimHTMLElement();

      element.tagName = tag.toUpperCase();

      return element;
    },
    createTextNode: (text: string) => {
      const node = new ShimNode();

      node.textContent = text;

      return node;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
};

const shimGlobals = (): Record<string, unknown> => ({
  HTMLElement: ShimHTMLElement,
  customElements: {
    define: () => undefined,
    get: () => undefined,
    whenDefined: () => Promise.resolve(),
  },
  document: shimDocument(),
  ResizeObserver: ShimObserver,
  MutationObserver: ShimObserver,
  IntersectionObserver: ShimObserver,
  matchMedia: (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }),
  localStorage: shimStorage(),
  sessionStorage: shimStorage(),
  requestAnimationFrame: (callback: (time: number) => void) =>
    setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) =>
    clearTimeout(handle),
});

/**
 * Installs the shim globals that are missing (`window` and `self` are
 * `globalThis`) and returns the function that removes them again. Globals
 * Node already has are left as they are.
 */
export const installDomShim = (): (() => void) => {
  const target = globalThis as unknown as Record<string, unknown>;
  const added: string[] = [];
  const define = (name: string, value: unknown) => {
    if (name in target) {
      return;
    }

    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: false,
      writable: true,
      value,
    });
    added.push(name);
  };

  for (const [name, value] of Object.entries(shimGlobals())) {
    define(name, value);
  }

  define('window', globalThis);
  define('self', globalThis);

  // Node's navigator has no clipboard.
  const navigator = target.navigator as Record<string, unknown> | undefined;
  let addedClipboard = false;

  if (navigator !== undefined && !('clipboard' in navigator)) {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: () => Promise.resolve(''),
        writeText: () => Promise.resolve(),
      },
    });
    addedClipboard = true;
  }

  return () => {
    for (const name of added) {
      delete target[name];
    }

    if (addedClipboard && navigator !== undefined) {
      delete navigator.clipboard;
    }
  };
};
