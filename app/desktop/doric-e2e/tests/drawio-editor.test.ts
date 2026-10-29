// Phase 0 of docs/designs/threads-drawio-diagrams.md: the vendored draw.io
// editor at `https://drawio.doric.invalid`, framed by a real app window
// with no name resolution at all (run.ts blocks it for this file). The test
// page speaks the embed JSON protocol to the editor directly
// (`proto=json`): configure, init, load, merge, autosave and export. It
// proves A1 (embed mode without network), A2 (the editor under its CSP),
// A3 (a `data-cell-id` for every cell) and A4 (shape libraries without
// network), and measures the editor's memory and cold start times.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { DRAWIO_ORIGIN } from 'bundle/contracts';
import { app, net, protocol, session, type WebContents } from 'electron';
import { buildSync } from 'esbuild';

import { coreDistribution } from '../../doric/tests/support/core';
import {
  type Booted,
  bootPlatform,
  type CspIssueLog,
  cspIssues,
  editorFrame,
  type FakeHost,
  MAIN_DIR,
  page,
  type RequestLog,
  recordRequests,
  startFakeHost,
} from './support/harness';

/** The modal's editor parameters (spec, "O modal do diagrama"). */
const MODAL_PARAMS =
  'embed=1&proto=json&configure=1&stealth=1&lockdown=1&pwa=0&noSaveBtn=1&noExitBtn=1&saveAndExit=0&ui=min&dark=0&lang=pt-br';
/** The hidden renderer's editor parameters (spec, "Renderizador"). */
const RENDERER_PARAMS =
  'embed=1&proto=json&configure=1&stealth=1&lockdown=1&pwa=0&noSaveBtn=1&noExitBtn=1&saveAndExit=0&spin=0&dark=0';
const EDITOR_CONFIG = { suppressNewWindows: true, compressXml: false };
/**
 * The query of `editorUrl('light')` in
 * `bundles/features/drawio/src/client/editor-frame.tsx`, copied: a package
 * import of `drawio` would make the e2e project depend on the bundle's.
 */
const MODAL_URL_QUERY =
  'spin=1&stealth=1&lockdown=1&pwa=0&noSaveBtn=1&noExitBtn=1&saveAndExit=0&ui=min&dark=0&lang=pt-br&embed=1&proto=json&configure=1';
/** `EDITOR_CONFIG` of `bundles/features/drawio/src/client/editor-frame.tsx`, copied. */
const MODAL_EDITOR_CONFIG = {
  suppressNewWindows: true,
  compressXml: false,
  passThroughKeys: [{ key: 's', ctrl: true, command: 'save' }],
};

/** The budget for the renderer and the modal editor together. */
const MEMORY_LIMIT_MB = 400;
const INIT_P95_LIMIT_MS = 5_000;
const COLD_MOUNTS = 20;

const cell = (
  id: string,
  attributes: string,
  geometry = '<mxGeometry x="20" y="20" width="120" height="60" as="geometry"/>',
) => `<mxCell id="${id}" ${attributes}>${geometry}</mxCell>`;

const diagram = (id: string, cells: readonly string[]) =>
  `<diagram id="${id}" name="${id}"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel></diagram>`;

