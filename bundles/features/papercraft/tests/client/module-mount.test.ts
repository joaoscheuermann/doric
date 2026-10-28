// Path B's module contract, live: the `index.js` a component preview
// compiles to is imported as the preview frame imports it — bare specifiers
// resolved to the one React the page has — and mounted the way the frame's
// runtime mounts it: `mount(root, { theme })` on a `#root` in the body of a
// document the preview owns, with the theme on `<html>` (`class="dark"`).
// It renders the component, stamps its elements with their Project origin,
// contains a render error and unmounts.
//
// Contract matrix:
// - mount renders the component (hooks work: one React instance), every
//   element the Project's code wrote carries `path:line`, and the returned
//   function unmounts it;
// - the theme reaches decorators and stories as `globals.theme` and
//   `papercraft.theme`;
// - a component that throws renders an error in place of the preview instead
//   of escaping `mount`, and a render error React recovers from goes to the
//   console, never to the window;
// - the Project harness's decorators wrap a plain component, with the
//   preview's theme in `context.globals`;
// - a CSF story renders under its own, its meta's and the harness's
//   decorators (the harness outermost) with `args` merged harness < meta <
//   story;
// - `@storybook/addon-themes` puts the preview's theme on `<html>`;
// - an overlay of the Project's own `desktop/ui` (the workspace's real
//   `packages/desktop`, reached through the Project's `customConditions`)
//   renders in the document's body when the harness hands `desktop/ui`'s
//   provider `context.papercraft?.portalContainer`, as Doric's harnesses do;
// - mount states the story's Storybook layout on its root: the merged
//   `parameters.layout` when it is one of Storybook's, else `centered`;
// - a revision compiled before the frame (`tests/fixtures/old-revision`, the
//   bytes of a story that portals into `context.papercraft.portalContainer`)
//   still mounts in the frame's `#root`, its overlay in its own portal
//   container inside the root.

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Window } from 'happy-dom';

const window = new Window();

// The overlays of `desktop/ui` (Base UI's) also reach for these globals.
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLAnchorElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'SVGElement',
  'ShadowRoot',
  'DocumentFragment',
  'Element',
  'Node',
  'NodeFilter',
  'Event',
  'CustomEvent',
  'FocusEvent',
  'KeyboardEvent',
  'PointerEvent',
  'MouseEvent',
  'MutationObserver',
  'ResizeObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
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

type Previews = typeof import('../../src/host/previews.js');
type Services = typeof import('../support/services.js');

interface PreviewModule {
  mount(
    root: HTMLElement,
    context: { readonly theme: 'light' | 'dark' },
  ): undefined | (() => void);
}

let previews: Previews;
let support: Services;
let act: typeof import('react').act;
let compiled = 0;

// Written below the compiled tests, so `react` resolves from the workspace.
const scratch = join(
  dirname(fileURLToPath(import.meta.url)),
  `module-mount-${String(process.pid)}`,
);

