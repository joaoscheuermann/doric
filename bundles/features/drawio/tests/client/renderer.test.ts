// The hidden draw.io editor that draws a page as SVG (renderer.ts, spec
// "Renderizador"), the single-page `mxfile` it exports (single-page.ts) and
// the draw that renders, measures and stores one page (drawing.ts).
//
// The editor is the real boundary: `createClient` is a fake `DrawioClient`
// that records what the renderer asks and answers as the editor would (a
// data URI, or a `DrawioError`). The iframe goes into a happy-dom document.
//
// Contract matrix (plan §4, renderer.test rows 1–12):
// - `singlePageOf`: the root's attributes minus `pages`, one `<diagram>`
//   serialized as in the source; the first page without `pageId`;
//   `invalid-xml` for an unknown page, a root that is not `mxfile`, no page;
// - one `export` per request with the single-page XML and no `pageId` key;
//   the SVG text from a base64 or URI-encoded data URI;
// - serial requests; one hidden iframe; a theme change replaces the pair;
// - editor refusals are `invalid-xml` and keep the pair; timeouts and
//   restarts are `unavailable` and drop it; an idle pair is dropped;
// - `drawPage` renders, measures, stores (with `first` when asked, D1–D2),
//   and ignores a failing store;
// - `sha256Hex` is the SHA-256 of the UTF-8 bytes.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { DrawioError } from '@drawio/react';
import { DRAWIO_ORIGIN } from 'bundle/contracts';

import { drawPage, sha256Hex } from '../../src/client/drawing.js';
import {
  createRenderer,
  RenderError,
  type Renderer,
  type RendererClient,
  type RendererClientOptions,
  type RendererExportRequest,
  type RenderRequest,
  rendererUrl,
  singlePageOf,
} from '../../src/client/renderer.js';
import type {
  DiagramLayout,
  DiagramSvgKey,
} from '../../src/contracts/index.js';
import { closeDom, iframes, settle, window } from './support/dom.js';

after(closeDom);

const parser = () => new window.DOMParser();
const serialize = (node: unknown) =>
  new window.XMLSerializer().serializeToString(node as never);

const PAGE_ONE =
  '<diagram id="p1" name="One"><mxGraphModel dx="10"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="A" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram>';
const PAGE_TWO =
  '<diagram id="p2" name="Two"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="b" value="B &amp; ç" vertex="1" parent="1"><mxGeometry x="10" y="20" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram>';
const TWO_PAGES = `<mxfile host="x" pages="2" agent="test">${PAGE_ONE}${PAGE_TWO}</mxfile>`;

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><g data-cell-id="b"><text>B &amp; ç</text></g></svg>';