/** Shapes, a connector and a group on page one; a shape and a connector on page two. */
const PAGE_ONE_CELLS = ['a', 'b', 'ab', 'grp', 'g1', 'g2'] as const;
const PAGE_TWO_CELLS = ['c', 'd', 'cd'] as const;
const PAGE_ONE_REST = [
  cell(
    'b',
    'value="B" style="ellipse;" vertex="1" parent="1"',
    '<mxGeometry x="240" y="20" width="120" height="60" as="geometry"/>',
  ),
  cell(
    'ab',
    'style="endArrow=classic;" edge="1" source="a" target="b" parent="1"',
    '<mxGeometry relative="1" as="geometry"/>',
  ),
  cell(
    'grp',
    'value="" style="group;" vertex="1" connectable="0" parent="1"',
    '<mxGeometry x="20" y="140" width="220" height="100" as="geometry"/>',
  ),
  cell(
    'g1',
    'value="G1" style="rounded=0;" vertex="1" parent="grp"',
    '<mxGeometry width="80" height="40" as="geometry"/>',
  ),
  cell(
    'g2',
    'value="G2" style="rounded=0;" vertex="1" parent="grp"',
    '<mxGeometry x="140" y="60" width="80" height="40" as="geometry"/>',
  ),
];
const PAGE_ONE = diagram('page-1', [
  cell('a', 'value="A" style="rounded=1;" vertex="1" parent="1"'),
  ...PAGE_ONE_REST,
]);
const PAGE_TWO = diagram('page-2', [
  cell('c', 'value="C" vertex="1" parent="1"'),
  cell(
    'd',
    'value="D" style="rhombus;" vertex="1" parent="1"',
    '<mxGeometry x="240" y="20" width="80" height="80" as="geometry"/>',
  ),
  cell(
    'cd',
    'edge="1" source="c" target="d" parent="1"',
    '<mxGeometry relative="1" as="geometry"/>',
  ),
]);
const TWO_PAGES = `<mxfile>${PAGE_ONE}${PAGE_TWO}</mxfile>`;

/** Page one of TWO_PAGES with shape `a` moved to x=300. */
const MOVED = `<mxfile>${diagram('page-1', [
  cell(
    'a',
    'value="A" style="rounded=1;" vertex="1" parent="1"',
    '<mxGeometry x="300" y="20" width="120" height="60" as="geometry"/>',
  ),
  ...PAGE_ONE_REST,
])}</mxfile>`;

const MERGED = `<mxfile>${diagram('page-1', [
  cell(
    'merged',
    'value="merged" vertex="1" parent="1"',
    '<mxGeometry x="400" y="20" width="80" height="40" as="geometry"/>',
  ),
])}</mxfile>`;

/** An AWS shape from `shapes/` and an image from `img/lib/`. */
const libraries = (image: string) =>
  `<mxfile>${diagram('libraries', [
    cell(
      'lambda',
      'value="" style="sketch=0;outlineConnect=0;fontColor=#232F3E;fillColor=#ED7100;strokeColor=none;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;aspect=fixed;shape=mxgraph.aws4.lambda_function;" vertex="1" parent="1"',
      '<mxGeometry x="20" y="20" width="78" height="78" as="geometry"/>',
    ),
    cell(
      'picture',
      `value="" style="shape=image;aspect=fixed;image=${DRAWIO_ORIGIN}/${image};" vertex="1" parent="1"`,
      '<mxGeometry x="160" y="20" width="60" height="60" as="geometry"/>',
    ),
  ])}</mxfile>`;

/** An editor message as the page received it, with its arrival time. */
interface EditorMessage {
  readonly event: string;
  readonly at: number;
  readonly xml?: string;
  readonly data?: string;
  readonly format?: string;
  readonly [key: string]: unknown;
}

