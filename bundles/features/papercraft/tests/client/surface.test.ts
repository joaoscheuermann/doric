// `PreviewSurface`, mounted: what lands in the shadow root for a revision.
//
// Contract matrix:
// - a revision whose entries name no module mounts its markup, imports
//   nothing and reports `markup` (no fallback notice);
// - a component preview keeps its origin stamp on the element the mounted
//   DOM actually holds, so a click on it anchors to the component's file;
// - a named module that fails to load is replaced by the markup (`fallback`);
// - a module that resolves after its revision was replaced is never mounted,
//   and a mounted module is unmounted once when the surface goes;
// - path B's route serves only what the cache verified: a named module (and
//   its sheet) is requested only once the revision's entries are cached; a
//   revision that cannot be cached shows the markup (`fallback`); a revision
//   without a module asks the cache for nothing;
// - `ensureRevisionCached` hands the cache the bytes `artifacts/v1.read`
//   serves, scoped like every host call, and rejects when the module cannot
//   reach the cache (bytes gone, refused by the hash check, no scope).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { Window } from 'happy-dom';
import { createElement } from 'react';

const window = new Window();

for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'CustomEvent',
  'customElements',
  'DOMParser',
] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: window[name as keyof Window],
    writable: true,
  });
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type React = typeof import('react');
type ReactDomClient = typeof import('react-dom/client');
type Surface = typeof import('../../src/client/surface/preview-surface.js');
type Previews = typeof import('../../src/host/previews.js');
type Anchor = typeof import('../../src/client/anchor.js');
type Data = typeof import('../../src/client/surface/preview-data.js');

let react: React;
let reactDomClient: ReactDomClient;
let surface: Surface;
let previews: Previews;
let anchor: Anchor;
let data: Data;

before(async () => {
  [react, reactDomClient, surface, previews, anchor, data] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('../../src/client/surface/preview-surface.js'),
    import('../../src/host/previews.js'),
    import('../../src/client/anchor.js'),
    import('../../src/client/surface/preview-data.js'),
  ]);
});

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

const MARKUP =
  '<!DOCTYPE html><html><head><style>p{}</style></head><body><p id="hi">oi</p></body></html>';

const mount = () => {
  const frame = document.createElement('div');
  document.body.append(frame);
  const root = reactDomClient.createRoot(frame);
  const modes: string[] = [];

  const render = async (props: Record<string, unknown>) => {
    await react.act(async () => {
      root.render(
        createElement(surface.PreviewSurface, {
          artifactId: 'checkout-7f3a',
          revision: 1,
          markup: MARKUP,
          onMode: (mode: string) => modes.push(mode),
          ...props,
        } as never),
      );
    });
  };

  const shadow = (): ShadowRoot => {
    const host = frame.querySelector('.papercraft-surface-host') as HTMLElement;
    assert.ok(host.shadowRoot !== null);

    return host.shadowRoot;
  };

  return {
    render,
    shadow,
    modes,
    unmount: () => react.act(async () => root.unmount()),
  };
};

const flush = () => react.act(async () => {});

test('a revision without a module mounts its markup and imports nothing', async () => {
  const m = mount();
  const loads: string[] = [];

  await m.render({
    entries: ['index.html'],
    load: async (url: string) => {
      loads.push(url);
      throw new Error('not served');
    },
  });
  await flush();

  assert.deepEqual(loads, []);
  assert.ok(m.shadow().querySelector('body #hi') !== null);
  assert.deepEqual(m.modes, ['markup']);

  await m.unmount();
});