const base64Uri = (svg: string) =>
  `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
const encodedUri = (svg: string) =>
  `data:image/svg+xml,${encodeURIComponent(svg)}`;

const isCode =
  (code: RenderError['code']) =>
  (error: unknown): boolean =>
    error instanceof RenderError && error.code === code;

/** The diagram element `id` of `xml`, parsed. */
const diagramOf = (xml: string, id: string): Element => {
  const found = [
    ...parser()
      .parseFromString(xml, 'application/xml')
      .getElementsByTagName('diagram'),
  ].find((element) => element.getAttribute('id') === id);

  assert.ok(found, `a <diagram id="${id}">`);

  return found as unknown as Element;
};

/** A fake `DrawioClient`, as far as the renderer reaches it. */
interface FakeClient extends RendererClient {
  readonly iframe: HTMLIFrameElement;
  readonly options: RendererClientOptions;
  readonly requests: RendererExportRequest[];
  closed: boolean;
}

type Answer = (
  request: RendererExportRequest,
  client: FakeClient,
) => Promise<{ readonly data?: unknown }>;

const svgAnswer: Answer = async () => ({ data: base64Uri(SVG) });

/** A `createClient` that records every client it creates. */
const fakeClients = (answer: Answer = svgAnswer) => {
  const clients: FakeClient[] = [];
  const createClient = (
    iframe: HTMLIFrameElement,
    options: RendererClientOptions,
  ): RendererClient => {
    const client: FakeClient = {
      iframe,
      options,
      requests: [],
      closed: false,
      export: (request) => {
        client.requests.push(request);

        return answer(request, client);
      },
      close: () => {
        client.closed = true;
      },
    };

    clients.push(client);

    return client;
  };

  return { clients, createClient };
};

/** Runs `body` with a renderer over `createClient`, disposing it after. */
const withRenderer = async (
  createClient: ReturnType<typeof fakeClients>['createClient'],
  body: (renderer: Renderer) => Promise<void>,
  idleMs = 60_000,
): Promise<void> => {
  const renderer = createRenderer({
    document: window.document as unknown as Document,
    createClient,
    timeoutMs: 1_000,
    idleMs,
  });

  try {
    await body(renderer);
  } finally {
    renderer.dispose();
    for (const iframe of iframes()) iframe.remove();
  }
};

const request = (overrides: Partial<RenderRequest> = {}): RenderRequest => ({
  xml: TWO_PAGES,
  pageId: 'p2',
  theme: 'light',
  format: 'svg',
  ...overrides,
});

describe('singlePageOf', () => {
  test('keeps the root attributes but pages, and the page whole (row 1)', () => {
    const single = parser().parseFromString(
      singlePageOf(TWO_PAGES, 'p2'),
      'application/xml',
    );
    const root = single.documentElement;

    assert.equal(root.tagName, 'mxfile');
    assert.equal(root.getAttribute('host'), 'x');
    assert.equal(root.getAttribute('agent'), 'test');
    assert.equal(root.hasAttribute('pages'), false);

    const diagrams = [...root.children];

    assert.equal(diagrams.length, 1);
    assert.equal(serialize(diagrams[0]), serialize(diagramOf(TWO_PAGES, 'p2')));
  });

  test('without a pageId, the first page (row 2)', () => {
    const single = singlePageOf(TWO_PAGES);
    const root = parser().parseFromString(
      single,
      'application/xml',
    ).documentElement;

    assert.equal(root.children.length, 1);
    assert.equal(
      serialize(root.children[0]),
      serialize(diagramOf(TWO_PAGES, 'p1')),
    );
  });

  test('an unknown page, another root or no page is invalid-xml (row 3)', () => {
    assert.throws(() => singlePageOf(TWO_PAGES, 'p9'), isCode('invalid-xml'));
    assert.throws(
      () => singlePageOf(`<graph>${PAGE_ONE}</graph>`),
      isCode('invalid-xml'),
    );
    assert.throws(
      () => singlePageOf('<mxfile host="x"></mxfile>'),
      isCode('invalid-xml'),
    );
  });
});

describe('renderer', () => {
  test('exports the single-page mxfile, without a pageId key (row 4)', async () => {
    const { clients, createClient } = fakeClients();

    await withRenderer(createClient, async (renderer) => {
      await renderer.render(request({ format: 'xmlsvg' }));

      const [sent] = clients[0]?.requests ?? [];

      assert.ok(sent, 'one export');
      assert.equal(sent.xml, singlePageOf(TWO_PAGES, 'p2'));
      assert.equal(sent.format, 'xmlsvg');
      assert.equal(sent.keepTheme, false);
      assert.equal(sent.embedImages, true);
      assert.equal(sent.embedFonts, false);
      assert.equal(Object.hasOwn(sent, 'pageId'), false);
    });
  });

  test('answers the SVG text of a base64 or a URI-encoded data URI (row 5)', async () => {
    const answers = [base64Uri(SVG), encodedUri(SVG), 'not a data uri'];
    const { createClient } = fakeClients(async () => ({
      data: answers.shift(),
    }));

    await withRenderer(createClient, async (renderer) => {
      assert.equal(await renderer.render(request()), SVG);
      assert.equal(await renderer.render(request()), SVG);
      await assert.rejects(renderer.render(request()), isCode('unavailable'));
    });
  });

  test('runs one request at a time, in call order (row 6)', async () => {
    const titled = (title: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg"><title>${title}</title></svg>`;
    const pending: Array<() => void> = [];
    const { clients, createClient } = fakeClients(
      (request) =>
        new Promise((resolve) => {
          pending.push(() =>
            resolve({ data: encodedUri(titled(request.format)) }),
          );
        }),
    );

    await withRenderer(createClient, async (renderer) => {
      const first = renderer.render(request({ format: 'svg' }));
      const second = renderer.render(request({ format: 'xmlsvg' }));

      await settle();
      assert.equal(clients[0]?.requests.length, 1);
      pending.shift()?.();
      assert.equal(await first, titled('svg'));

      await settle();
      assert.equal(clients[0]?.requests.length, 2);
      assert.equal(clients[0]?.requests[1]?.format, 'xmlsvg');
      pending.shift()?.();
      assert.equal(await second, titled('xmlsvg'));
    });
  });

  test('one hidden iframe per theme; a theme change replaces it (row 7)', async () => {
    assert.equal(
      rendererUrl('dark'),
      `${DRAWIO_ORIGIN}/index.html?embed=1&proto=json&configure=1&stealth=1&lockdown=1&pwa=0&noSaveBtn=1&noExitBtn=1&saveAndExit=0&spin=0&dark=1`,
    );

    const { clients, createClient } = fakeClients();

    await withRenderer(createClient, async (renderer) => {
      assert.equal(iframes().length, 0, 'nothing before the first request');

      await renderer.render(request());

      const [frame] = iframes();

      assert.equal(iframes().length, 1);
      assert.ok(frame);
      assert.equal(frame.getAttribute('aria-hidden'), 'true');
      assert.equal(frame.getAttribute('tabindex'), '-1');
      assert.equal(
        frame.getAttribute('sandbox'),
        'allow-scripts allow-same-origin',
      );
      assert.equal(frame.style.visibility, 'hidden');
      assert.notEqual(frame.style.display, 'none');

      const light = clients[0];

      assert.ok(light);
      assert.equal(light.iframe, frame);
      assert.equal(light.options.url, rendererUrl('light'));
      assert.match(light.options.url, /[?&]dark=0$/u);
      assert.deepEqual(light.options.config, { compressXml: false });
      assert.equal(light.options.requestTimeout, 1_000);

      await renderer.render(request({ theme: 'dark' }));

      assert.equal(light.closed, true);
      assert.equal(frame.isConnected, false);
      assert.equal(clients.length, 2);
      assert.match(clients[1]?.options.url ?? '', /[?&]dark=1$/u);
      assert.equal(iframes().length, 1);
      assert.equal(iframes()[0], clients[1]?.iframe);
    });
  });

  test('an editor refusal is invalid-xml and keeps the editor (row 8)', async () => {
    const refusals = [
      new DrawioError('editor', 'bad diagram'),
      new DrawioError('invalid', 'bad request'),
    ];
    const { clients, createClient } = fakeClients(async () => {
      const refusal = refusals.shift();

      if (refusal !== undefined) throw refusal;

      return { data: base64Uri(SVG) };
    });

    await withRenderer(createClient, async (renderer) => {
      await assert.rejects(renderer.render(request()), isCode('invalid-xml'));

      const [frame] = iframes();

      await assert.rejects(renderer.render(request()), isCode('invalid-xml'));
      assert.equal(clients.length, 1);
      assert.equal(clients[0]?.closed, false);
      assert.ok(frame?.isConnected, 'the iframe stays');
      assert.equal(await renderer.render(request()), SVG);
      assert.equal(clients.length, 1);
    });
  });

  test('a timeout or a restart is unavailable and replaces the editor (row 9)', async () => {
    const failures = [
      new DrawioError('timeout', 'no answer'),
      new DrawioError('restarted', 'editor restarted'),
    ];
    const { clients, createClient } = fakeClients(async () => {
      const failure = failures.shift();

      if (failure !== undefined) throw failure;

      return { data: base64Uri(SVG) };
    });

    await withRenderer(createClient, async (renderer) => {
      await assert.rejects(renderer.render(request()), isCode('unavailable'));
      assert.equal(clients[0]?.closed, true);
      assert.equal(clients[0]?.iframe.isConnected, false);
      assert.equal(iframes().length, 0);

      await assert.rejects(renderer.render(request()), isCode('unavailable'));
      assert.equal(clients.length, 2);
      assert.equal(clients[1]?.closed, true);
      assert.equal(iframes().length, 0);

      assert.equal(await renderer.render(request()), SVG);
      assert.equal(clients.length, 3);
      assert.equal(iframes().length, 1);
    });
  });

  test('an idle editor is closed and its iframe removed (row 10)', async () => {
    const { clients, createClient } = fakeClients();

    await withRenderer(
      createClient,
      async (renderer) => {
        await renderer.render(request());
        assert.equal(iframes().length, 1);

        await new Promise((resolve) => setTimeout(resolve, 60));

        assert.equal(iframes().length, 0);
        assert.equal(clients[0]?.closed, true);
      },
      10,
    );
  });
});