/** The page side of the protocol: mounts editors and talks to them. */
const PAGE_DRIVER = `
window.__drawio = (() => {
  const origin = ${JSON.stringify(DRAWIO_ORIGIN)};
  const defaultConfig = ${JSON.stringify(EDITOR_CONFIG)};
  const editors = new Map();

  window.addEventListener('message', (event) => {
    if (event.origin !== origin) return;
    const editor = [...editors.values()].find((e) => e.iframe.contentWindow === event.source);
    if (editor === undefined || typeof event.data !== 'string') return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    editor.messages.push({ ...message, at: performance.now() - editor.mountedAt });
    if (message.event === 'configure') {
      event.source.postMessage(JSON.stringify({ action: 'configure', config: editor.config }), origin);
    }
  });

  const next = (editor, from, name, timeoutMs) => new Promise((done, fail) => {
    const started = performance.now();
    const tick = () => {
      const found = editor.messages.slice(from).find((m) => m.event === name);
      if (found !== undefined) return done(found);
      if (performance.now() - started > timeoutMs) {
        return fail(new Error('no ' + name + ' from the editor in ' + timeoutMs + ' ms'));
      }
      setTimeout(tick, 10);
    };
    tick();
  });

  return {
    mount(name, params, hidden, config) {
      const iframe = document.createElement('iframe');
      iframe.name = name;
      iframe.title = 'Editor de diagrama';
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      iframe.style.cssText = hidden
        ? 'position:fixed;left:-10000px;top:0;width:800px;height:600px;visibility:hidden'
        : 'position:fixed;left:0;top:0;width:800px;height:600px';
      if (hidden) {
        iframe.setAttribute('aria-hidden', 'true');
        iframe.tabIndex = -1;
      }
      const url = origin + '/index.html?' + params;
      const editor = {
        iframe,
        url,
        config: config ?? defaultConfig,
        messages: [],
        mountedAt: performance.now(),
      };
      editors.set(name, editor);
      iframe.src = url;
      document.body.append(iframe);
    },
    unmount(name) {
      editors.get(name)?.iframe.remove();
      editors.delete(name);
    },
    messages(name) {
      return editors.get(name)?.messages ?? [];
    },
    mark(name) {
      return editors.get(name).messages.length;
    },
    waitFor(name, event, timeoutMs, from = 0) {
      return next(editors.get(name), from, event, timeoutMs);
    },
    reload(name) {
      const editor = editors.get(name);
      editor.iframe.setAttribute('src', editor.url);
    },
    request(name, action, event, timeoutMs) {
      const editor = editors.get(name);
      const from = editor.messages.length;
      editor.iframe.contentWindow.postMessage(JSON.stringify(action), origin);
      return next(editor, from, event, timeoutMs);
    },
  };
})();
void 0;
`;

let host: FakeHost;
let booted: Booted;
let userData: string;
let contents: WebContents;
let requests: RequestLog;
let csp: CspIssueLog;

const driver = <T>(call: string): Promise<T> =>
  page<T>(contents, `window.__drawio.${call}`);

const mount = (
  name: string,
  params = MODAL_PARAMS,
  hidden = false,
  config?: Record<string, unknown>,
) =>
  driver<void>(
    `mount(${JSON.stringify(name)}, ${JSON.stringify(params)}, ${hidden}${config === undefined ? '' : `, ${JSON.stringify(config)}`})`,
  );

const unmount = (name: string) =>
  driver<void>(`unmount(${JSON.stringify(name)})`);

const waitFor = (name: string, event: string, timeoutMs = 30_000, from = 0) =>
  driver<EditorMessage>(
    `waitFor(${JSON.stringify(name)}, ${JSON.stringify(event)}, ${timeoutMs}, ${from})`,
  );

/** The number of messages `name` has received so far. */
const mark = (name: string) => driver<number>(`mark(${JSON.stringify(name)})`);

/** Sets the editor iframe's `src` again to its URL, as `DrawioClient.reload` does. */
const reload = (name: string) =>
  driver<void>(`reload(${JSON.stringify(name)})`);

const request = (
  name: string,
  action: Record<string, unknown>,
  event: string,
  timeoutMs = 30_000,
) =>
  driver<EditorMessage>(
    `request(${JSON.stringify(name)}, ${JSON.stringify(action)}, ${JSON.stringify(event)}, ${timeoutMs})`,
  );

const messagesOf = (name: string) =>
  driver<EditorMessage[]>(`messages(${JSON.stringify(name)})`);

