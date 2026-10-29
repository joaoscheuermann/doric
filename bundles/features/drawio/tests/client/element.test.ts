// `<drawio-diagram>` as the `artifacts` registry's frame mounts it (spec "O
// node mostra a revisão", "Âncora", plan §5 tests 1–17): the body reads the
// frame's block, shows the first page's drawing from `drawio.svg/v1` or draws
// it now (through a fake `DiagramDrawing`), records it with the revision's
// first-page pointer, re-anchors the durable comments on the page on screen,
// marks a cell that changed since its comment, and joins a confirmed comment
// to chat's composer stack. Every host service is faked at its boundary:
// `drawio.svg/v1` (a cache with a first-page pointer), `drawio.diagrams/v1`,
// `comments/v1`, `chat.composer/v1`, `chat.send/v1`, `runtime.threads/v1`,
// `doric.connection/v1` and `ui/v1`.
//
// Contract matrix:
// - the placeholder while nothing is drawn, with the model's counts (1);
// - a miss draws the model's first page and stores it as the first page (2);
// - a remount reads the pointer back, drawing nothing (3);
// - unleased, with and without a cached page (4, 5);
// - a revision that cannot be read: missing, hash mismatch (6, 7);
// - a drawing that fails, and its retry (8); a renderer that is not
//   available draws nothing until a retry finds it available (8b, Q5);
// - the comment gesture on a vertex, a connector, empty space (9–11);
// - re-anchoring on a later revision, the "célula alterada" mark (12);
// - the change note (13); the theme re-keys the cache (14);
// - no composer, no comment (15); `activate` (16);
// - no `get` the node makes names a page (17).
// - the page label: `pág 1/N` on a model of more than one page, none on a
//   model of one (N18).
//
// The fixtures, fakes and mounting live in `support/diagram-harness.ts`.

import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';

import type { Services } from 'bundle/contracts';

import {
  ARTIFACT,
  BOXES,
  type Box,
  blockOf,
  comment,
  commentAt,
  commentButton,
  drawingModule,
  durable,
  fakeComposer,
  fakeDrawing,
  harness,
  imageOf,
  index,
  inside,
  LAYOUT,
  loadClient,
  mount,
  pinOf,
  query,
  react,
  SHA,
  SVG,
  shown,
  TITLE,
  textOf,
  tipOf,
  unmount,
  unmountAll,
  until,
  view,
} from './support/diagram-harness.js';
import { window } from './support/dom.js';

before(loadClient);

afterEach(unmountAll);

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

/* The drawing ----------------------------------------------------------------- */

test('1: a miss shows the placeholder with the title, the revision and, once read, the counts', async () => {
  const h = harness();
  const body = await mount(h, fakeDrawing(['pending']).drawing);

  const placeholder = await shown(
    body,
    'drawio-diagram-placeholder',
    'no placeholder',
  );

  assert.ok(placeholder?.textContent?.includes(TITLE));
  assert.ok(placeholder?.textContent?.includes('rev 2'));
  await until(
    () => textOf(body),
    (text) => text.includes('2 páginas · 9 células'),
    'the counts never showed',
  );
  assert.equal(imageOf(body), null);
  assert.equal((await commentButton(body)).disabled, true);
});

test('2: a drawn page is shown at its size and stored as the first page', async () => {
  const h = harness();
  const body = await mount(h, fakeDrawing().drawing);

  const image = (await shown(
    body,
    'drawio-diagram-image',
    'never drawn',
  )) as HTMLImageElement;

  assert.ok(
    image.getAttribute('src')?.startsWith('data:image/svg+xml;base64,'),
  );
  assert.equal(image.getAttribute('width'), '420');
  assert.equal(image.getAttribute('height'), '280');
  await until(
    () => h.puts.length,
    (length) => length === 1,
    'never stored',
  );
  assert.deepEqual(h.puts, [
    {
      artifactId: ARTIFACT,
      revision: 2,
      sha256: SHA,
      pageId: 'p1',
      theme: 'light',
      svg: SVG,
      layout: LAYOUT,
      first: true,
    },
  ]);
});

