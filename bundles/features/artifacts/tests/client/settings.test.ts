// The Review section as the settings window mounts it: the two choices the
// policy offers, the stored one checked, a write through `artifacts/v1` when
// the reader picks another, and the reading put back when the registry refuses.
// And the section's own registration: one link in `settings.sections` and one
// child route of `/settings`, the same surfaces the git bundle's Versioning
// section occupies.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type { Services } from 'bundle/contracts';
import { Window } from 'happy-dom';

const window = new Window();
const installed = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'CustomEvent',
  'customElements',
] as const;

const inert = (): { dispose: () => void } => ({ dispose: () => undefined });

let defineReviewElement: typeof import('../../src/client/settings/review.js')['defineReviewElement'];
let ArtifactsV1: typeof import('../../src/contracts/index.js')['ArtifactsV1'];
let activate: typeof import('../../src/client/index.js')['activate'];
let ARTIFACTS_REVIEW_PATH: typeof import('../../src/client/index.js')['ARTIFACTS_REVIEW_PATH'];
let ARTIFACTS_REVIEW_TAG: typeof import('../../src/client/index.js')['ARTIFACTS_REVIEW_TAG'];
let artifactsRegions: typeof import('../../src/client/index.js')['artifactsRegions'];
let UiV1: typeof import('bundle/contracts')['UiV1'];
let RegionsV1: typeof import('bundle/contracts')['RegionsV1'];
let NavigationV1: typeof import('bundle/contracts')['NavigationV1'];

before(async () => {
  for (const name of installed) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: window[name as keyof Window],
      writable: true,
    });
  }

  ({ defineReviewElement } = await import(
    '../../src/client/settings/review.js'
  ));
  ({ ArtifactsV1 } = await import('../../src/contracts/index.js'));
  ({ activate, ARTIFACTS_REVIEW_PATH, ARTIFACTS_REVIEW_TAG, artifactsRegions } =
    await import('../../src/client/index.js'));
  ({ UiV1, RegionsV1, NavigationV1 } = await import('bundle/contracts'));
});

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/** A services stub that answers by contract id, as the frame tests do. */
const servicesFor = (apiOf: (id: string) => unknown): Services =>
  ({
    provide: () => ({ dispose: () => undefined }),
    use: (contract: unknown) => apiOf((contract as { id?: string }).id ?? ''),
    whenAvailable: () => ({ dispose: () => undefined }),
  }) as unknown as Services;

let tag = 0;

const mount = (factory: () => unknown): Record<string, unknown> & Element => {
  const name = `artifacts-element-${tag++}`;

  window.customElements.define(name, factory() as never);

  return window.document.createElement(name) as unknown as Record<
    string,
    unknown
  > &
    Element;
};

/** One radio of the section's group, by the policy it carries. */
const radioOf = (
  element: Record<string, unknown> & Element,
  policy: string,
): HTMLInputElement =>
  [
    ...(
      (element as unknown as HTMLElement).shadowRoot as ShadowRoot
    ).querySelectorAll('input'),
  ].find((input) => input.value === policy) as HTMLInputElement;

/** The section's error line, as the reader sees it. */
const errorOf = (element: Record<string, unknown> & Element): HTMLElement =>
  ((element as unknown as HTMLElement).shadowRoot as ShadowRoot).querySelector(
    '.artifacts-review-error',
  ) as HTMLElement;

/** A `change` of the section's window, as the browser hands it over. */
const change = (): Event =>
  new window.Event('change', { bubbles: true }) as unknown as Event;

test('checks the policy the registry answers and offers both choices', async () => {
  const section = mount(defineReviewElement);
  const services = servicesFor((id) =>
    id === ArtifactsV1.id
      ? { policy: async () => ({ policy: 'request' as const }) }
      : undefined,
  );

  section.services = services;
  await tick();
  await tick();

  assert.equal(radioOf(section, 'proceed').checked, false);
  assert.equal(radioOf(section, 'request').checked, true);
  assert.equal(errorOf(section).hidden, true);
});

