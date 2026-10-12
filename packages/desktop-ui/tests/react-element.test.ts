/**
 * `defineReactElement` turns a component into a custom element that owns a
 * React root in its light DOM: it renders with the services assigned to it,
 * re-renders on property changes, survives a move within the document, and
 * releases its root when it stays disconnected or is disposed — after which
 * connecting it again renders it again.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import type { Services } from 'bundle/contracts';
import type { ReactElementInstance, ReactElementOptions } from 'desktop-ui';
import { Window } from 'happy-dom';
import type { ReactNode } from 'react';

const window = new Window();
const globals = globalThis as unknown as Record<string, unknown>;
const installed = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLIFrameElement',
  'Node',
  'Element',
  'Event',
  'customElements',
  'MutationObserver',
] as const;

let defineReactElement: <P extends object>(
  options: ReactElementOptions<P>,
) => new () => ReactElementInstance;
let portalHosts: typeof import('desktop-ui/react-element').portalHosts;
let createPortal: typeof import('react-dom').createPortal;
let createRoot: typeof import('react-dom/client').createRoot;
let act: (callback: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import('react').createElement;
let useEffect: typeof import('react').useEffect;

before(async () => {
  for (const name of installed) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: (window as unknown as Record<string, unknown>)[name],
      writable: true,
    });
  }
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const react = await import('react');
  act = react.act as typeof act;
  createElement = react.createElement;
  useEffect = react.useEffect;
  ({ defineReactElement, portalHosts } = await import(
    'desktop-ui/react-element'
  ));
  ({ createPortal } = await import('react-dom'));
  ({ createRoot } = await import('react-dom/client'));
});

after(async () => {
  await window.happyDOM.close();
});

const services = (name: string): Services => ({ name }) as unknown as Services;

let tags = 0;

interface Greeting {
  readonly greeting?: string;
}

/**
 * A greeting element; it counts mounts and unmounts so a test can tell a kept
 * root from a new one.
 */
const greetingElement = (
  options: Partial<ReactElementOptions<Greeting>> = {},
) => {
  const life = { mounts: 0, unmounts: 0 };
  const Greeting = ({
    greeting,
    services: owner,
  }: Greeting & { readonly services: Services }) => {
    useEffect(() => {
      life.mounts += 1;
      return () => {
        life.unmounts += 1;
      };
    }, []);
    const name = (owner as unknown as { name: string }).name;
    return createElement('p', null, `${greeting ?? 'Hello'} from ${name}`);
  };
  tags += 1;
  const tag = `test-greeting-${tags}`;
  window.customElements.define(
    tag,
    defineReactElement<Greeting>({
      props: ['greeting'],
      render: Greeting,
      ...options,
    }) as never,
  );
  const create = () =>
    window.document.createElement(tag) as unknown as ReactElementInstance &
      Greeting & { greeting?: string };
  return { create, life };
};

const attach = (element: ReactElementInstance): void => {
  window.document.body.appendChild(element as never);
};