test('3: a remount of the same revision reads the cache and draws nothing', async () => {
  const h = harness();
  const first = await mount(h, fakeDrawing().drawing);
  await shown(first, 'drawio-diagram-image', 'never drawn');
  await until(
    () => h.puts.length,
    (length) => length === 1,
    'never stored',
  );
  await unmount(first);

  const again = fakeDrawing();
  const second = await mount(h, again.drawing);

  await shown(second, 'drawio-diagram-image', 'the cached page never showed');
  assert.equal(again.renders.length, 0);
  assert.equal(again.measures.length, 0);
  assert.equal(document.querySelector('iframe'), null);
});

test('4: unleased with a cached page shows it and its pins, without comment or expand', async () => {
  const h = harness();
  h.read = { status: 'unleased', lease: 'missing' };
  h.cache.seed(
    { artifactId: ARTIFACT, revision: 2, sha256: SHA },
    'p1',
    'light',
    true,
  );
  h.comments = [
    durable(
      'c1',
      {
        form: 'selector',
        selector: 'page/p1/cell/a',
        label: 'A',
        x: 70,
        y: 50,
        cellKind: 'vertex',
        index: 0,
      },
      'mais contraste',
    ),
    durable(
      'c2',
      {
        form: 'selector',
        selector: 'page/p1/point/250,150',
        label: 'liga',
        x: 250,
        y: 150,
      },
      'falta um passo aqui',
    ),
  ];
  h.composer = fakeComposer();
  comment.setComposerAvailable(true);

  const body = await mount(h, fakeDrawing().drawing);
  await shown(body, 'drawio-diagram-image', 'the cached page never showed');
  await until(
    () => textOf(body),
    (text) => text.includes('O Project está sem sandbox ativo'),
    'no sandbox line',
  );

  const button = await commentButton(body);
  assert.equal(button.disabled, true);
  assert.equal(
    query<HTMLButtonElement>(body, 'papercraft-expand')?.disabled,
    true,
  );

  const one = (await until(
    () => pinOf(body, 1),
    (pin) => pin !== null,
    'no pin 1',
  )) as HTMLElement;
  const two = (await until(
    () => pinOf(body, 2),
    (pin) => pin !== null,
    'no pin 2',
  )) as HTMLElement;

  assert.ok(inside(tipOf(one), BOXES.a as Box), JSON.stringify(tipOf(one)));
  assert.deepEqual(tipOf(two), { x: 250, y: 150 });
});

test('5: unleased without a cached page shows the placeholder, the sandbox line and a retry', async () => {
  const h = harness();
  h.read = { status: 'unleased', lease: 'missing' };
  const body = await mount(h, fakeDrawing().drawing);

  await shown(body, 'drawio-diagram-retry', 'no retry');
  assert.ok(query(body, 'drawio-diagram-placeholder') !== null);
  assert.ok(textOf(body).includes('O Project está sem sandbox ativo'));
  assert.ok(
    query(body, 'drawio-diagram-retry')?.textContent?.includes(
      'Tentar de novo',
    ),
  );
  assert.equal(imageOf(body), null);
});

test('6: a missing revision cannot be read', async () => {
  const h = harness();
  h.read = { status: 'missing' };
  const body = await mount(h, fakeDrawing().drawing);

  const error = await shown(body, 'drawio-diagram-error', 'no error');
  assert.ok(error?.textContent?.includes('O diagrama não pôde ser lido'));
});

test("7: XML whose SHA-256 is not the block's is not drawn nor stored", async () => {
  const h = harness();
  const drawn = fakeDrawing();
  const body = await mount(
    h,
    drawn.drawing,
    blockOf({ entries: [{ path: 'diagram.drawio', sha256: 'f'.repeat(64) }] }),
  );

  const error = await shown(body, 'drawio-diagram-error', 'no error');
  assert.ok(error?.textContent?.includes('O diagrama não pôde ser lido'));
  assert.equal(drawn.renders.length, 0);
  assert.equal(h.puts.length, 0);
  assert.equal(imageOf(body), null);
});

