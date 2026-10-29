// The draw.io editor origin as main serves it, without Electron: the
// `https:` handler answers `https://drawio.doric.invalid/…` from the
// vendored webapp on disk and passes every other host through untouched;
// `describe` reports whether the editor is there; main's broker answers
// `doric.drawio/v1` with what main knows.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  DoricDrawioV1,
  DRAWIO_ORIGIN,
  type DrawioDescription,
} from 'bundle/contracts';
import {
  createPrincipal,
  PLATFORM_VERSION,
  ServiceDirectory,
} from 'bundle/runtime';

import {
  DRAWIO_HOST,
  type DrawioOriginDeps,
  describeDrawio,
  type HandlerRegistry,
  isDrawioOriginUrl,
  registerDrawioOrigin,
  respondDrawio,
  startDrawioOrigin,
} from '../src/platform/drawio';
import { provideBroker } from '../src/platform/generation/broker';
import { silentLog } from '../src/platform/log';
import { drawioCsp } from '../src/platform/protocol/csp';

const EDITOR = 'https://drawio.doric.invalid';

const INDEX_HTML = '<!doctype html><title>draw.io</title>';
const APP_JS = 'void 0;';
const SHAPES_XML = '<shapes/>';

let base: string;
let root: string;

const passThroughFails = async (): Promise<Response> => {
  throw new Error('passThrough must not be called for the editor host');
};

const deps = (overrides: Partial<DrawioOriginDeps> = {}): DrawioOriginDeps => ({
  root,
  passThrough: passThroughFails,
  ...overrides,
});

const get = (url: string, init?: RequestInit) =>
  respondDrawio(new Request(url, init), deps());

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'doric-drawio-'));
  root = join(base, 'drawio');
  await mkdir(join(root, 'webapp', 'js', 'nested'), { recursive: true });
  await mkdir(join(root, 'webapp', 'stencils'), { recursive: true });
  await writeFile(join(root, 'webapp', 'index.html'), INDEX_HTML);
  await writeFile(join(root, 'webapp', 'js', 'app.min.js'), APP_JS);
  await writeFile(join(root, 'webapp', 'stencils', 'basic.xml'), SHAPES_XML);
  // Inside the drawio root but outside webapp/: never served.
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({ version: '32.6.1', files: {} }),
  );
  // Outside the drawio root altogether.
  await writeFile(join(base, 'doric-drawio-secret.txt'), 'outside');
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('the editor origin serves the vendored webapp', () => {
  test('the editor document is HTML under the editor policy, never sniffed nor cached', async () => {
    const response = await get(`${EDITOR}/index.html`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html');
    assert.equal(response.headers.get('content-security-policy'), drawioCsp);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(await response.text(), INDEX_HTML);
  });

  test('a script is JavaScript without a policy, never sniffed nor cached', async () => {
    const response = await get(`${EDITOR}/js/app.min.js`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/javascript');
    assert.equal(response.headers.get('content-security-policy'), null);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(await response.text(), APP_JS);
  });

  test('a shape library is application/xml', async () => {
    const response = await get(`${EDITOR}/stencils/basic.xml`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/xml');
    assert.equal(await response.text(), SHAPES_XML);
  });

  test('a path outside the webapp, a missing file or a directory is a 404', async () => {
    for (const url of [
      `${EDITOR}/../manifest.json`,
      `${EDITOR}/%2e%2e/manifest.json`,
      `${EDITOR}/js/%2e%2e/%2e%2e/manifest.json`,
      `${EDITOR}/..%2fmanifest.json`,
      `${EDITOR}/%2e%2e/%2e%2e/doric-drawio-secret.txt`,
      `${EDITOR}/..%2f..%2fdoric-drawio-secret.txt`,
      `${EDITOR}/..%5c..%5cdoric-drawio-secret.txt`,
      `${EDITOR}/missing.js`,
      `${EDITOR}/js/missing.js`,
      `${EDITOR}/js`,
      `${EDITOR}/js/`,
      `${EDITOR}/js/nested/`,
    ]) {
      const response = await get(url);

      assert.equal(response.status, 404, url);
      assert.equal(
        response.headers.get('x-content-type-options'),
        'nosniff',
        url,
      );
      assert.equal(response.headers.get('cache-control'), 'no-cache', url);

      const body = await response.text();

      assert.ok(!body.includes('outside'), url);
      assert.ok(!body.includes('32.6.1'), url);
    }
  });

  test('a method other than GET or HEAD is a 405', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await get(`${EDITOR}/index.html`, {
        method,
        body: 'x',
      });

      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('cache-control'), 'no-cache');
    }
  });

  test('HEAD answers with the headers of GET and no body', async () => {
    const response = await get(`${EDITOR}/index.html`, { method: 'HEAD' });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html');
    assert.equal(response.headers.get('content-security-policy'), drawioCsp);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(await response.text(), '');
  });
});

describe('every other host is untouched', () => {
  test('a request to another host goes through once, its answer comes back as is, and no file is read', async () => {
    const request = new Request('https://example.com/x');
    const answer = new Response('from the network', { status: 203 });
    const passed: Request[] = [];
    const read: string[] = [];

    const response = await respondDrawio(request, {
      root,
      passThrough: async (forwarded) => {
        passed.push(forwarded);

        return answer;
      },
      readFile: async (path) => {
        read.push(path);

        return new Uint8Array();
      },
    });

    assert.equal(response, answer);
    assert.equal(passed.length, 1);
    assert.equal(passed[0], request);
    assert.deepEqual(read, []);
  });
});