/** The SVG text of an `export` answer's data URL. */
const svgOf = (answer: EditorMessage): string => {
  const data = String(answer.data ?? '');
  const comma = data.indexOf(',');
  const header = data.slice(0, comma);

  assert.match(header, /^data:image\/svg\+xml/u);

  return header.endsWith(';base64')
    ? Buffer.from(data.slice(comma + 1), 'base64').toString('utf8')
    : decodeURIComponent(data.slice(comma + 1));
};

/** Evaluates `query(doc)` on the SVG parsed in the shell page. */
const inSvg = <T>(svg: string, query: string): Promise<T> =>
  page<T>(
    contents,
    `(() => { const doc = new DOMParser().parseFromString(${JSON.stringify(svg)}, 'image/svg+xml'); return (${query})(doc); })()`,
  );

/** Mounts an editor and answers configure until init. */
const ready = async (name: string, params = MODAL_PARAMS, hidden = false) => {
  await mount(name, params, hidden);

  return waitFor(name, 'init');
};

/** The modal editor driven once through the whole protocol (criterion 2). */
let exercise: Promise<{
  readonly messages: EditorMessage[];
  readonly loaded: EditorMessage;
  readonly autosave: EditorMessage;
  readonly svg: EditorMessage;
  readonly xmlsvg: EditorMessage;
}>;
const exercised = () => {
  exercise ??= (async () => {
    await ready('main');

    const loaded = await request(
      'main',
      { action: 'load', xml: TWO_PAGES, autosave: 1 },
      'load',
    );
    const autosave = await request(
      'main',
      { action: 'merge', xml: MERGED },
      'autosave',
    );
    const svg = await request(
      'main',
      { action: 'export', format: 'svg' },
      'export',
    );
    const xmlsvg = await request(
      'main',
      { action: 'export', format: 'xmlsvg' },
      'export',
    );

    return {
      messages: await messagesOf('main'),
      loaded,
      autosave,
      svg,
      xmlsvg,
    };
  })();

  return exercise;
};

const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((x, y) => x - y);

  return sorted[
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  ] as number;
};

const ms = (value: number) => `${Math.round(value)} ms`;

/** The renderer's run (spec "Renderizador", C10): exports per cold editor and its budget. */
const RENDER_RUN_EXPORTS = 30;
const RENDER_RUN_LIMIT_MS = 10_000;

/** The renderer's export request for one page (D22): a whole single-page mxfile. */
const exportOf = (xml: string) => ({
  action: 'export',
  format: 'svg',
  xml,
  keepTheme: false,
  embedImages: true,
  embedFonts: false,
});

/** TWO_PAGES with every label numbered `run`, so no two runs draw the same diagram. */
const numbered = (run: number) =>
  TWO_PAGES.replace(
    /value="([^"]+)"/gu,
    (_, label) => `value="${label} ${run}"`,
  );

let singlePage: string | undefined;

/** drawio's `src/client/single-page.ts`, bundled alone as an IIFE (`__drawioSinglePage`). */
const singlePageSource = (): string => {
  singlePage ??= buildSync({
    // A path from the repository root (the run's working directory), as
    // harness.ts resolves its fixtures: a package import of `drawio` would
    // make the e2e project depend on the bundle's.
    entryPoints: [resolve('bundles/features/drawio/src/client/single-page.ts')],
    bundle: true,
    format: 'iife',
    globalName: '__drawioSinglePage',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  }).outputFiles[0]?.text;

  assert.ok(singlePage !== undefined, 'single-page.ts bundled');

  return singlePage;
};

/** Evaluates `expression` in the shell page. */
const inPage = <T>(expression: string): Promise<T> =>
  page<T>(contents, expression);

let singlePageLoaded: Promise<void> | undefined;