test('8: a render that fails says so, and Tentar de novo draws again', async () => {
  const h = harness();
  const drawn = fakeDrawing(['reject']);
  const body = await mount(h, drawn.drawing);

  const error = await shown(body, 'drawio-diagram-error', 'no error');
  assert.ok(error?.textContent?.includes('O diagrama não pôde ser desenhado'));

  const retry = await shown(body, 'drawio-diagram-retry', 'no retry');
  assert.ok(retry?.textContent?.includes('Tentar de novo'));
  await react.act(async () => retry?.click());

  await shown(body, 'drawio-diagram-image', 'the retry never drew');
  assert.equal(drawn.renders.length, 2);
});

test('8b: a renderer that is not available says so without drawing, and Tentar de novo draws once it is', async () => {
  const h = harness();
  h.svgStatus = { available: false, reason: 'missing-assets' };
  const drawn = fakeDrawing();
  const body = await mount(h, drawn.drawing);

  const error = await shown(body, 'drawio-diagram-error', 'no error');
  assert.ok(error?.textContent?.includes('O diagrama não pôde ser desenhado'));
  const retry = await shown(body, 'drawio-diagram-retry', 'no retry');
  assert.equal(drawn.renders.length, 0);
  assert.equal(h.puts.length, 0);

  h.svgStatus = { available: true, version: '29.0.0' };
  await react.act(async () => retry?.click());

  await shown(body, 'drawio-diagram-image', 'the retry never drew');
  assert.equal(drawn.renders.length, 1);
});

/* The comment gesture --------------------------------------------------------- */

test('9: a comment on a shape joins the stack with the cell anchor', async () => {
  const h = harness();
  const item = await commentAt(h, 40, 30, 'mais contraste');

  assert.equal(item.threadId, 't-1');
  assert.equal(item.kind, 'drawio-diagram');
  assert.equal(item.elementTag, 'chat-comment-line');
  assert.equal(item.note, 'mais contraste');
  assert.deepEqual(item.data.target, {
    kind: 'artifact',
    id: ARTIFACT,
    revision: 2,
    anchor: {
      form: 'selector',
      selector: 'page/p1/cell/a',
      label: 'A',
      x: 70,
      y: 50,
      cellKind: 'vertex',
      index: 0,
    },
  });
  assert.deepEqual(item.data.refs, { title: TITLE, source: 'diagram.drawio' });
  assert.deepEqual(item.data.point, { x: 40, y: 30 });
});

test('10: a comment on a connector anchors the edge and its label', async () => {
  const h = harness();
  const item = await commentAt(h, 210, 50, 'esta seta está invertida');

  assert.deepEqual((item.data.target as { anchor: unknown }).anchor, {
    form: 'selector',
    selector: 'page/p1/cell/e',
    label: 'liga',
    x: 210,
    y: 50,
    cellKind: 'edge',
    index: 0,
  });
});

test('11: a comment on empty space anchors the point and the nearest label', async () => {
  const h = harness();
  const item = await commentAt(h, 200, 150, 'falta um passo aqui');

  assert.deepEqual((item.data.target as { anchor: unknown }).anchor, {
    form: 'selector',
    selector: 'page/p1/point/200,150',
    label: 'liga',
    x: 200,
    y: 150,
  });
  assert.deepEqual(item.data.point, { x: 200, y: 150 });
});

/* Re-anchoring ---------------------------------------------------------------- */