test('the shadow root starts from initial styles, before the artifact own sheet', async () => {
  const m = mount();

  await m.render({ entries: ['index.html'] });
  await flush();

  // Inherited properties cross the shadow boundary: the reset comes first so
  // the conversation's text colour never reaches the artifact, and the
  // artifact's own rules, later in the tree, still win.
  const sheets = [...m.shadow().querySelectorAll('style')].map(
    (style) => style.textContent,
  );
  assert.equal(sheets[0], surface.SURFACE_RESET);
  assert.match(sheets[0] ?? '', /:host \{ all: initial;/);
  assert.equal(sheets[1], 'p{}');

  await m.unmount();
});

test('a tool that owns the pointer locks the cursor over the artifact', async () => {
  const m = mount();
  const host = () =>
    (m.shadow().host as HTMLElement).getAttribute('data-cursor');

  await m.render({ entries: ['index.html'] });
  await flush();
  assert.equal(host(), null);

  // The artifact's own `cursor: pointer` or text I-beam would otherwise win
  // over the comment balloon the moment the pointer is over an element.
  await m.render({ entries: ['index.html'], lockCursor: true });
  await flush();
  assert.equal(host(), 'locked');
  assert.match(
    surface.SURFACE_RESET,
    /:host\(\[data-cursor="locked"\]\) \* \{ cursor: inherit !important; \}/,
  );

  await m.unmount();
});

test('a component preview keeps its origin stamp on the mounted element', async () => {
  const m = mount();
  const markup = previews.deriveMarkup(
    'component',
    'src/Checkout.tsx',
    'export const Checkout = () => <button />;',
  );

  await m.render({ markup, entries: ['index.html'] });
  await flush();

  const stamped = m
    .shadow()
    .querySelector('[data-papercraft-source="src/Checkout.tsx:1"]');
  assert.ok(stamped !== null, 'the mounted DOM lost the component stamp');

  const clicked = anchor.anchorOf(stamped);
  assert.equal(clicked.form, 'source');
  assert.equal(clicked.path, 'src/Checkout.tsx');
  assert.equal(clicked.line, 1);

  await m.unmount();
});

test('a named module that does not load falls back to the markup', async () => {
  const m = mount();

  await m.render({
    entries: ['index.html', 'index.js'],
    load: async () => {
      throw new Error('not served');
    },
  });
  await flush();

  assert.ok(m.shadow().querySelector('body #hi') !== null);
  assert.deepEqual(m.modes, ['fallback']);

  await m.unmount();
});

test('a stale module is never mounted, and a live one unmounts once', async () => {
  const m = mount();
  const mounted: number[] = [];
  const unmounted: number[] = [];
  let resolveFirst: (module: unknown) => void = () => undefined;

  const moduleOf = (revision: number) => ({
    mount: (root: HTMLElement) => {
      mounted.push(revision);
      root.textContent = `rev ${String(revision)}`;

      return () => unmounted.push(revision);
    },
  });

  // Revision 1's module is still loading when revision 2 replaces it.
  await m.render({
    revision: 1,
    entries: ['index.js'],
    load: (url: string) =>
      url.includes('@1/')
        ? new Promise((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve(moduleOf(2)),
  });
  await m.render({
    revision: 2,
    entries: ['index.js'],
    load: (url: string) =>
      Promise.resolve(moduleOf(url.includes('@2/') ? 2 : 1)),
  });
  await flush();

  resolveFirst(moduleOf(1));
  await flush();

  assert.deepEqual(mounted, [2]);
  assert.match(m.shadow().textContent ?? '', /rev 2/);

  await m.unmount();
  assert.deepEqual(unmounted, [2]);
});

test('a named module is imported only once its revision is cached', async () => {
  const m = mount();
  const loads: string[] = [];
  let cached: () => void = () => undefined;

  await m.render({
    entries: ['index.html', 'index.js', 'index.css'],
    ensure: () =>
      new Promise<void>((resolve) => {
        cached = resolve;
      }),
    load: async (url: string) => {
      loads.push(url);

      return {
        mount: (root: HTMLElement) => {
          root.textContent = 'live';
        },
      };
    },
  });
  await flush();

  // Nothing is requested from the route before the cache holds it.
  assert.deepEqual(loads, []);
  assert.equal(m.shadow().querySelector('link'), null);

  cached();
  await flush();

  assert.deepEqual(loads, [surface.artifactModuleUrl('checkout-7f3a', 1)]);
  assert.equal(
    m.shadow().querySelector('link')?.getAttribute('href'),
    surface.artifactStylesUrl('checkout-7f3a', 1),
  );
  assert.match(m.shadow().textContent ?? '', /live/);
  assert.deepEqual(m.modes, ['module']);

  await m.unmount();
});

test('a revision that cannot be cached falls back to the markup', async () => {
  const m = mount();
  const loads: string[] = [];

  await m.render({
    entries: ['index.html', 'index.js'],
    ensure: async () => {
      throw new Error('hash_mismatch');
    },
    load: async (url: string) => {
      loads.push(url);

      return { mount: () => undefined };
    },
  });
  await flush();

  assert.deepEqual(loads, []);
  assert.ok(m.shadow().querySelector('body #hi') !== null);
  assert.deepEqual(m.modes, ['fallback']);

  await m.unmount();
});

test('a revision without a module asks the cache for nothing', async () => {
  const m = mount();
  const ensured: unknown[] = [];

  await m.render({
    entries: ['index.html'],
    ensure: async (artifactId: string, revision: number) => {
      ensured.push([artifactId, revision]);
    },
  });
  await flush();

  assert.deepEqual(ensured, []);
  assert.deepEqual(m.modes, ['markup']);

  await m.unmount();
});

/* ensureRevisionCached ------------------------------------------------------ */

const MODULE_BYTES = Buffer.from('export const mount = () => {};').toString(
  'base64',
);

interface CacheHarness {
  readonly services: import('bundle/contracts').Services;
  readonly ensured: { input: unknown; scope: unknown }[];
}

const cacheHarness = (options: {
  readonly entries: readonly { path: string; base64?: string }[];
  readonly refused?: readonly string[];
}): CacheHarness => {
  const ensured: { input: unknown; scope: unknown }[] = [];
  const services = {
    use: (contract: { id?: string }, scope?: unknown) => {
      switch (contract.id) {
        case 'artifacts/v1':
          return {
            read: async (input: { artifactId: string; revision: number }) => ({
              artifactId: input.artifactId,
              revision: input.revision,
              entries: options.entries.map((entry) => ({
                sha256: 'a'.repeat(64),
                ...entry,
              })),
            }),
          };
        case 'artifacts.cache/v1':
          return {
            ensure: async (input: { entries: readonly { path: string }[] }) => {
              ensured.push({ input, scope });
              const failed = input.entries
                .filter((entry) => options.refused?.includes(entry.path))
                .map((entry) => ({
                  path: entry.path,
                  reason: 'hash_mismatch',
                  message: 'mismatch',
                }));

              return {
                kept: 0,
                written: input.entries.length - failed.length,
                failed,
              };
            },
          };
        default:
          throw new Error(`unexpected contract ${String(contract.id)}`);
      }
    },
  } as unknown as import('bundle/contracts').Services;

  return { services, ensured };
};

const SCOPE = { projectId: 'p1', threadId: 't-123' };

test('caching a revision hands the cache the bytes the host serves', async () => {
  const h = cacheHarness({
    entries: [
      { path: 'index.html', base64: 'PHA+PC9wPg==' },
      { path: 'index.js', base64: MODULE_BYTES },
      { path: 'index.css' },
    ],
  });

  await data.ensureRevisionCached(h.services, SCOPE, 'checkout-7f3a', 2);

  assert.equal(h.ensured.length, 1);
  const [{ input, scope }] = h.ensured as [
    {
      input: {
        artifactId: string;
        revision: number;
        entries: { path: string; base64: string }[];
      };
      scope: { projectId: string; threadId: string };
    },
  ];
  assert.equal(input.artifactId, 'checkout-7f3a');
  assert.equal(input.revision, 2);
  // An entry whose bytes the work copy no longer holds is not sent.
  assert.deepEqual(input.entries.map((entry) => entry.path).sort(), [
    'index.html',
    'index.js',
  ]);
  assert.equal(
    input.entries.find((entry) => entry.path === 'index.js')?.base64,
    MODULE_BYTES,
  );
  assert.equal(scope.projectId, 'p1');
  assert.equal(scope.threadId, 't-123');
});

test('caching a revision fails when its module cannot reach the cache', async () => {
  const gone = cacheHarness({ entries: [{ path: 'index.js' }] });
  await assert.rejects(
    data.ensureRevisionCached(gone.services, SCOPE, 'checkout-7f3a', 1),
  );

  const refused = cacheHarness({
    entries: [{ path: 'index.js', base64: MODULE_BYTES }],
    refused: ['index.js'],
  });
  await assert.rejects(
    data.ensureRevisionCached(refused.services, SCOPE, 'checkout-7f3a', 1),
  );

  const unscoped = cacheHarness({
    entries: [{ path: 'index.js', base64: MODULE_BYTES }],
  });
  await assert.rejects(
    data.ensureRevisionCached(unscoped.services, undefined, 'checkout-7f3a', 1),
  );
  assert.deepEqual(unscoped.ensured, []);
});
