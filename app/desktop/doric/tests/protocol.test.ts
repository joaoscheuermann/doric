import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { constants, Script } from 'node:vm';

import {
  developmentCsp,
  packagedCsp,
  splashCsp,
} from '../src/platform/protocol/csp';
import {
  frameImportMap,
  renderFrameDocument,
} from '../src/platform/protocol/frame';
import {
  type ProtocolDeps,
  respond,
  type ServedBundles,
} from '../src/platform/protocol/handler';
import {
  generationImportMap,
  type ImportMap,
} from '../src/platform/protocol/import-map';
import type { Resources } from '../src/platform/protocol/resources';
import {
  createShellRenderer,
  renderShell,
} from '../src/platform/protocol/shell';

/** Today's packaged policy, verbatim (CD §A.3). */
const TODAY_PACKAGED =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** Today's development policy, verbatim. */
const TODAY_DEVELOPMENT =
  "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://localhost:4200; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const TEMPLATE = `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="utf-8" />
    <title>Doric</title>
    <link rel="stylesheet" href="/platform/shell@1.0.0/styles.css" />
  </head>
  <body><div id="root"></div></body>
</html>
`;

const map: ImportMap = {
  imports: {
    react: 'doric://app/platform/react@19.2.8/index.js',
    zod: 'doric://app/platform/zod@4.4.3/index.js',
  },
};

/** A platform map with a preview's externals among everything else. */
const platformMap: ImportMap = {
  imports: {
    react: 'doric://app/platform/react@19.2.8/index.js',
    'react/jsx-runtime': 'doric://app/platform/react@19.2.8/jsx-runtime.js',
    'react/jsx-dev-runtime':
      'doric://app/platform/react@19.2.8/jsx-dev-runtime.js',
    'react-dom': 'doric://app/platform/react-dom@19.2.8/index.js',
    'react-dom/client': 'doric://app/platform/react-dom@19.2.8/client.js',
    '@base-ui/react': 'doric://app/platform/@base-ui/react@1.8.0/index.js',
    '@base-ui/react/dialog':
      'doric://app/platform/@base-ui/react@1.8.0/dialog.js',
    '@base-ui/react/internals/noop':
      'doric://app/platform/@base-ui/react@1.8.0/internals/noop.js',
    '@base-ui/reactive': 'doric://app/platform/@base-ui/reactive@1.0.0/x.js',
    'react-is': 'doric://app/platform/react-is@19.2.8/index.js',
    zod: 'doric://app/platform/zod@4.4.3/index.js',
    lexical: 'doric://app/platform/lexical@0.51.0/index.js',
    'desktop/ui': 'doric://app/platform/desktop@1.0.0/ui/index.js',
    'bundle/contracts': 'doric://app/platform/bundle@1.0.0/contracts.js',
    'core/contracts': 'doric://app/bundles/core@1.3.0/contracts/index.js',
  },
};

/** The plan's frame policy for an import map hash. */
const FRAME_POLICY = (hash: string) =>
  `default-src 'none'; script-src doric://app 'sha256-${hash}'; style-src doric://app 'unsafe-inline'; font-src doric://app; img-src doric://app data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors doric://app`;

const sha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('base64');

const importMapOf = (html: string): string | undefined =>
  /<script type="importmap">(.*?)<\/script>/su.exec(html)?.[1];

let root: string;
let resources: Resources;
const listed = new Map<string, string>();
const bundles: ServedBundles = {
  file: (id, version, path) => listed.get(`${id}@${version}/${path}`),
};

const deps = (overrides: Partial<ProtocolDeps> = {}): ProtocolDeps => ({
  resources,
  bundles,
  artifacts: { root: join(root, 'artifacts') },
  shell: createShellRenderer({
    mode: 'packaged',
    template: async () => TEMPLATE,
    generation: () => 3,
    importMap: () => map,
    themeHref: '/platform/desktop@1.0.0/theme.css',
    devServerOrigin: 'http://localhost:4200',
  }),
  frame: renderFrameDocument(frameImportMap(platformMap)),
  ...overrides,
});