describe('drawPage', () => {
  const key: DiagramSvgKey = {
    artifactId: 'flow',
    revision: 3,
    sha256: 'a'.repeat(64),
    pageId: 'p2',
    theme: 'dark',
  };
  const layout: DiagramLayout = {
    width: 80,
    height: 40,
    cells: [{ id: 'b', x: 0, y: 0, width: 80, height: 40 }],
  };

  test('renders, measures and stores the page; a failing store is ignored (row 11)', async () => {
    const rendered: RenderRequest[] = [];
    const measured: Array<readonly [string, string]> = [];
    const drawing = {
      render: async (input: RenderRequest) => {
        rendered.push(input);

        return SVG;
      },
      measure: async (svg: string, theme: 'light' | 'dark') => {
        measured.push([svg, theme]);

        return layout;
      },
    };
    const stored: unknown[] = [];

    const entry = await drawPage({ key, xml: TWO_PAGES }, drawing, {
      put: async (input) => {
        stored.push(input);
      },
    });

    assert.deepEqual(entry, { svg: SVG, layout });
    assert.deepEqual(rendered, [
      { xml: TWO_PAGES, pageId: 'p2', theme: 'dark', format: 'svg' },
    ]);
    assert.deepEqual(measured, [[SVG, 'dark']]);
    assert.deepEqual(stored, [{ ...key, svg: SVG, layout }]);

    assert.deepEqual(
      await drawPage({ key, xml: TWO_PAGES }, drawing, {
        put: () => Promise.reject(new Error('disk full')),
      }),
      { svg: SVG, layout },
    );
    assert.deepEqual(
      await drawPage({ key, xml: TWO_PAGES }, drawing, {
        put: () => {
          throw new Error('disk full');
        },
      }),
      { svg: SVG, layout },
    );

    const refused = new RenderError('invalid-xml', 'bad diagram');
    const untouched: unknown[] = [];

    await assert.rejects(
      drawPage(
        { key, xml: TWO_PAGES },
        { ...drawing, render: () => Promise.reject(refused) },
        {
          put: async (input) => {
            untouched.push(input);
          },
        },
      ),
      (error) => error === refused,
    );
    assert.deepEqual(untouched, []);
  });

  test('with first, the put records the first page too (D1)', async () => {
    const drawing = {
      render: async () => SVG,
      measure: async () => layout,
    };
    const stored: unknown[] = [];

    const entry = await drawPage(
      { key, xml: TWO_PAGES, first: true },
      drawing,
      {
        put: async (input) => {
          stored.push(input);
        },
      },
    );

    assert.deepEqual(entry, { svg: SVG, layout });
    assert.deepEqual(stored, [{ ...key, svg: SVG, layout, first: true }]);
  });

  test('with first, a render that rejects stores nothing (D2)', async () => {
    const refused = new RenderError('invalid-xml', 'bad diagram');
    const stored: unknown[] = [];

    await assert.rejects(
      drawPage(
        { key, xml: TWO_PAGES, first: true },
        {
          render: () => Promise.reject(refused),
          measure: async () => layout,
        },
        {
          put: async (input) => {
            stored.push(input);
          },
        },
      ),
      (error) => error === refused,
    );
    assert.deepEqual(stored, []);
  });

  test('sha256Hex is the hex SHA-256 of the text (row 12)', async () => {
    assert.equal(
      await sha256Hex('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