test("12: on revision 2, a kept cell whose label changed is marked; a removed cell's pin goes to its twin", async () => {
  const h = harness();
  h.cache.seed(
    { artifactId: ARTIFACT, revision: 2, sha256: SHA },
    'p1',
    'light',
    true,
  );
  h.comments = [
    durable(
      'c1',
      {
        form: 'selector',
        selector: 'page/p1/cell/a',
        label: 'Antes',
        x: 70,
        y: 50,
        cellKind: 'vertex',
        index: 0,
      },
      'mais contraste',
    ),
    durable(
      'c2',
      {
        form: 'selector',
        selector: 'page/p1/cell/gone',
        label: 'Twin',
        x: 350,
        y: 230,
        cellKind: 'vertex',
        index: 1,
      },
      'este passo some',
    ),
  ];

  const body = await mount(h, fakeDrawing().drawing);
  await shown(body, 'drawio-diagram-image', 'the cached page never showed');
  await commentButton(body);

  const changed = await shown(
    body,
    'drawio-cell-changed',
    'the changed cell was never marked',
  );
  assert.equal(
    body.querySelectorAll('[data-testid="drawio-cell-changed"]').length,
    1,
  );
  assert.equal(changed?.getAttribute('data-cell-id'), 'a');
  assert.equal(
    changed?.getAttribute('title'),
    'A célula mudou desde o comentário',
  );
  assert.equal(view.CELL_CHANGED_TITLE, 'A célula mudou desde o comentário');

  const one = (await until(
    () => pinOf(body, 1),
    (pin) => pin !== null,
    'no pin 1',
  )) as HTMLElement;
  const two = (await until(
    () => pinOf(body, 2),
    (pin) => pin !== null,
    'no pin 2',
  )) as HTMLElement;

  assert.ok(inside(tipOf(one), BOXES.a as Box), JSON.stringify(tipOf(one)));
  assert.ok(inside(tipOf(two), BOXES.t2 as Box), JSON.stringify(tipOf(two)));
});

/* The block, the theme and the composer --------------------------------------- */

test('13: the change note shows under the canvas', async () => {
  const h = harness();
  const body = await mount(
    h,
    fakeDrawing().drawing,
    blockOf({ changeNote: 'Adiciona o passo de revisão' }),
  );

  await until(
    () => textOf(body),
    (text) => text.includes('Adiciona o passo de revisão'),
    'the change note never showed',
  );
});

test('14: the dark theme re-keys the cache and draws the first page again on a miss', async () => {
  const h = harness();
  h.cache.seed(
    { artifactId: ARTIFACT, revision: 2, sha256: SHA },
    'p1',
    'light',
    true,
  );
  const drawn = fakeDrawing();
  const body = await mount(h, drawn.drawing);
  await shown(body, 'drawio-diagram-image', 'the cached page never showed');
  assert.equal(drawn.renders.length, 0);

  await react.act(async () => {
    document.documentElement.classList.add('dark');
  });

  await until(
    () => h.puts.length,
    (length) => length === 1,
    'the dark page was never drawn',
  );
  assert.ok(
    h.gets.some((lookup) => lookup.theme === 'dark' && !('pageId' in lookup)),
    JSON.stringify(h.gets),
  );
  assert.equal(drawn.renders[0]?.theme, 'dark');
  assert.equal(drawn.renders[0]?.pageId, 'p1');
  assert.deepEqual(h.puts[0], {
    artifactId: ARTIFACT,
    revision: 2,
    sha256: SHA,
    pageId: 'p1',
    theme: 'dark',
    svg: SVG,
    layout: LAYOUT,
    first: true,
  });
});

test("15: without chat's composer, Comentar is disabled", async () => {
  const h = harness();
  h.cache.seed(
    { artifactId: ARTIFACT, revision: 2, sha256: SHA },
    'p1',
    'light',
    true,
  );
  comment.setComposerAvailable(false);
  const body = await mount(h, fakeDrawing().drawing);
  await shown(body, 'drawio-diagram-image', 'the cached page never showed');
  await until(
    () => h.reads.length,
    (length) => length > 0,
    'never read',
  );

  assert.equal((await commentButton(body)).disabled, true);
});