const get = (url: string, overrides?: Partial<ProtocolDeps>) =>
  respond({ url }, deps(overrides));

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'doric-protocol-'));
  resources = {
    platformRoot: join(root, 'platform'),
    schemasRoot: join(root, 'schemas'),
    shellRoot: join(root, 'renderer'),
    shellVersion: '1.0.0',
  };
  await mkdir(join(root, 'platform', 'react@19.2.8'), { recursive: true });
  await mkdir(join(root, 'platform', 'splash@1.0.0'), { recursive: true });
  await mkdir(join(root, 'schemas', 'contracts'), { recursive: true });
  await mkdir(join(root, 'renderer'), { recursive: true });
  await mkdir(join(root, 'cache', 'probe@1.0.0', 'client'), {
    recursive: true,
  });
  await writeFile(
    join(root, 'platform', 'react@19.2.8', 'index.js'),
    'export {};',
  );
  await writeFile(
    join(root, 'platform', 'splash@1.0.0', 'index.html'),
    '<!doctype html>',
  );
  await writeFile(join(root, 'schemas', 'contracts', 'a.json'), '{}');
  await writeFile(join(root, 'renderer', 'main.js'), 'void 0;');
  await writeFile(join(root, 'secret.txt'), 'outside');
  await mkdir(join(root, 'artifacts', 'checkout-7f3a@1', 'assets'), {
    recursive: true,
  });
  await writeFile(
    join(root, 'artifacts', 'checkout-7f3a@1', 'index.js'),
    'export {};',
  );
  await writeFile(
    join(root, 'artifacts', 'checkout-7f3a@1', 'assets', 'theme.css'),
    'body {}',
  );
  await writeFile(
    join(root, 'artifacts', 'checkout-7f3a@1', 'notes.md'),
    '# notes',
  );
  await writeFile(
    join(root, 'cache', 'probe@1.0.0', 'client', 'index.js'),
    'export {};',
  );
  await writeFile(
    join(root, 'cache', 'probe@1.0.0', 'client', 'unlisted.js'),
    'export {};',
  );
  listed.set(
    'probe@1.0.0/client/index.js',
    join(root, 'cache', 'probe@1.0.0', 'client', 'index.js'),
  );
  await mkdir(join(root, 'cache', 'probe@1.0.0', 'client', 'frames'), {
    recursive: true,
  });
  await mkdir(join(root, 'cache', 'probe@1.0.0', 'desktop'), {
    recursive: true,
  });

  for (const path of [
    'client/frames/preview.js',
    'client/framesake.js',
    'desktop/index.js',
  ]) {
    await writeFile(join(root, 'cache', 'probe@1.0.0', path), 'export {};');
    listed.set(`probe@1.0.0/${path}`, join(root, 'cache', 'probe@1.0.0', path));
  }
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('doric://app routing', () => {
  test('serves an existing platform, schema, shell or bundle file with its content type and no CSP', async () => {
    for (const [url, type] of [
      ['doric://app/platform/react@19.2.8/index.js', 'text/javascript'],
      ['doric://app/schemas/contracts/a.json', 'application/json'],
      ['doric://app/platform/shell@1.0.0/main.js', 'text/javascript'],
      ['doric://app/bundles/probe@1.0.0/client/index.js', 'text/javascript'],
      ['doric://app/artifacts/checkout-7f3a@1/index.js', 'text/javascript'],
      ['doric://app/artifacts/checkout-7f3a@1/assets/theme.css', 'text/css'],
      [
        'doric://app/artifacts/checkout-7f3a@1/notes.md',
        'application/octet-stream',
      ],
    ] as const) {
      const response = await get(url);

      assert.equal(response.status, 200, url);
      assert.equal(response.headers.get('content-type'), type, url);
      assert.equal(response.headers.get('content-security-policy'), null, url);
    }
  });

  test('answers 404, never the shell, for missing or forbidden files under the asset prefixes', async () => {
    for (const url of [
      'doric://app/platform/react@19.2.8/missing.js',
      'doric://app/platform/missing@1.0.0/index.js',
      'doric://app/bundles/probe@1.0.0/client/missing.js',
      'doric://app/bundles/unknown@9.9.9/client/index.js',
      'doric://app/bundles/probe@1.0.0/client/unlisted.js',
      'doric://app/bundles/probe/client/index.js',
      'doric://app/artifacts/checkout-7f3a@1/missing.js',
      'doric://app/artifacts/checkout-7f3a@2/index.js',
      'doric://app/artifacts/checkout-7f3a@1',
      'doric://app/artifacts/checkout-7f3a@1/',
      'doric://app/artifacts/checkout@1/index.js',
      'doric://app/artifacts/checkout@x/index.js',
      'doric://app/artifacts/@1/index.js',
      'doric://app/artifacts/.tmp/staged.js',
      'doric://app/artifacts/checkout-7f3a@0/index.js',
      'doric://app/artifacts/checkout-7f3a@01/index.js',
      'doric://app/artifacts/',
      'doric://app/platform/react@19.2.8/%2e%2e%2f..%2fsecret.txt',
      'doric://app/platform/react@19.2.8/..%5c..%5csecret.txt',
      'doric://app/platform/react@19.2.8//index.js',
      'doric://app/schemas/missing.json',
      'doric://app/platform/',
      'doric://other/x',
      'doric://other/platform/react@19.2.8/index.js',
    ]) {
      const response = await get(url);

      assert.equal(response.status, 404, url);
    }
  });

  test('never serves a file outside its root, whatever the dot segments', async () => {
    for (const url of [
      'doric://app/platform/../secret.txt',
      'doric://app/platform/%2e%2e/secret.txt',
      'doric://app/schemas/../../secret.txt',
      'doric://app/bundles/probe@1.0.0/../../secret.txt',
      'doric://app/artifacts/checkout-7f3a@1/../../secret.txt',
      'doric://app/artifacts/checkout-7f3a@1/%2e%2e/%2e%2e/secret.txt',
      'doric://app/artifacts/checkout-7f3a@1/..%5c..%5csecret.txt',
    ]) {
      const response = await get(url);

      assert.ok(!(await response.text()).includes('outside'), url);
    }
  });

  test('renders the shell for every other path, with the packaged CSP', async () => {
    for (const url of [
      'doric://app/',
      'doric://app/settings',
      'doric://app/settings/providers?tab=1#x',
      'doric://app/projects/p1/threads/t1',
    ]) {
      const response = await get(url);
      const html = await response.text();

      assert.equal(response.status, 200, url);
      assert.equal(response.headers.get('content-type'), 'text/html', url);
      assert.match(html, /<div id="root"><\/div>/u, url);
      assert.match(
        response.headers.get('content-security-policy') ?? '',
        /^default-src 'none'; script-src 'self' 'sha256-/u,
      );
    }
  });

  test('answers the shell only to a navigation: a font or image at an app path is a 404', async () => {
    const at = (url: string, destination: string) =>
      respond(
        { url, headers: new Headers({ 'sec-fetch-dest': destination }) },
        deps(),
      );

    const navigation = await at('doric://app/settings', 'document');
    assert.equal(navigation.status, 200);
    assert.equal(navigation.headers.get('content-type'), 'text/html');

    // Electron passes a custom scheme's handler no `Sec-Fetch-Dest`: what a
    // request accepts tells a navigation from a subresource.
    const accepting = (url: string, accept: string) =>
      respond({ url, headers: new Headers({ accept }) }, deps());
    const page = await accepting(
      'doric://app/projects/p1',
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    );
    assert.equal(page.status, 200);
    for (const accept of ['*/*', 'image/avif,image/webp,image/*,*/*;q=0.8']) {
      const asset = await accepting('doric://app/assets/fonts/a.woff2', accept);
      assert.equal(asset.status, 404, accept);
    }

    // A sheet's font written for another place lands on an app path.
    for (const [url, destination] of [
      ['doric://app/assets/fonts/noto-sans-latin-normal.woff2', 'font'],
      ['doric://app/assets/hero.png', 'image'],
      ['doric://app/settings', 'iframe'],
      ['doric://app/projects/p1', 'script'],
    ] as const) {
      const response = await at(url, destination);

      assert.equal(response.status, 404, `${destination} ${url}`);
      assert.doesNotMatch(await response.text(), /<!doctype/iu);
    }
  });

  test('serves the splash page with the packaged CSP without a hash', async () => {
    const response = await get('doric://app/platform/splash@1.0.0/index.html');

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-security-policy'), splashCsp());
  });

  test('forwards shell assets to the dev server in development', async () => {
    const forwarded: string[] = [];
    const response = await get(
      'doric://app/platform/shell@1.0.0/main.hot-update.js',
      {
        devProxy: {
          origin: 'http://localhost:4200',
          template: async () => TEMPLATE,
          forward: async (path) => {
            forwarded.push(path);

            return new Response('hot', {
              status: 200,
              headers: { 'content-type': 'text/javascript' },
            });
          },
        },
      },
    );

    assert.equal(await response.text(), 'hot');
    assert.deepEqual(forwarded, ['/platform/shell@1.0.0/main.hot-update.js']);
  });
});