describe('registering the origin', () => {
  test("registers the 'https' scheme, whose handler answers as the origin does", async () => {
    const handlers = new Map<string, (request: Request) => Promise<Response>>();
    const registry: HandlerRegistry = {
      handle: (scheme, handler) => {
        handlers.set(scheme, handler);
      },
    };

    registerDrawioOrigin(registry, deps());

    assert.deepEqual([...handlers.keys()], ['https']);

    const handler = handlers.get('https') as (
      request: Request,
    ) => Promise<Response>;
    const viaHandler = await handler(new Request(`${EDITOR}/index.html`));
    const direct = await get(`${EDITOR}/index.html`);

    assert.equal(viaHandler.status, direct.status);
    assert.equal(
      viaHandler.headers.get('content-type'),
      direct.headers.get('content-type'),
    );
    assert.equal(
      viaHandler.headers.get('content-security-policy'),
      direct.headers.get('content-security-policy'),
    );
    assert.equal(await viaHandler.text(), await direct.text());

    const missing = await handler(new Request(`${EDITOR}/missing.js`));

    assert.equal(missing.status, 404);
  });

  test('a registration that throws makes the editor unavailable, handler-failed, without rejecting', async () => {
    const registry: HandlerRegistry = {
      handle: () => {
        throw new Error('scheme already handled');
      },
    };

    assert.deepEqual(await startDrawioOrigin(registry, deps()), {
      available: false,
      reason: 'handler-failed',
    });
  });

  test('a registration that succeeds describes the vendored webapp', async () => {
    const registry: HandlerRegistry = { handle: () => undefined };

    assert.deepEqual(await startDrawioOrigin(registry, deps()), {
      available: true,
      version: '32.6.1',
    });
  });
});

describe('isDrawioOriginUrl', () => {
  test('is true for the editor origin, whatever the path or query', () => {
    for (const url of [
      EDITOR,
      `${EDITOR}/`,
      `${EDITOR}/index.html`,
      `${EDITOR}/index.html?embed=1&proto=json`,
      `${EDITOR}/js/nested/page.html#x`,
    ]) {
      assert.equal(isDrawioOriginUrl(url), true, url);
    }
  });

  test('is false for another scheme, port, subdomain, superdomain or garbage', () => {
    for (const url of [
      'http://drawio.doric.invalid/',
      'https://drawio.doric.invalid:8443/',
      'https://sub.drawio.doric.invalid/',
      'https://doric.invalid/',
      'https://drawio.doric.invalid.evil.example/',
      'https://evil.example/drawio.doric.invalid/',
      'doric://app/frame/index.html',
      'not a url',
      '',
    ]) {
      assert.equal(isDrawioOriginUrl(url), false, url);
    }
  });

  test('the host is the one of DRAWIO_ORIGIN', () => {
    assert.equal(DRAWIO_HOST, new URL(DRAWIO_ORIGIN).host);
    assert.equal(DRAWIO_HOST, 'drawio.doric.invalid');
  });
});

describe('describeDrawio', () => {
  const rootWith = async (manifest: string | undefined): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'doric-drawio-describe-'));

    if (manifest !== undefined) {
      await writeFile(join(dir, 'manifest.json'), manifest);
    }

    return dir;
  };

  test('without a manifest, the assets are missing', async () => {
    const dir = await rootWith(undefined);

    try {
      assert.deepEqual(await describeDrawio(dir), {
        available: false,
        reason: 'missing-assets',
      });
      assert.deepEqual(await describeDrawio(join(dir, 'absent')), {
        available: false,
        reason: 'missing-assets',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a malformed manifest counts as missing assets', async () => {
    for (const manifest of [
      'not json',
      'null',
      '[]',
      '{}',
      JSON.stringify({ files: {} }),
      JSON.stringify({ version: '', files: {} }),
      JSON.stringify({ version: 32, files: {} }),
    ]) {
      const dir = await rootWith(manifest);

      try {
        assert.deepEqual(
          await describeDrawio(dir),
          { available: false, reason: 'missing-assets' },
          manifest,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test('a valid manifest makes the editor available at its version', async () => {
    const dir = await rootWith(
      JSON.stringify({
        version: '32.6.1',
        files: { 'index.html': 'a'.repeat(64) },
      }),
    );

    try {
      assert.deepEqual(await describeDrawio(dir), {
        available: true,
        version: '32.6.1',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('doric.drawio/v1 (broker)', () => {
  test("answers describe with main's description", async () => {
    const principal = createPrincipal(
      {
        directory: new ServiceDirectory(),
        catalog: {
          cardinality: () => undefined,
          activeProvider: () => undefined,
        },
        environment: 'desktopMain',
        generation: 0,
        generationSignal: new AbortController().signal,
        report: () => undefined,
      },
      {
        bundleId: 'doric',
        version: PLATFORM_VERSION,
        provides: 'any',
        requires: 'any',
      },
    );
    const description: DrawioDescription = {
      available: true,
      version: '32.6.1',
    };

    provideBroker(principal, {
      windows: {
        open: async () => undefined,
        focusOrOpen: async () => undefined,
        lastPath: () => null,
        focus: () => false,
        navigate: async () => undefined,
        capture: async () => {
          throw new Error('unused');
        },
      },
      menus: {
        setSkeleton: () => undefined,
        add: () => undefined,
        addKeybinding: () => undefined,
        setContext: () => undefined,
      },
      cacheDirectory: async () => '/cache',
      migrateStorage: async () => 'none',
      tokens: () => ({}),
      notify: () => undefined,
      drawio: { describe: () => description },
      log: silentLog,
    });

    assert.deepEqual(
      await principal.services.use(DoricDrawioV1).describe(),
      description,
    );
  });
});