test('16: activate defines drawio-diagram, follows the composer, and cleans up', async () => {
  const defined: { tag: string; disposed: boolean }[] = [];
  const binds: {
    contract: string;
    callback: (api: unknown, provider: unknown) => unknown;
    disposed: boolean;
  }[] = [];
  const services = {
    provide: () => ({ dispose: () => undefined }),
    use: (contract: { id?: string }) => {
      if (contract.id !== 'ui/v1') {
        throw new Error(`unexpected contract ${String(contract.id)}`);
      }

      return {
        define: (tag: string) => {
          const entry = { tag, disposed: false };
          defined.push(entry);

          return {
            dispose: () => {
              entry.disposed = true;
            },
          };
        },
        create: () => ({}),
        dispose: () => undefined,
      };
    },
    whenAvailable: (
      contract: { id?: string },
      callback: (api: unknown, provider: unknown) => unknown,
    ) => {
      const entry = { contract: contract.id ?? '', callback, disposed: false };
      binds.push(entry);

      return {
        dispose: () => {
          entry.disposed = true;
        },
      };
    },
  } as unknown as Services;

  const cleanup = index.activate({ services });

  assert.deepEqual(
    defined.map((entry) => entry.tag),
    ['drawio-diagram'],
  );
  const bind = binds.find((entry) => entry.contract === 'chat.composer/v1');
  assert.ok(bind !== undefined, 'no whenAvailable on chat.composer/v1');

  assert.equal(index.composerAvailable(), false);
  const release = bind.callback({}, { bundleId: 'chat', version: '1.0.0' });
  assert.equal(index.composerAvailable(), true);
  assert.equal(typeof release, 'function');
  await (release as () => unknown)();
  assert.equal(index.composerAvailable(), false);

  await cleanup();
  assert.ok(defined.every((entry) => entry.disposed));
  assert.ok(binds.every((entry) => entry.disposed));
});

test('17: no get the node makes names a page', async () => {
  const h = harness();
  const first = await mount(h, fakeDrawing().drawing);
  await shown(first, 'drawio-diagram-image', 'never drawn');

  await react.act(async () => {
    document.documentElement.classList.add('dark');
  });
  await until(
    () => h.gets.filter((lookup) => lookup.theme === 'dark').length,
    (count) => count > 0,
    'the dark page was never looked up',
  );
  await unmount(first);

  const second = await mount(h, fakeDrawing().drawing);
  await shown(second, 'drawio-diagram-image', 'the cached page never showed');

  assert.ok(h.gets.length >= 3, JSON.stringify(h.gets));
  for (const lookup of h.gets) {
    assert.equal('pageId' in lookup, false, JSON.stringify(lookup));
  }
});

/* The page label -------------------------------------------------------------- */

/** One page, `solo` "Só", holding the single vertex `s`. */
const ONE_PAGE = `<mxfile host="test">
  <diagram id="solo" name="Só">
    <mxGraphModel>
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="s" value="S" vertex="1" parent="1">
          <mxGeometry x="20" y="20" width="100" height="60" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

test('N18: the node labels its page pág 1/N only when the model has more than one page', async () => {
  const two = harness();
  const twoPages = await mount(two, fakeDrawing().drawing);
  await shown(twoPages, 'drawio-diagram-image', 'never drawn');

  assert.equal(query(twoPages, 'drawio-page')?.textContent, 'pág 1/2');
  await unmount(twoPages);

  const one = harness();
  one.read = { status: 'ok', xml: ONE_PAGE, revision: 2, revisions: 2 };
  const onePage = await mount(
    one,
    fakeDrawing().drawing,
    blockOf({
      entries: [
        {
          path: 'diagram.drawio',
          sha256: await drawingModule.sha256Hex(ONE_PAGE),
        },
      ],
    }),
  );
  await shown(onePage, 'drawio-diagram-image', 'the one page never drawn');

  assert.equal(query(onePage, 'drawio-page'), null);
});