test('writes the choice through artifacts/v1 when the reader picks another', async () => {
  const section = mount(defineReviewElement);
  const written: { readonly policy: 'proceed' | 'request' }[] = [];
  const services = servicesFor((id) =>
    id === ArtifactsV1.id
      ? {
          policy: async () => ({ policy: 'request' as const }),
          setPolicy: async (input: {
            readonly policy: 'proceed' | 'request';
          }) => {
            written.push(input);

            return input;
          },
        }
      : undefined,
  );

  section.services = services;
  await tick();
  await tick();

  const proceed = radioOf(section, 'proceed');
  proceed.checked = true;
  proceed.dispatchEvent(change());
  await tick();
  await tick();

  assert.deepEqual(written, [{ policy: 'proceed' }]);
  assert.equal(radioOf(section, 'proceed').checked, true);
  assert.equal(radioOf(section, 'request').checked, false);
  assert.equal(errorOf(section).hidden, true);
});

test('puts the reading back and says it when the registry refuses a write', async () => {
  const section = mount(defineReviewElement);
  const services = servicesFor((id) =>
    id === ArtifactsV1.id
      ? {
          policy: async () => ({ policy: 'request' as const }),
          setPolicy: async () => {
            throw new Error('the registry refused');
          },
        }
      : undefined,
  );

  section.services = services;
  await tick();
  await tick();

  const proceed = radioOf(section, 'proceed');
  proceed.checked = true;
  proceed.dispatchEvent(change());
  await tick();
  await tick();

  assert.equal(radioOf(section, 'proceed').checked, false);
  assert.equal(radioOf(section, 'request').checked, true);
  assert.equal(errorOf(section).hidden, false);
  assert.match(
    errorOf(section).textContent ?? '',
    /mantém a política anterior/,
  );
});

test('says it and checks nothing when the stored policy cannot be read', async () => {
  const section = mount(defineReviewElement);
  const services = servicesFor((id) =>
    id === ArtifactsV1.id
      ? {
          policy: async () => {
            throw new Error('unreachable');
          },
        }
      : undefined,
  );

  section.services = services;
  await tick();
  await tick();

  assert.equal(radioOf(section, 'proceed').checked, false);
  assert.equal(radioOf(section, 'request').checked, false);
  assert.equal(errorOf(section).hidden, false);
  assert.match(errorOf(section).textContent ?? '', /não pôde ser lida/);
});

test('the region item is one settings link whose path names the route', () => {
  const [entry] = artifactsRegions;

  assert.equal(entry?.region, 'settings.sections');
  assert.deepEqual(
    { ...entry?.item },
    {
      id: 'review',
      tag: 'settings-link',
      order: 60,
      props: {
        label: 'Review',
        path: ARTIFACTS_REVIEW_PATH,
        icon: 'zap',
        description:
          'Como o Project revisa os artefatos do agente: seguir direto ou esperar a autorização.',
      },
    },
  );
});

test('activation registers the section element, the link and the route', async () => {
  const defined: string[] = [];
  const created: string[] = [];
  const added: { region: string; item: unknown }[] = [];
  const routes: { path: string; parent?: string; create?: () => unknown }[] =
    [];

  const services = servicesFor((id) => {
    if (id === UiV1.id) {
      return {
        define: (tag: string) => {
          defined.push(tag);

          return inert();
        },
        create: (tag: string) => {
          created.push(tag);

          return window.document.createElement(tag);
        },
      };
    }

    if (id === RegionsV1.id) {
      return {
        add: (region: string, item: unknown) => {
          added.push({ region, item });

          return inert();
        },
      };
    }

    if (id === NavigationV1.id) {
      return {
        register: (route: {
          path: string;
          parent?: string;
          create?: () => unknown;
        }) => {
          routes.push(route);

          return inert();
        },
      };
    }

    return undefined;
  });

  const cleanup = activate({
    services,
  } as unknown as Parameters<typeof activate>[0]);

  try {
    assert.ok(defined.includes(ARTIFACTS_REVIEW_TAG));
    assert.deepEqual(
      added.map(({ region }) => region),
      ['settings.sections'],
    );
    assert.equal(added[0]?.item, artifactsRegions[0]?.item);

    const route = routes.find(({ path }) => path === ARTIFACTS_REVIEW_PATH);

    assert.equal(route?.parent, '/settings');

    // The route's element is the one the tag names, so the link, the route
    // and the element all answer for one section.
    assert.ok(route?.create !== undefined);
    created.length = 0;
    route?.create?.();
    assert.deepEqual(created, [ARTIFACTS_REVIEW_TAG]);
  } finally {
    cleanup();
  }
});