before(async () => {
  [previews, support, { act }] = await Promise.all([
    import('../../src/host/previews.js'),
    import('../support/services.js'),
    import('react'),
  ]);
  await mkdir(scratch, { recursive: true });
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

/** The repository root, six levels above this compiled test. */
const workspace = fileURLToPath(new URL('../../../../../../', import.meta.url));

/**
 * The Project's `node_modules` is the workspace's own: `desktop` there is
 * the real `packages/desktop`, so a preview takes the Project's `desktop/ui`.
 */
const workspaceModule = async (path: string): Promise<string | undefined> => {
  if (!path.startsWith('node_modules/')) return undefined;

  try {
    return await readFile(join(workspace, path), 'utf8');
  } catch {
    return undefined;
  }
};

/** The tsconfig the Doric Project resolves its workspace packages by. */
const DORIC_TSCONFIG =
  '{ "compilerOptions": { "customConditions": ["@org/source"] } }';

const compile = async (
  files: Record<string, string>,
  path: string,
  entry?: string,
): Promise<PreviewModule> => {
  const services = support.servicesFor((id) => {
    if (id !== 'files/v1') throw new Error(`unexpected contract ${id}`);

    return {
      content: async (input: { readonly path: string }) => {
        const content =
          files[input.path] ?? (await workspaceModule(input.path));

        return content === undefined
          ? { status: 'ready', value: { status: 'not_found' } }
          : {
              status: 'ready',
              value: {
                status: 'read',
                path: input.path,
                content,
                truncated: false,
                binary: false,
              },
            };
      },
    };
  });
  const built = await previews.snapshotPreview(services, support.testCall, {
    source: 'component',
    path,
    ...(entry === undefined ? {} : { entry }),
  });
  const js = built.files.find((file) => file.path === 'index.js');
  assert.ok(js !== undefined);

  return load(path, Buffer.from(js.base64, 'base64'));
};

/** Imports a module's bytes from the scratch directory, where `react` resolves. */
const load = async (
  name: string,
  bytes: Uint8Array,
): Promise<PreviewModule> => {
  compiled += 1;
  const file = join(
    scratch,
    `${name.replaceAll('/', '_')}-${String(compiled)}.mjs`,
  );
  await writeFile(file, bytes);

  return (await import(pathToFileURL(file).href)) as PreviewModule;
};

const COUNTER = [
  "import { useState } from 'react';",
  '',
  'export default function Counter() {',
  '  const [count] = useState(2);',
  '  return (',
  '    <div className="p-4">',
  '      <span id="count">{count}</span>',
  '    </div>',
  '  );',
  '}',
].join('\n');

const mounted: (() => void)[] = [];

/**
 * Mounts a module as the frame's runtime does: the theme on `<html>`, then
 * `mount` on a `#root` in an otherwise empty body.
 */
const mountInFrame = async (
  module: PreviewModule,
  theme: 'light' | 'dark' = 'light',
): Promise<{ root: HTMLElement; unmount: undefined | (() => void) }> => {
  document.documentElement.className = theme === 'dark' ? 'dark' : '';
  const root = document.createElement('div');
  root.id = 'root';
  document.body.replaceChildren(root);
  let unmount: undefined | (() => void);

  await act(async () => {
    unmount = module.mount(root, { theme });
  });
  if (unmount !== undefined) mounted.push(unmount);

  return { root, unmount };
};

afterEach(async () => {
  await act(async () => {
    for (const unmount of mounted.splice(0)) unmount();
    await Promise.resolve();
  });
  document.body.replaceChildren();
  for (const name of [...document.documentElement.getAttributeNames()]) {
    document.documentElement.removeAttribute(name);
  }
});

test('mount renders the component with origin stamps, and unmounts', async () => {
  const module = await compile(
    { 'src/Counter.tsx': COUNTER },
    'src/Counter.tsx',
  );
  const { root, unmount } = await mountInFrame(module);

  const count = root.querySelector('#count');
  assert.equal(count?.textContent, '2');
  assert.equal(
    count?.getAttribute('data-papercraft-source'),
    'src/Counter.tsx:7',
  );
  assert.equal(
    root.querySelector('.p-4')?.getAttribute('data-papercraft-source'),
    'src/Counter.tsx:6',
  );

  assert.equal(typeof unmount, 'function');
  await act(async () => {
    unmount?.();
    await Promise.resolve();
  });
  assert.equal(root.querySelector('#count'), null);
});

test('the theme reaches the story as its globals and papercraft context', async () => {
  const module = await compile(
    {
      'src/Theme.stories.tsx': [
        'export default {};',
        'export const Shown = {',
        '  render: (_args, context) => (',
        '    <output id="theme">{context.globals.theme}/{context.papercraft.theme}</output>',
        '  ),',
        '};',
      ].join('\n'),
    },
    'src/Theme.stories.tsx',
  );

  const { root } = await mountInFrame(module, 'dark');

  assert.equal(root.querySelector('#theme')?.textContent, 'dark/dark');
});

test('a component that throws renders an error instead of escaping mount', async () => {
  const module = await compile(
    {
      'src/Boom.tsx':
        "export default function Boom(): never { throw new Error('boom-in-render'); }",
    },
    'src/Boom.tsx',
  );
  const quiet = console.error;
  console.error = () => undefined;
  let root: HTMLElement;

  try {
    ({ root } = await mountInFrame(module));
  } finally {
    console.error = quiet;
  }

  assert.match(
    root.querySelector('[data-papercraft-error]')?.textContent ?? '',
    /boom-in-render/,
  );
});

test("a render error React recovers from stays the preview's: on the console, never the window's", async () => {
  // Fails only its first render, so React retries it and reports the error
  // as one it recovered from.
  const module = await compile(
    {
      'src/Flaky.tsx': [
        'let renders = 0;',
        'export default function Flaky() {',
        '  renders += 1;',
        "  if (renders === 1) throw new Error('flaky-first-render');",
        '  return <span id="flaky">steady</span>;',
        '}',
      ].join('\n'),
    },
    'src/Flaky.tsx',
  );
  const windowErrors: unknown[] = [];
  const onError = (event: unknown) => windowErrors.push(event);
  window.addEventListener('error', onError);
  const logged: unknown[][] = [];
  const quiet = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };

  let root: HTMLElement;

  try {
    ({ root } = await mountInFrame(module));
  } finally {
    console.error = quiet;
    window.removeEventListener('error', onError);
  }

  assert.equal(root.querySelector('#flaky')?.textContent, 'steady');
  assert.equal(windowErrors.length, 0, 'The preview raised a window error.');
  const causes = logged.flat().flatMap((value) => {
    const chain: string[] = [];
    for (let at = value; at instanceof Error; at = at.cause) {
      chain.push(at.message);
    }
    return chain;
  });
  assert.ok(
    causes.includes('flaky-first-render'),
    'The console never named what the preview threw.',
  );
});

test("the harness's decorators wrap a plain component", async () => {
  const module = await compile(
    {
      'src/Counter.tsx': COUNTER,
      '.papercraft/preview.tsx': [
        "import type { Preview } from '@storybook/react';",
        'export default {',
        '  decorators: [',
        '    (Story, context) => (',
        '      <section data-harness={context.globals.theme} data-view={context.viewMode}>',
        '        <Story />',
        '      </section>',
        '    ),',
        '  ],',
        '} satisfies Preview;',
      ].join('\n'),
    },
    'src/Counter.tsx',
  );
  const { root } = await mountInFrame(module);

  assert.equal(
    root.querySelector(
      'section[data-harness="light"][data-view="story"] #count',
    )?.textContent,
    '2',
  );
});

const LABEL = [
  'export function Label(props: { tone: string; size: string; label: string }) {',
  '  return <output id="label">{props.tone}/{props.size}/{props.label}</output>;',
  '}',
].join('\n');

const layer = (name: string): string =>
  `(Story) => <div data-layer="${name}"><Story /></div>`;

test('a story renders under its, its meta and the harness decorators, with merged args', async () => {
  const module = await compile(
    {
      'src/Label.tsx': LABEL,
      '.storybook/preview.tsx': [
        'export default {',
        `  decorators: [${layer('preview')}],`,
        "  args: { tone: 'preview', size: 'preview', label: 'preview' },",
        '};',
      ].join('\n'),
      'src/Label.stories.tsx': [
        "import { Label } from './Label.js';",
        'export default {',
        '  component: Label,',
        "  args: { size: 'meta', label: 'meta' },",
        `  decorators: [${layer('meta')}],`,
        '};',
        "export const First = { args: { label: 'first' } };",
        'export const Second = {',
        "  args: { label: 'story' },",
        `  decorators: [${layer('story')}],`,
        '};',
      ].join('\n'),
    },
    'src/Label.stories.tsx',
    'Second',
  );
  const { root } = await mountInFrame(module);

  const label = root.querySelector(
    '[data-layer="preview"] [data-layer="meta"] [data-layer="story"] #label',
  );
  assert.equal(label?.textContent, 'preview/meta/story');
  assert.equal(
    root.querySelector('[data-layer="meta"] [data-layer="preview"]'),
    null,
  );
});

test("mount states the story's layout on its root, centred unless a parameter names Storybook's own", async () => {
  const stories = {
    'src/Label.tsx': LABEL,
    '.storybook/preview.tsx':
      "export default { parameters: { layout: 'padded' } };",
    'src/Label.stories.tsx': [
      "import { Label } from './Label.js';",
      "export default { component: Label, args: { tone: 't', size: 's', label: 'l' } };",
      'export const FromHarness = {};',
      "export const Full = { parameters: { layout: 'fullscreen' } };",
    ].join('\n'),
  };
  const layoutOf = async (module: PreviewModule): Promise<string | null> => {
    const { root } = await mountInFrame(module);

    return root.getAttribute('data-papercraft-layout');
  };

  assert.equal(
    await layoutOf(
      await compile({ 'src/Counter.tsx': COUNTER }, 'src/Counter.tsx'),
    ),
    'centered',
  );
  assert.equal(
    await layoutOf(
      await compile(stories, 'src/Label.stories.tsx', 'FromHarness'),
    ),
    'padded',
  );
  assert.equal(
    await layoutOf(await compile(stories, 'src/Label.stories.tsx', 'Full')),
    'fullscreen',
  );
});

test("@storybook/addon-themes puts the preview's theme on the document", async () => {
  const module = await compile(
    {
      'src/Counter.tsx': COUNTER,
      '.storybook/preview.ts': [
        "import { withThemeByClassName, withThemeByDataAttribute } from '@storybook/addon-themes';",
        'export const decorators = [',
        "  withThemeByClassName({ themes: { light: 'theme-light', dark: 'theme-dark' }, defaultTheme: 'light' }),",
        "  withThemeByDataAttribute({ themes: { light: 'day', dark: 'night' }, attributeName: 'data-mode' }),",
        '];',
      ].join('\n'),
    },
    'src/Counter.tsx',
  );
  const { root } = await mountInFrame(module, 'dark');

  const html = document.documentElement;
  assert.equal(root.querySelector('#count')?.textContent, '2');
  assert.ok(html.classList.contains('theme-dark'));
  assert.ok(!html.classList.contains('theme-light'));
  assert.equal(html.getAttribute('data-mode'), 'night');
});

test("the Project's desktop/ui overlay renders in the document's body through the harness's provider", async () => {
  const module = await compile(
    {
      'tsconfig.json': DORIC_TSCONFIG,
      // The harness Doric's packages have: it hands `desktop/ui`'s provider
      // the container the preview gives it, none in the frame.
      '.storybook/preview.tsx': [
        "import { PortalContainerProvider } from 'desktop/ui/portal-container';",
        'export default {',
        '  decorators: [',
        '    (Story, context) => (',
        '      <PortalContainerProvider container={context.papercraft?.portalContainer}>',
        '        <Story />',
        '      </PortalContainerProvider>',
        '    ),',
        '  ],',
        '};',
      ].join('\n'),
      'src/Menu.tsx': [
        "import { Popover, PopoverContent, PopoverTrigger } from 'desktop/ui/popover';",
        'export default function Menu() {',
        '  return (',
        '    <Popover open>',
        '      <PopoverTrigger>Open</PopoverTrigger>',
        '      <PopoverContent>',
        '        <p id="menu-body">menu</p>',
        '      </PopoverContent>',
        '    </Popover>',
        '  );',
        '}',
      ].join('\n'),
    },
    'src/Menu.tsx',
  );
  const { root } = await mountInFrame(module);

  const body = document.querySelector('#menu-body');
  assert.equal(body?.textContent, 'menu');
  // Portaled out of the React root, to the document's body.
  assert.equal(root.contains(body), false);
  assert.equal(document.body.contains(body), true);
});

test('a revision compiled before the frame still mounts in its #root, with its own portal container', async () => {
  // The bytes of a story compiled by the shadow-root `mount`: it renders
  // `#anchor` and portals `#overlay` into `context.papercraft.portalContainer`,
  // with `parameters.layout: 'padded'`.
  const bytes = await readFile(
    new URL('../../../tests/fixtures/old-revision/index.js', import.meta.url),
  );
  const module = await load('old-revision', bytes);

  const { root, unmount } = await mountInFrame(module, 'dark');

  assert.equal(root.querySelector('#anchor') !== null, true);
  assert.equal(root.querySelector('#overlay')?.textContent, 'open');
  assert.equal(root.getAttribute('data-papercraft-layout'), 'padded');

  await act(async () => {
    unmount?.();
    await Promise.resolve();
  });
  assert.equal(root.querySelector('#overlay'), null);
});