describe('content security policy', () => {
  test('the packaged shell is today plus worker-src, the import map hash and the frame document', () => {
    assert.equal(
      packagedCsp('HASH'),
      TODAY_PACKAGED.replace(
        "script-src 'self'",
        "script-src 'self' 'sha256-HASH'; worker-src 'self'",
      ).replace(
        "font-src 'self'",
        "font-src 'self'; frame-src doric://app/frame/",
      ),
    );
  });

  test('the splash is today plus worker-src, and frames nothing', () => {
    assert.equal(
      splashCsp(),
      TODAY_PACKAGED.replace(
        "script-src 'self'",
        "script-src 'self'; worker-src 'self'",
      ),
    );
  });

  test('the development shell is today plus the import map hash and the frame document', () => {
    assert.equal(
      developmentCsp('HASH', 'http://localhost:4200'),
      TODAY_DEVELOPMENT.replace(
        "'unsafe-eval'",
        "'unsafe-eval' 'sha256-HASH'",
      ).replace(
        "font-src 'self'",
        "font-src 'self'; frame-src doric://app/frame/",
      ),
    );
  });

  test('a development shell answer frames only the frame document too', async () => {
    const response = await get('doric://app/', {
      shell: createShellRenderer({
        mode: 'development',
        template: async () => TEMPLATE,
        generation: () => 3,
        importMap: () => map,
        themeHref: '/platform/desktop@1.0.0/theme.css',
        devServerOrigin: 'http://localhost:4200',
      }),
    });

    assert.match(
      response.headers.get('content-security-policy') ?? '',
      /; frame-src doric:\/\/app\/frame\/;/u,
    );
  });

  test('the shell CSP hash is the SHA-256 of the import map it serves', async () => {
    const response = await get('doric://app/');
    const html = await response.text();
    const text = /<script type="importmap">(.*?)<\/script>/su.exec(html)?.[1];

    assert.notEqual(text, undefined);

    const hash = createHash('sha256')
      .update(text as string, 'utf8')
      .digest('base64');

    assert.ok(
      (response.headers.get('content-security-policy') ?? '').includes(
        `'sha256-${hash}'`,
      ),
    );
  });
});