/** The real `singlePageOf`, run under the shell page's DOMParser. */
const singlePageOf = async (xml: string, pageId?: string): Promise<string> => {
  singlePageLoaded ??= inPage<void>(`${singlePageSource()}\nvoid 0;`);
  await singlePageLoaded;

  const call = `__drawioSinglePage.singlePageOf(${JSON.stringify(xml)}${pageId === undefined ? '' : `, ${JSON.stringify(pageId)}`})`;
  // executeJavaScript hides a thrown error's message: the page returns it.
  const answer = await inPage<{ xml?: string; error?: string }>(
    `(() => { try { return { xml: ${call} }; } catch (error) { return { error: String(error) }; } })()`,
  );

  if (answer.error !== undefined) throw new Error(answer.error);

  return String(answer.xml);
};

/** The requests from index `from` on to anything but doric://app or the editor origin. */
const foreignRequests = (from = 0) => {
  const local = (url: string): boolean => {
    const inner = url.startsWith('blob:') ? url.slice('blob:'.length) : url;

    return (
      inner.startsWith('doric://app/') ||
      inner === DRAWIO_ORIGIN ||
      inner.startsWith(`${DRAWIO_ORIGIN}/`)
    );
  };

  return requests.requests.slice(from).filter(({ url }) => !local(url));
};

/** The `x` of `mxCell#id > mxGeometry` in `xml`, parsed in the shell page. */
const xOf = (xml: string, id: string): Promise<string | null> =>
  inPage<string | null>(
    `(() => { const doc = new DOMParser().parseFromString(${JSON.stringify(xml)}, 'text/xml'); const geometry = doc.querySelector(${JSON.stringify(`mxCell[id="${id}"] > mxGeometry`)}); return geometry === null ? null : geometry.getAttribute('x'); })()`,
  );