describe('defineReactElement', () => {
  test('renders with its services once connected', async () => {
    const { create } = greetingElement();
    const element = create();
    element.services = services('core');
    assert.equal(element.textContent, '');
    await act(() => attach(element));
    assert.equal(element.textContent, 'Hello from core');
    await act(() => element.dispose());
  });

  test('re-renders when a listed property or the services change', async () => {
    const { create, life } = greetingElement();
    const element = create();
    element.services = services('core');
    await act(() => attach(element));
    await act(() => {
      element.greeting = 'Hi';
    });
    assert.equal(element.greeting, 'Hi');
    assert.equal(element.textContent, 'Hi from core');
    await act(() => {
      element.services = services('git');
    });
    assert.equal(element.textContent, 'Hi from git');
    assert.equal(life.mounts, 1);
    await act(() => element.dispose());
  });

  test('a property set before connecting is rendered on connect', async () => {
    const { create } = greetingElement();
    const element = create();
    element.greeting = 'Welcome';
    element.services = services('core');
    await act(() => attach(element));
    assert.equal(element.textContent, 'Welcome from core');
    await act(() => element.dispose());
  });

  test('stays out of the layout unless told otherwise, once connected', async () => {
    const contents = greetingElement().create();
    const flex = greetingElement({ display: 'flex' }).create();
    // A browser refuses `document.createElement` for a custom element whose
    // constructor leaves an attribute (`style` included).
    assert.equal(contents.attributes.length, 0);
    assert.equal(flex.attributes.length, 0);
    contents.services = services('core');
    flex.services = services('core');
    await act(() => {
      attach(contents);
      attach(flex);
    });
    assert.equal(contents.style.display, 'contents');
    assert.equal(flex.style.display, 'flex');
  });

  test('a portal host is created without attributes and stays out of the layout', () => {
    const hosts = portalHosts<Record<string, never>>([]);
    tags += 1;
    const tag = `test-portal-${tags}`;
    window.customElements.define(tag, hosts.Element as never);
    const host = window.document.createElement(tag);
    assert.equal(host.attributes.length, 0);
    window.document.body.appendChild(host);
    assert.equal(host.style.display, 'contents');
  });

  test('moving it within the document keeps its root', async () => {
    const { create, life } = greetingElement();
    const element = create();
    element.services = services('core');
    await act(() => attach(element));
    const other = window.document.createElement('section');
    window.document.body.appendChild(other);
    await act(() => {
      other.appendChild(element as never);
    });
    assert.equal(element.textContent, 'Hello from core');
    assert.deepEqual(life, { mounts: 1, unmounts: 0 });
    await act(() => element.dispose());
  });

  test('staying disconnected releases its root', async () => {
    const { create, life } = greetingElement();
    const element = create();
    element.services = services('core');
    await act(() => attach(element));
    await act(async () => {
      element.remove();
      await Promise.resolve();
    });
    assert.deepEqual(life, { mounts: 1, unmounts: 1 });
    assert.equal(element.textContent, '');
  });

  test('dispose is idempotent', async () => {
    const { create, life } = greetingElement();
    const element = create();
    element.services = services('core');
    await act(() => attach(element));
    await act(() => {
      element.dispose();
      element.dispose();
    });
    assert.deepEqual(life, { mounts: 1, unmounts: 1 });
    assert.equal(element.textContent, '');
    element.remove();
  });

  test('connecting again after dispose renders again', async () => {
    const { create, life } = greetingElement();
    const element = create();
    element.services = services('core');
    await act(() => attach(element));
    await act(async () => {
      element.remove();
      await Promise.resolve();
    });
    await act(() => attach(element));
    assert.equal(element.textContent, 'Hello from core');
    assert.deepEqual(life, { mounts: 2, unmounts: 1 });
    await act(() => element.dispose());
  });

  test('the wrapper is built once, with the services, around the component', async () => {
    const built: Services[] = [];
    const { create } = greetingElement({
      wrap: (owner) => {
        built.push(owner);
        return ({ children }: { readonly children?: ReactNode }) =>
          createElement('section', { 'data-wrapped': '' }, children);
      },
    });
    const element = create();
    const owner = services('core');
    element.services = owner;
    await act(() => attach(element));
    await act(() => {
      element.greeting = 'Hi';
    });
    assert.deepEqual(built, [owner]);
    assert.equal(
      element.querySelector('[data-wrapped] > p')?.textContent,
      'Hi from core',
    );
    await act(() => element.dispose());
  });
});

describe('portalHosts', () => {
  interface Item {
    readonly label?: string;
  }

  test('the owner root renders each connected host through a portal, following props and disconnects', async () => {
    const hosts = portalHosts<Item>(['label']);
    tags += 1;
    const tag = `test-portal-${tags}`;
    window.customElements.define(tag, hosts.Element as never);

    const Owner = () =>
      createElement(
        'div',
        null,
        hosts
          .useHosts()
          .map(({ element, props }, index) =>
            createPortal(
              createElement('span', null, props.label ?? '?'),
              element,
              String(index),
            ),
          ),
      );
    const container = window.document.createElement('main');
    window.document.body.appendChild(container);
    const root = createRoot(container as never);
    await act(() => root.render(createElement(Owner)));

    const first = window.document.createElement(tag) as unknown as HTMLElement &
      Item & { label?: string };
    const second = window.document.createElement(
      tag,
    ) as unknown as HTMLElement & Item & { label?: string };
    first.label = 'cwd';
    await act(() => {
      window.document.body.appendChild(first as never);
      window.document.body.appendChild(second as never);
    });
    assert.equal(first.textContent, 'cwd');
    assert.equal(second.textContent, '?');
    assert.equal(first.children.length, 1);

    await act(() => {
      second.label = 'usage';
    });
    assert.equal(second.textContent, 'usage');

    await act(() => {
      first.remove();
    });
    assert.equal(first.textContent, '');
    assert.equal(second.textContent, 'usage');

    await act(() => root.unmount());
    second.remove();
    container.remove();
  });
});
