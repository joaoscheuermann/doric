// Path B's module contract, live: the `index.js` a component preview
// compiles to is imported as the window imports it — bare specifiers resolved
// to the one React the page has — and `mount(root, { theme })` renders the
// component, stamps its elements with their Project origin, follows the
// theme, contains a render error and unmounts.
//
// Contract matrix:
// - mount renders the component (hooks work: one React instance), every
//   element the Project's code wrote carries `path:line`, and the returned
//   function unmounts it;
// - `theme: 'dark'` puts the rendered tree under `.dark`;
// - a component that throws renders an error in place of the preview instead
//   of escaping `mount`;
// - the Project harness's decorators wrap a plain component, with the
//   preview's theme in `context.globals`;
// - a CSF story renders under its own, its meta's and the harness's
//   decorators (the harness outermost) with `args` merged harness < meta <
//   story;
// - `@storybook/addon-themes` follows the preview's theme;
// - the portal container lives in the shadow root the module is mounted in,
//   and an element a story portals into it renders there, under `.dark`
//   when the preview is dark;
// - an overlay of the Project's own `desktop/ui` (the workspace's real
//   `packages/desktop`, reached through the Project's `customConditions`)
//   renders in that portal container once the harness hands it to
//   `desktop/ui`'s provider, as Doric's harnesses do;
// - mount states the story's Storybook layout on its root: the merged
//   `parameters.layout` when it is one of Storybook's, else `centered`.

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
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

  compiled += 1;
  const file = join(
    scratch,
    `${path.replaceAll('/', '_')}-${String(compiled)}.mjs`,
  );
  await writeFile(file, Buffer.from(js.base64, 'base64'));

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

const rootElement = (): HTMLElement => {
  const root = document.createElement('div');
  document.body.append(root);

  return root;
};

test('mount renders the component with origin stamps, and unmounts', async () => {
  const module = await compile(
    { 'src/Counter.tsx': COUNTER },
    'src/Counter.tsx',
  );
  const root = rootElement();
  let unmount: undefined | (() => void);

  await act(async () => {
    unmount = module.mount(root, { theme: 'light' });
  });

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
  assert.equal(root.querySelector('.dark'), null);

  assert.equal(typeof unmount, 'function');
  await act(async () => {
    unmount?.();
    await Promise.resolve();
  });
  assert.equal(root.querySelector('#count'), null);
});

test("the dark theme puts the preview under '.dark'", async () => {
  const module = await compile({ 'src/Dark.tsx': COUNTER }, 'src/Dark.tsx');
  const root = rootElement();

  await act(async () => {
    module.mount(root, { theme: 'dark' });
  });

  assert.ok(root.querySelector('.dark #count') !== null);
});

test('a component that throws renders an error instead of escaping mount', async () => {
  const module = await compile(
    {
      'src/Boom.tsx':
        "export default function Boom(): never { throw new Error('boom-in-render'); }",
    },
    'src/Boom.tsx',
  );
  const root = rootElement();
  const quiet = console.error;
  console.error = () => undefined;

  try {
    await act(async () => {
      module.mount(root, { theme: 'light' });
    });
  } finally {
    console.error = quiet;
  }

  assert.match(
    root.querySelector('[data-papercraft-error]')?.textContent ?? '',
    /boom-in-render/,
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
  const root = rootElement();

  await act(async () => {
    module.mount(root, { theme: 'light' });
  });

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
  const root = rootElement();

  await act(async () => {
    module.mount(root, { theme: 'light' });
  });

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
    const root = rootElement();

    await act(async () => {
      module.mount(root, { theme: 'light' });
    });

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

test("@storybook/addon-themes follows the preview's theme", async () => {
  const module = await compile(
    {
      'src/Counter.tsx': COUNTER,
      '.storybook/preview.ts': [
        "import { withThemeByClassName } from '@storybook/addon-themes';",
        'export const decorators = [',
        "  withThemeByClassName({ themes: { light: 'theme-light', dark: 'theme-dark' }, defaultTheme: 'light' }),",
        '];',
      ].join('\n'),
    },
    'src/Counter.tsx',
  );
  const root = rootElement();

  await act(async () => {
    module.mount(root, { theme: 'dark' });
  });

  assert.ok(root.querySelector('.theme-dark #count') !== null);
});

test('a portaled element renders in the portal container inside the shadow root', async () => {
  const module = await compile(
    {
      'src/Overlay.stories.tsx': [
        "import { createPortal } from 'react-dom';",
        'export default {};',
        'export const Open = {',
        '  render: (_args, context) =>',
        '    createPortal(<div id="overlay">open</div>, context.papercraft.portalContainer),',
        '};',
      ].join('\n'),
    },
    'src/Overlay.stories.tsx',
  );
  const host = rootElement();
  const shadow = host.attachShadow({ mode: 'open' });
  const content = document.createElement('div');
  shadow.append(content);

  await act(async () => {
    module.mount(content, { theme: 'dark' });
  });

  const overlay = shadow.querySelector('[data-papercraft-portal] #overlay');
  assert.equal(overlay?.textContent, 'open');
  assert.equal(overlay?.getRootNode(), shadow);
  // Under the preview's theme, as the rendered tree is.
  assert.ok(shadow.querySelector('.dark > #overlay') !== null);
});

test("the Project's desktop/ui overlay renders in the portal container its harness hands it", async () => {
  const module = await compile(
    {
      'tsconfig.json': DORIC_TSCONFIG,
      // The harness Doric's packages have: it hands `desktop/ui`'s provider
      // the container the preview gives it.
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
  const host = rootElement();
  const shadow = host.attachShadow({ mode: 'open' });
  const content = document.createElement('div');
  shadow.append(content);

  await act(async () => {
    module.mount(content, { theme: 'light' });
  });

  const body = shadow.querySelector('[data-papercraft-portal] #menu-body');
  assert.equal(body?.textContent, 'menu');
  assert.equal(document.querySelector('#menu-body'), null);
});