describe('shell document', () => {
  test('injects the generation, the import map and the theme first in <head>, in that order', () => {
    const { html } = renderShell(TEMPLATE, {
      generation: 7,
      importMap: map,
      themeHref: '/platform/desktop@1.0.0/theme.css',
    });
    const head = html.slice(html.indexOf('<head>') + '<head>'.length);

    assert.ok(
      head.startsWith(
        '<meta name="doric-generation" content="7"><script type="importmap">',
      ),
    );
    assert.ok(
      head.indexOf(
        '<link rel="stylesheet" href="/platform/desktop@1.0.0/theme.css">',
      ) < head.indexOf('/platform/shell@1.0.0/styles.css'),
    );
    assert.match(html, /<html lang="en" class="dark">/u);
    assert.match(html, /<title>Doric<\/title>/u);
  });

  test('carries the generation contracts of its bundles in the import map', () => {
    const generation = generationImportMap(map, [
      { id: 'core', version: '1.3.0', entry: 'contracts/index.js' },
    ]);
    const { html } = renderShell(TEMPLATE, {
      generation: 1,
      importMap: generation,
      themeHref: '/t.css',
    });
    const text = /<script type="importmap">(.*?)<\/script>/su.exec(html)?.[1];
    const parsed = JSON.parse(text as string) as ImportMap;

    assert.equal(
      parsed.imports['core/contracts'],
      'doric://app/bundles/core@1.3.0/contracts/index.js',
    );
    assert.equal(parsed.imports.react, map.imports.react);
  });
});

