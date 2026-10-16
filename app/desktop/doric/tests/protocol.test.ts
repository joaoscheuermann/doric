import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { developmentCsp, packagedCsp } from '../src/platform/protocol/csp';
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

  test('serves the splash page with the packaged CSP without a hash', async () => {
    const response = await get('doric://app/platform/splash@1.0.0/index.html');

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('content-security-policy'),
      packagedCsp(),
    );
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
  test('packaged is today plus worker-src and the import map hash', () => {
    assert.equal(
      packagedCsp('HASH'),
      TODAY_PACKAGED.replace(
        "script-src 'self'",
        "script-src 'self' 'sha256-HASH'; worker-src 'self'",
      ),
    );
    assert.equal(
      packagedCsp(),
      TODAY_PACKAGED.replace(
        "script-src 'self'",
        "script-src 'self'; worker-src 'self'",
      ),
    );
  });

  test('development is today plus the import map hash', () => {
    assert.equal(
      developmentCsp('HASH', 'http://localhost:4200'),
      TODAY_DEVELOPMENT.replace("'unsafe-eval'", "'unsafe-eval' 'sha256-HASH'"),
    );
  });

  test('neither policy carves out a frame origin: the default source governs frames', () => {
    assert.ok(!packagedCsp('HASH').includes('frame-src'));
    assert.ok(
      !developmentCsp('HASH', 'http://localhost:4200').includes('frame-src'),
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