describe('the draw.io editor origin in an app window', () => {
  before(async () => {
    userData = await mkdtemp(join(tmpdir(), 'doric-electron-drawio-'));
    host = await startFakeHost(await coreDistribution());
    booted = await bootPlatform({ host, userData });
    contents = (await booted.window('workspace')).webContents;
    requests = recordRequests();
    csp = await cspIssues(contents);
    await page(contents, PAGE_DRIVER);
  });

  after(async () => {
    csp?.stop();
    requests?.stop();
    await booted?.dispose().catch(() => undefined);
    await host?.close();
    await rm(userData, { recursive: true, force: true });
  });

  test('speaks the embed protocol: configure, init, load, merge with autosave, export svg and xmlsvg', async () => {
    const { messages, loaded, autosave, svg, xmlsvg } = await exercised();
    const events = messages.map((message) => message.event);

    assert.ok(events.includes('configure'), events.join(','));
    assert.ok(
      events.indexOf('configure') < events.indexOf('init'),
      events.join(','),
    );
    assert.equal(loaded.event, 'load');
    assert.match(String(autosave.xml), /id="merged"/u);
    assert.equal(svg.event, 'export');
    assert.match(svgOf(svg), /<svg[\s>]/u);
    assert.equal(xmlsvg.event, 'export');
    assert.match(svgOf(xmlsvg), /content="[^"]*mxfile/u);
  });

  test('every cell with a geometry has a data-cell-id in the svg export of its own page, on both pages (A3)', async () => {
    await exercised();

    // draw.io's svg export draws the current page only, so each page is
    // rendered from an mxfile that holds just that page's <diagram>.
    const pages = [
      { page: PAGE_ONE, ids: PAGE_ONE_CELLS, others: PAGE_TWO_CELLS },
      { page: PAGE_TWO, ids: PAGE_TWO_CELLS, others: PAGE_ONE_CELLS },
    ] as const;

    for (const { page: single, ids, others } of pages) {
      await request(
        'main',
        { action: 'load', xml: `<mxfile>${single}</mxfile>`, autosave: 1 },
        'load',
      );

      const answer = await request(
        'main',
        { action: 'export', format: 'svg' },
        'export',
      );
      const found = await inSvg<string[]>(
        svgOf(answer),
        `(doc) => [...doc.querySelectorAll('[data-cell-id]')].map((e) => e.getAttribute('data-cell-id'))`,
      );
      const label = `${ids.join(',')} -> ${found.join(',')}`;

      for (const id of ids) {
        assert.ok(found.includes(id), `${id} missing: ${label}`);
      }
      for (const id of others) {
        assert.ok(!found.includes(id), `${id} from another page: ${label}`);
      }
    }
  });

  test('draws a shapes/ library shape and embeds an img/lib/ image without network (A4)', async () => {
    await exercised();

    const manifest = JSON.parse(
      await readFile(
        join(MAIN_DIR, 'assets', 'drawio', 'manifest.json'),
        'utf8',
      ),
    ) as { files: Record<string, string> };
    const image = Object.keys(manifest.files)
      .filter((path) => /^img\/lib\/.+\.(svg|png)$/u.test(path))
      .sort()[0];

    assert.ok(image !== undefined, 'the webapp has an img/lib/ image');

    await request(
      'main',
      { action: 'load', xml: libraries(image), autosave: 1 },
      'load',
    );

    const answer = await request(
      'main',
      { action: 'export', format: 'svg', embedImages: true },
      'export',
    );
    const drawn = await inSvg<{ paths: number; image: string | null }>(
      svgOf(answer),
      `(doc) => {
         const lambda = doc.querySelector('[data-cell-id="lambda"]');
         const picture = doc.querySelector('[data-cell-id="picture"] image');
         return {
           paths: lambda === null ? 0 : lambda.querySelectorAll('path').length,
           image: picture === null ? null : (picture.getAttribute('href') ?? picture.getAttribute('xlink:href')),
         };
       }`,
    );

    console.log(`# drawio libraries: ${image}, lambda paths ${drawn.paths}`);
    assert.ok(drawn.paths > 0, 'mxgraph.aws4.lambda_function has a <path>');
    assert.match(String(drawn.image), /^data:image\//u);
  });

  test('every request is doric://app or the editor origin, and the editor origin answers no 404 (A1)', async () => {
    await exercised();

    const foreign = foreignRequests();
    const missing = requests.responses.filter(
      ({ url, statusCode }) =>
        url.startsWith(`${DRAWIO_ORIGIN}/`) && statusCode === 404,
    );

    console.log(`# drawio requests: ${requests.requests.length}`);
    assert.deepEqual(foreign, []);
    assert.ok(
      requests.requests.some(({ url }) =>
        url.startsWith(`${DRAWIO_ORIGIN}/index.html`),
      ),
      'the editor document was requested',
    );
    assert.deepEqual(missing, []);
  });

  test('another https host is passed through by the handler unchanged and fails unanswered', async () => {
    const url = 'https://other.invalid/';
    const from = requests.requests.length;

    assert.equal(protocol.isProtocolHandled('https'), true);
    await assert.rejects(net.fetch(url), (error) => error instanceof Error);

    const forwarded = requests.requests
      .slice(from)
      .filter((entry) => entry.url === url);

    assert.ok(forwarded.length > 0, `${url} went out to the network`);
    assert.deepEqual(
      requests.responses.filter((entry) => entry.url === url),
      [],
    );
  });

  test('the editor raises no CSP issue beyond inline or eval script-src (A2)', async () => {
    await exercised();

    const unexpected = csp.issues.filter(
      (issue) =>
        !(
          issue.violatedDirective.startsWith('script-src') &&
          (issue.violationType === 'kInlineViolation' ||
            issue.violationType === 'kEvalViolation')
        ),
    );

    console.log(`# drawio csp issues: ${JSON.stringify(csp.issues)}`);
    assert.deepEqual(unexpected, []);
  });

  test('two editors open at once stay within the memory budget (D14)', async () => {
    await exercised();
    await unmount('main');

    const use = async (name: string) => {
      await request(
        name,
        { action: 'load', xml: TWO_PAGES, autosave: 1 },
        'load',
      );
      await request(name, { action: 'export', format: 'svg' }, 'export');
      await request(
        name,
        { action: 'load', xml: TWO_PAGES, autosave: 1 },
        'load',
      );
    };

    await ready('renderer', RENDERER_PARAMS, true);
    await use('renderer');

    const alone = editorFrame(contents, 'renderer');

    assert.ok(alone !== undefined, 'the renderer editor frame');

    const one = app
      .getAppMetrics()
      .find((entry) => entry.pid === alone.osProcessId);

    assert.ok(one !== undefined, 'the renderer editor process');
    console.log(
      `# drawio memory one-editor (${process.platform} ${process.arch}, Electron ${process.versions.electron}): renderer pid ${alone.osProcessId} ${(one.memory.workingSetSize / 1024).toFixed(1)} MB`,
    );

    await ready('modal');
    await use('modal');

    const metrics = app.getAppMetrics();
    const measured = ['renderer', 'modal'].map((name) => {
      const frame = editorFrame(contents, name);

      assert.ok(frame !== undefined, `the ${name} editor frame`);

      const metric = metrics.find((entry) => entry.pid === frame.osProcessId);

      assert.ok(metric !== undefined, `the ${name} editor process`);

      return {
        name,
        pid: frame.osProcessId,
        mb: metric.memory.workingSetSize / 1024,
      };
    });

    console.log(
      `# drawio memory two-editor (${process.platform} ${process.arch}, Electron ${process.versions.electron}): ${measured
        .map(({ name, pid, mb }) => `${name} pid ${pid} ${mb.toFixed(1)} MB`)
        .join(', ')}`,
    );

    // Both editors share one origin and may share one process: count each
    // process once.
    const total = [
      ...new Map(measured.map(({ pid, mb }) => [pid, mb])).values(),
    ].reduce((sum, mb) => sum + mb, 0);

    assert.ok(
      total <= MEMORY_LIMIT_MB,
      `two editors together: ${total.toFixed(1)} MB > ${MEMORY_LIMIT_MB} MB`,
    );

    await unmount('renderer');
    await unmount('modal');
  });

  test('cold mounts reach init, the first load and the first export in time', {
    timeout: 20 * 60_000,
  }, async () => {
    await exercised();

    const init: number[] = [];
    const load: number[] = [];
    const exported: number[] = [];

    for (let run = 0; run < COLD_MOUNTS; run += 1) {
      const name = `cold-${run}`;

      await session.defaultSession.clearCache();

      const initialized = await ready(name, RENDERER_PARAMS, true);
      const loaded = await request(
        name,
        { action: 'load', xml: TWO_PAGES, autosave: 1 },
        'load',
      );
      const answered = await request(
        name,
        { action: 'export', format: 'svg' },
        'export',
      );

      init.push(initialized.at);
      load.push(loaded.at);
      exported.push(answered.at);
      await unmount(name);
    }

    console.log(
      `# drawio cold start (${COLD_MOUNTS} mounts): init p50 ${ms(percentile(init, 50))} p95 ${ms(percentile(init, 95))}; first load p50 ${ms(percentile(load, 50))} p95 ${ms(percentile(load, 95))}; first export p50 ${ms(percentile(exported, 50))} p95 ${ms(percentile(exported, 95))}`,
    );
    assert.ok(
      percentile(init, 95) <= INIT_P95_LIMIT_MS,
      `p95 to init ${ms(percentile(init, 95))}`,
    );
  });

  test('E1: a cold hidden renderer exports 30 single-page mxfiles in time, light then dark (C10)', {
    timeout: 5 * 60_000,
  }, async (t) => {
    for (const dark of [0, 1]) {
      const name = `render-run-${dark}`;
      const params = RENDERER_PARAMS.replace(/dark=0$/u, `dark=${dark}`);
      const pages: string[] = [];

      for (let run = 0; run < RENDER_RUN_EXPORTS; run += 1) {
        pages.push(await singlePageOf(numbered(run), 'page-1'));
      }

      await session.defaultSession.clearCache();

      const started = performance.now();
      const durations: number[] = [];
      const sizes: number[] = [];

      await ready(name, params, true);
      await request(name, { action: 'load' }, 'load');

      for (const xml of pages) {
        const from = performance.now();
        const answer = await request(name, exportOf(xml), 'export');

        durations.push(performance.now() - from);
        sizes.push(svgOf(answer).length);
      }

      const total = performance.now() - started;

      await unmount(name);
      t.diagnostic(
        `drawio render run dark=${dark}: total ${ms(total)}, export p95 ${ms(percentile(durations, 95))}, svg sizes ${Math.min(...sizes)}..${Math.max(...sizes)} chars`,
      );
      assert.ok(
        total < RENDER_RUN_LIMIT_MS,
        `dark=${dark}: ${RENDER_RUN_EXPORTS} exports took ${ms(total)}`,
      );
    }
  });

  test('E2: the export of singlePageOf(P) draws page P and only P (C12)', async () => {
    const name = 'render-pages';
    const pages = [
      { pageId: 'page-1', ids: PAGE_ONE_CELLS, others: PAGE_TWO_CELLS },
      { pageId: 'page-2', ids: PAGE_TWO_CELLS, others: PAGE_ONE_CELLS },
    ] as const;
    const svgs: string[] = [];

    await ready(name, RENDERER_PARAMS, true);
    await request(name, { action: 'load' }, 'load');

    try {
      for (const { pageId, ids, others } of pages) {
        const answer = await request(
          name,
          exportOf(await singlePageOf(TWO_PAGES, pageId)),
          'export',
        );
        const svg = svgOf(answer);
        const found = await inSvg<string[]>(
          svg,
          `(doc) => [...doc.querySelectorAll('[data-cell-id]')].map((e) => e.getAttribute('data-cell-id'))`,
        );
        const label = `${pageId}: ${found.join(',')}`;

        for (const id of ids) {
          assert.ok(found.includes(id), `${id} missing: ${label}`);
        }
        for (const id of others) {
          assert.ok(!found.includes(id), `${id} from another page: ${label}`);
        }
        svgs.push(svg);
      }

      assert.notEqual(svgs[0], svgs[1]);
    } finally {
      await unmount(name);
    }
  });

  test('E3: a merge autosaves the moved shape, and after reload loading that xml brings it back, without network (criterion 10 of phase 3)', async (t) => {
    const name = 'edit';
    // The pass-through test fetches another host on purpose: count only E3's.
    const firstRequest = requests.requests.length;

    await mount(name, MODAL_URL_QUERY, false, MODAL_EDITOR_CONFIG);
    await waitFor(name, 'init');

    try {
      const beforeLoad = await mark(name);

      await request(
        name,
        { action: 'load', xml: TWO_PAGES, autosave: 1 },
        'load',
      );
      // Risk R2: does draw.io autosave right after a load, before any edit?
      await new Promise((done) => setTimeout(done, 1_000));
      const early = (await messagesOf(name))
        .slice(beforeLoad)
        .filter((message) => message.event === 'autosave').length;

      t.diagnostic(`drawio autosaves after load, before merge (R2): ${early}`);

      const autosave = await request(
        name,
        { action: 'merge', xml: MOVED },
        'autosave',
      );
      const saved = String(autosave.xml);

      assert.equal(await xOf(saved, 'a'), '300', saved);

      const beforeReload = await mark(name);

      await reload(name);
      await waitFor(name, 'init', 30_000, beforeReload);
      await request(name, { action: 'load', xml: saved, autosave: 1 }, 'load');

      const exported = await request(
        name,
        { action: 'export', format: 'xml' },
        'export',
      );

      assert.equal(
        await xOf(String(exported.xml), 'a'),
        '300',
        String(exported.xml),
      );
      assert.deepEqual(foreignRequests(firstRequest), []);
    } finally {
      await unmount(name);
    }
  });
});