describe('preview frame document', () => {
  test('is served at /frame/index.html, whatever its entry, with the frame policy over its own import map', async () => {
    for (const url of [
      'doric://app/frame/index.html',
      'doric://app/frame/index.html?entry=doric%3A%2F%2Fapp%2Fbundles%2Fpapercraft%401.0.0%2Fclient%2Fframes%2Fpreview.js',
    ]) {
      const response = await get(url);
      const html = await response.text();
      const text = importMapOf(html);

      assert.equal(response.status, 200, url);
      assert.equal(response.headers.get('content-type'), 'text/html', url);
      assert.notEqual(text, undefined, url);
      assert.equal(
        response.headers.get('content-security-policy'),
        FRAME_POLICY(sha256(text as string)),
        url,
      );
      assert.match(html, /<body><\/body>/u, url);
      assert.match(
        html,
        /<script type="module" src="doric:\/\/app\/frame\/boot\.js"><\/script>/u,
        url,
      );
    }
  });

  test('may be embedded by doric://app only, never refused outright', async () => {
    const policy =
      (await get('doric://app/frame/index.html')).headers.get(
        'content-security-policy',
      ) ?? '';

    assert.ok(policy.endsWith('; frame-ancestors doric://app'));
    assert.ok(!policy.includes("frame-ancestors 'none'"));
  });

  test("carries only a preview's externals, as the platform's absolute URLs", async () => {
    const html = await (await get('doric://app/frame/index.html')).text();
    const parsed = JSON.parse(importMapOf(html) as string) as ImportMap;

    assert.deepEqual(parsed, {
      imports: {
        react: 'doric://app/platform/react@19.2.8/index.js',
        'react/jsx-runtime': 'doric://app/platform/react@19.2.8/jsx-runtime.js',
        'react/jsx-dev-runtime':
          'doric://app/platform/react@19.2.8/jsx-dev-runtime.js',
        'react-dom': 'doric://app/platform/react-dom@19.2.8/index.js',
        'react-dom/client': 'doric://app/platform/react-dom@19.2.8/client.js',
        '@base-ui/react': 'doric://app/platform/@base-ui/react@1.8.0/index.js',
        '@base-ui/react/dialog':
          'doric://app/platform/@base-ui/react@1.8.0/dialog.js',
        '@base-ui/react/internals/noop':
          'doric://app/platform/@base-ui/react@1.8.0/internals/noop.js',
      },
    });
  });

  test('serves boot.js as a script; any other /frame/ path is a 404', async () => {
    const boot = await get('doric://app/frame/boot.js');

    assert.equal(boot.status, 200);
    assert.equal(boot.headers.get('content-type'), 'text/javascript');

    for (const url of [
      'doric://app/frame/',
      'doric://app/frame/other.js',
      'doric://app/frame/index.htm',
      'doric://app/frame/index.html/x',
      'doric://app/frame/sub/index.html',
      'doric://app/frame//index.html',
      'doric://app/frame/%2e%2e%2fsettings',
    ]) {
      const response = await get(url);

      assert.equal(response.status, 404, url);
      assert.doesNotMatch(await response.text(), /<html/iu, url);
    }
  });
});

describe('boot.js runs only a bundle frame entry', () => {
  // Node cannot load `doric://`: a resolve hook (the module loader is the
  // boundary) records each `doric:` import and answers an empty module.
  let imported: string[] = [];

  before(async () => {
    const { registerHooks } = (await import('node:module')) as unknown as {
      registerHooks(hooks: {
        resolve(
          specifier: string,
          context: unknown,
          next: (specifier: string, context: unknown) => unknown,
        ): unknown;
      }): void;
    };

    registerHooks({
      resolve: (specifier, context, next) => {
        if (!specifier.startsWith('doric:')) {
          return next(specifier, context);
        }

        imported.push(specifier);

        return { url: 'data:text/javascript,export{}', shortCircuit: true };
      },
    });
  });

  /** Runs the served boot script at `search`; the specifiers it imported. */
  const boot = async (search: string): Promise<string[]> => {
    const source = await (await get('doric://app/frame/boot.js')).text();
    const script = new Script(source, {
      importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });

    imported = [];
    script.runInNewContext({ location: { search }, URLSearchParams });
    await new Promise((done) => setTimeout(done, 20));

    return imported;
  };
  const query = (entry: string) => `?entry=${encodeURIComponent(entry)}`;

  test("imports a bundle's frame module", async () => {
    for (const entry of [
      'doric://app/bundles/papercraft@1.4.0/client/frames/preview.js',
      'doric://app/bundles/papercraft@0.0.0-dev.3/client/frames/preview.js',
      'doric://app/bundles/my-bundle@10.20.30/client/frames/two_words-x.js',
    ]) {
      assert.deepEqual(await boot(query(entry)), [entry], entry);
    }
  });

  test('imports nothing for any other entry, or none', async () => {
    assert.deepEqual(await boot(''), []);
    assert.deepEqual(await boot('?other=1'), []);

    for (const entry of [
      '',
      'doric://app/bundles/papercraft@1.4.0/client/index.js',
      'doric://app/bundles/papercraft@1.4.0/desktop/index.js',
      'doric://app/bundles/papercraft@1.4.0/client/frames/sub/preview.js',
      'doric://app/bundles/papercraft@1.4.0/client/frames/../index.js',
      'doric://app/bundles/papercraft@1.4.0/client/frames/%2e%2e%2findex.js',
      'doric://app/bundles/papercraft@1.4.0/client/frames/.js',
      'doric://app/bundles/papercraft@1.4.0/client/frames/preview.mjs',
      'doric://app/bundles/papercraft@1.4.0/client/frames/preview.js?x=1',
      'doric://app/bundles/papercraft@1.4.0/client/frames/preview.js#x',
      'doric://app/bundles/papercraft@latest/client/frames/preview.js',
      'doric://app/bundles/papercraft@1.4/client/frames/preview.js',
      'doric://app/bundles/papercraft/client/frames/preview.js',
      'doric://app/bundles/Papercraft@1.4.0/client/frames/preview.js',
      'doric://app/artifacts/checkout-7f3a@1/index.js',
      'doric://app/platform/react@19.2.8/index.js',
      'doric://app/frame/boot.js',
      'doric://other/bundles/papercraft@1.4.0/client/frames/preview.js',
      'https://example.com/bundles/papercraft@1.4.0/client/frames/preview.js',
      ' doric://app/bundles/papercraft@1.4.0/client/frames/preview.js',
      'data:text/javascript,export%20{}',
      'react',
    ]) {
      assert.deepEqual(await boot(query(entry)), [], entry);
    }
  });
});

describe('CORS for preview frames', () => {
  const nullOrigin = (url: string) =>
    respond(new Request(url, { headers: { origin: 'null' } }), deps());

  test('frame, platform, artifact and bundle frame files allow any origin', async () => {
    for (const url of [
      'doric://app/frame/index.html?entry=x',
      'doric://app/frame/boot.js',
      'doric://app/platform/react@19.2.8/index.js',
      'doric://app/artifacts/checkout-7f3a@1/index.js',
      'doric://app/artifacts/checkout-7f3a@1/assets/theme.css',
      'doric://app/bundles/probe@1.0.0/client/frames/preview.js',
    ]) {
      for (const response of [await get(url), await nullOrigin(url)]) {
        assert.equal(response.status, 200, url);
        assert.equal(
          response.headers.get('access-control-allow-origin'),
          '*',
          url,
        );
      }
    }
  });

  test('the shell, schemas, splash and every other bundle file stay same-origin', async () => {
    for (const url of [
      'doric://app/',
      'doric://app/settings',
      'doric://app/schemas/contracts/a.json',
      'doric://app/platform/splash@1.0.0/index.html',
      'doric://app/platform/shell@1.0.0/main.js',
      'doric://app/bundles/probe@1.0.0/client/index.js',
      'doric://app/bundles/probe@1.0.0/client/framesake.js',
      'doric://app/bundles/probe@1.0.0/desktop/index.js',
    ]) {
      for (const response of [await get(url), await nullOrigin(url)]) {
        assert.equal(response.status, 200, url);
        assert.equal(
          response.headers.get('access-control-allow-origin'),
          null,
          url,
        );
      }
    }
  });
});
