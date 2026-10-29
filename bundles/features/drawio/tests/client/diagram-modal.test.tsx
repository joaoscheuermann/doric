// The diagram's modal in Revisar (spec "O modal do diagrama", state machine
// rows 1, 2, 3 and 6; plan §5 tests M1–M15): Expandir on a drawn, leased
// node opens `CanvasModal` on the node's revision and page 1; the page menu
// shows another page from the cache or draws it; the revision menu reads
// another revision (`artifacts/v1.revisions`) and shows its page 1; every
// way out closes it and hands the focus back to Expandir. Every host service
// is faked at its boundary (`support/diagram-harness.ts`); the node is
// mounted as the registry's frame mounts it.
//
// Contract matrix:
// - rows 1, 2, 3, 6: one test each ('row 1: …' … 'row 6: …');
// - each opening starts on the node's revision and page 1 (M6);
// - Esc cancels one thing before it closes (M5);
// - a comment on page 2 anchors `page/p2/…` on the revision on screen (M7);
// - pins of the other page are detached (M8);
// - the Revisar keys, never from a text field (M9);
// - Enviar ao agente while there are drafts (M10);
// - no revision list, no Revisão menu (M11);
// - a page that cannot be drawn, and its retry (M12);
// - unleased, no Expandir (M13);
// - `reviewKeyOf` (M14) and `revisionBlockOf` (M15), pure.
//
// Phase 3 (plan §6):
// - H1: `useDiagramData` hands the checked XML and the revision count with
//   the model, and neither without it;
// - K1: `reviewKeyOf` maps plain E to 'edit'; K2: `isSaveChord`.

import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';

import {
  ARTIFACT,
  BOXES,
  BOXES_P2,
  type Body,
  type Box,
  blockOf,
  comment,
  dataModule,
  durable,
  fakeComposer,
  fakeDrawing,
  type Harness,
  harness,
  inside,
  loadClient,
  modal,
  mount,
  press,
  query,
  react,
  SHA,
  SHA_R1,
  shown,
  TITLE,
  tipOf,
  type,
  unmountAll,
  until,
  XML,
  XML_R1,
} from './support/diagram-harness.js';
import { window } from './support/dom.js';
import {
  canvasIn,
  choose,
  imageIn,
  keyTaken,
  onPageTwo,
  reads,
  textIn,
  triggerOf,
} from './support/modal-gestures.js';

before(loadClient);

afterEach(unmountAll);

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

/* Helpers --------------------------------------------------------------------- */

/**
 * A node at revision 2, drawn from the cached page `p1` (with the
 * revision's first-page pointer), and, with `composer`, chat's composer on.
 */
const drawnNode = async (
  h: Harness,
  drawing = fakeDrawing(),
  { composer = false }: { composer?: boolean } = {},
) => {
  h.cache.seed(
    { artifactId: ARTIFACT, revision: 2, sha256: SHA },
    'p1',
    'light',
    true,
  );
  const stack = composer ? fakeComposer() : undefined;
  if (stack !== undefined) {
    h.composer = stack;
    comment.setComposerAvailable(true);
  }

  const body = await mount(h, drawing.drawing, blockOf());
  await shown(body, 'drawio-diagram-image', 'the node never showed its page');

  return { body, drawing, composer: stack };
};

const modalOf = () => query(document.body, 'canvas-modal');

/** Expandir, once the reader chose the node and the node can expand. */
const expandOf = async (body: Body) => {
  const header = await shown(body, 'papercraft-header', 'no header');
  await press(header as Element);

  return (await until(
    () => query<HTMLButtonElement>(body, 'papercraft-expand'),
    (button) => button !== null && !button.disabled,
    'Expandir never enabled',
  )) as HTMLButtonElement;
};

/**
 * Presses Expandir the way a pointer does (happy-dom moves no focus on a
 * click, so the button is focused first) and waits for the modal's drawing.
 */
const open = async (body: Body) => {
  const button = await expandOf(body);
  await react.act(async () => {
    button.focus();
    button.click();
  });

  const dialog = (await until(
    modalOf,
    (found) => found !== null,
    'Expandir never opened the modal',
  )) as HTMLElement;
  await until(
    () => imageIn(dialog),
    (image) => image !== null,
    'the modal never showed a drawing',
  );

  return { dialog, button };
};

const toolIn = (dialog: HTMLElement) =>
  dialog.querySelector<HTMLElement>('[data-tool]')?.dataset.tool;

/** The zoom the toolbar shows, as a number of percent. */
const zoomIn = (dialog: HTMLElement): number | undefined => {
  const toolbar = query(dialog, 'drawio-toolbar');
  const shownZoom = [...(toolbar?.querySelectorAll('*') ?? [])].find(
    (element) =>
      element.children.length === 0 &&
      /^\d+%$/.test(element.textContent?.trim() ?? ''),
  );

  return shownZoom === undefined
    ? undefined
    : Number.parseInt(shownZoom.textContent ?? '', 10);
};

const pinIn = (dialog: HTMLElement, number: number) =>
  dialog.querySelector<HTMLElement>(
    `[data-testid="papercraft-pin"][data-pin="${String(number)}"]`,
  );

/** Arms Comentar in the modal's header, clicks the drawing at (`x`, `y`): the comment field. */
const commentFieldAt = async (dialog: HTMLElement, x: number, y: number) => {
  const button = (await until(
    () => query<HTMLButtonElement>(dialog, 'papercraft-comment'),
    (found) => found !== null && !found.disabled,
    'Comentar never enabled in the modal',
  )) as HTMLButtonElement;
  if (toolIn(dialog) !== 'comment') await react.act(async () => button.click());

  await press(imageIn(dialog) as Element, x, y);

  return (await until(
    () =>
      query(dialog, 'papercraft-comment-input')?.querySelector('textarea') ??
      null,
    (field) => field !== null,
    'no comment input in the modal',
  )) as HTMLTextAreaElement;
};

/** Writes `note` in `field` and confirms it with Enter. */
const confirm = async (field: HTMLTextAreaElement, note: string) => {
  await react.act(async () => type(field, note));
  await keyTaken(field, 'Enter');
};

/* Rows 1, 2, 3, 6 ------------------------------------------------------------- */

test('row 1: Expandir opens the modal on the node’s revision, page 1, drawn from the cache', async () => {
  const h = harness();
  const { body, drawing } = await drawnNode(h);
  const { dialog } = await open(body);

  assert.equal(textIn(dialog, 'papercraft-revision'), 'rev 2');
  await reads(dialog, 'drawio-page', 'pág 1/2');
  assert.equal(imageIn(dialog)?.getAttribute('width'), '420');
  assert.equal(imageIn(dialog)?.getAttribute('height'), '280');
  await until(
    () => triggerOf(dialog, 'Revisão')?.textContent?.trim(),
    (text) => text === 'rev 2/3',
    'the Revisão menu never read rev 2/3',
  );
  assert.equal(drawing.renders.length, 0);
  assert.ok(
    h.gets.every((lookup) => !('pageId' in lookup)),
    JSON.stringify(h.gets),
  );
});

test('row 2: choosing a page not in the cache draws, measures and stores it; choosing page 1 again reads the cache', async () => {
  const h = harness();
  const { body, drawing } = await drawnNode(h);
  const { dialog } = await open(body);
  await reads(dialog, 'drawio-page', 'pág 1/2');
  const readsBefore = h.reads.length;

  await choose(dialog, 'Página', 'Dois');

  await until(
    () => h.puts.length,
    (length) => length === 1,
    'page 2 was never stored',
  );
  assert.deepEqual(
    drawing.renders.map((request) => request.pageId),
    ['p2'],
  );
  assert.equal(drawing.measures.length, 1);
  const [put] = h.puts as Record<string, unknown>[];
  assert.equal(put?.artifactId, ARTIFACT);
  assert.equal(put?.revision, 2);
  assert.equal(put?.sha256, SHA);
  assert.equal(put?.pageId, 'p2');
  assert.equal(put?.theme, 'light');
  assert.ok(put !== undefined && !('first' in put), JSON.stringify(put));
  await reads(dialog, 'drawio-page', 'pág 2/2');
  assert.equal(h.reads.length, readsBefore);

  const getsBefore = h.gets.length;
  await choose(dialog, 'Página', 'Um');

  await until(
    () => h.gets.slice(getsBefore).some((lookup) => lookup.pageId === 'p1'),
    (asked) => asked,
    'page 1 was never looked up by its page',
  );
  await reads(dialog, 'drawio-page', 'pág 1/2');
  await until(
    () => imageIn(dialog)?.getAttribute('width'),
    (width) => width === '420',
    'page 1 never showed again',
  );
  assert.equal(drawing.renders.length, 1);
});

test('row 3: choosing another revision reads it and shows its page 1', async () => {
  const h = harness();
  const { body, drawing } = await drawnNode(h);
  const { dialog } = await open(body);
  await onPageTwo(dialog);

  await choose(dialog, 'Revisão', 'rev 1');

  await reads(dialog, 'papercraft-revision', 'rev 1');
  await until(
    () => h.puts.find((put) => put.revision === 1),
    (put) => put !== undefined,
    'page 1 of revision 1 was never stored',
  );
  assert.ok(
    h.reads.some(
      (input) =>
        (input as { artifactId?: string }).artifactId === ARTIFACT &&
        (input as { revision?: number }).revision === 1,
    ),
    JSON.stringify(h.reads),
  );
  const lookups = h.gets.filter((lookup) => lookup.revision === 1);
  assert.ok(lookups.length > 0, 'revision 1 was never looked up');
  for (const lookup of lookups) {
    assert.equal(lookup.sha256, SHA_R1);
    assert.ok(!('pageId' in lookup), JSON.stringify(lookup));
  }
  const put = h.puts.find((stored) => stored.revision === 1);
  assert.equal(put?.sha256, SHA_R1);
  assert.equal(put?.pageId, 'p1');
  assert.equal(put?.first, true);
  const drawn = drawing.renders.find((request) => request.xml === XML_R1);
  assert.equal(drawn?.pageId, 'p1');
  await reads(dialog, 'drawio-page', 'pág 1/2');
});

test('row 6: Esc, the backdrop and the close button close the modal, back on Expandir of a still active node', async () => {
  const closers: [string, (dialog: HTMLElement) => Promise<void>][] = [
    [
      'Esc',
      async (dialog) => {
        await keyTaken(await canvasIn(dialog), 'Escape');
      },
    ],
    [
      'the backdrop',
      async () => {
        const backdrop = query(document.body, 'canvas-modal-backdrop');
        assert.ok(backdrop !== null, 'the modal has no backdrop');
        await react.act(async () => {
          const init = { bubbles: true, cancelable: true, button: 0 };
          backdrop.dispatchEvent(
            new window.PointerEvent('pointerdown', init) as never,
          );
          backdrop.dispatchEvent(
            new window.MouseEvent('mousedown', init) as never,
          );
          backdrop.dispatchEvent(
            new window.PointerEvent('pointerup', init) as never,
          );
          backdrop.dispatchEvent(
            new window.MouseEvent('mouseup', init) as never,
          );
          backdrop.dispatchEvent(new window.MouseEvent('click', init) as never);
        });
      },
    ],
    [
      'the close button',
      async (dialog) =>
        react.act(async () => {
          query(dialog, 'canvas-modal-close')?.click();
        }),
    ],
  ];

  for (const [closer, close] of closers) {
    const h = harness();
    const { body } = await drawnNode(h);
    const { dialog, button } = await open(body);

    await close(dialog);

    await until(
      modalOf,
      (found) => found === null,
      `${closer} never closed the modal`,
    );
    await until(
      () => document.activeElement,
      (focused) => focused === button,
      `${closer}: the focus is not back on Expandir`,
    );
    assert.equal(
      body.querySelector<HTMLElement>('[data-active]')?.dataset.active,
      'true',
      `${closer}: the node is not active`,
    );
    await unmountAll();
  }
});

/* The rest of Revisar --------------------------------------------------------- */

test('M5: in the modal, the first Esc disarms Comentar and the second closes it', async () => {
  const h = harness();
  const { body } = await drawnNode(h, fakeDrawing(), { composer: true });
  const { dialog } = await open(body);
  const canvas = await canvasIn(dialog);
  await until(
    () => query<HTMLButtonElement>(dialog, 'papercraft-comment')?.disabled,
    (disabled) => disabled === false,
    'Comentar never enabled in the modal',
  );

  await keyTaken(canvas, 'c');
  assert.equal(toolIn(dialog), 'comment');

  await keyTaken(canvas, 'Escape');
  await until(
    () => toolIn(dialog),
    (tool) => tool === 'select',
    'the first Esc did not disarm Comentar',
  );
  assert.ok(modalOf() !== null, 'the first Esc closed the modal');

  await keyTaken(canvas, 'Escape');
  await until(
    modalOf,
    (found) => found === null,
    'the second Esc did not close the modal',
  );
});

test('M6: each opening starts on the node’s revision and page 1', async () => {
  const h = harness();
  const { body } = await drawnNode(h);
  const { dialog, button } = await open(body);
  await onPageTwo(dialog);

  await react.act(async () => {
    query(dialog, 'canvas-modal-close')?.click();
  });
  await until(modalOf, (found) => found === null, 'the modal never closed');

  await react.act(async () => {
    button.focus();
    button.click();
  });
  const again = (await until(
    modalOf,
    (found) => found !== null,
    'Expandir never opened the modal again',
  )) as HTMLElement;

  await reads(again, 'papercraft-revision', 'rev 2');
  await reads(again, 'drawio-page', 'pág 1/2');
});

test('M7: a comment on a cell of page 2 anchors that page on the revision on screen', async () => {
  const h = harness();
  const { body, composer } = await drawnNode(h, fakeDrawing(), {
    composer: true,
  });
  const { dialog } = await open(body);
  await onPageTwo(dialog);

  await confirm(await commentFieldAt(dialog, 40, 20), 'separar C');

  await until(
    () => composer?.added.length,
    (length) => length === 1,
    'the note never joined the stack',
  );
  const data = composer?.added[0]?.data as { target: unknown } | undefined;
  const target = data?.target as {
    kind: string;
    id: string;
    revision: number;
    anchor: { selector: string; label: string };
  };
  assert.equal(target.kind, 'artifact');
  assert.equal(target.id, ARTIFACT);
  assert.equal(target.revision, 2);
  assert.equal(target.anchor.selector, 'page/p2/cell/c');
  assert.equal(target.anchor.label, 'C');
});

test('M8: pins of the other page are detached', async () => {
  const h = harness();
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
        selector: 'page/p2/cell/c',
        label: 'C',
        x: 40,
        y: 20,
        cellKind: 'vertex',
        index: 0,
      },
      'separar C',
    ),
  ];
  const { body } = await drawnNode(h);
  const { dialog } = await open(body);

  const onA = (await until(
    () => pinIn(dialog, 1),
    (pin) => pin !== null && pinIn(dialog, 2) !== null,
    'the modal never showed both pins',
  )) as HTMLElement;
  assert.equal(onA.dataset.detached, undefined);
  assert.ok(inside(tipOf(onA), BOXES.a as Box), JSON.stringify(tipOf(onA)));
  assert.equal(pinIn(dialog, 2)?.dataset.detached, 'true');

  await onPageTwo(dialog);

  const onC = (await until(
    () => pinIn(dialog, 2),
    (pin) => pin !== null && pin.dataset.detached === undefined,
    'pin 2 never placed on page 2',
  )) as HTMLElement;
  assert.ok(inside(tipOf(onC), BOXES_P2.c as Box), JSON.stringify(tipOf(onC)));
  assert.equal(pinIn(dialog, 1)?.dataset.detached, 'true');
});

test('M9: the Revisar keys drive the tool and the zoom, but never from a text field', async () => {
  const h = harness();
  const { body } = await drawnNode(h, fakeDrawing(), { composer: true });
  const { dialog } = await open(body);
  const canvas = await canvasIn(dialog);
  await until(
    () => query<HTMLButtonElement>(dialog, 'papercraft-comment')?.disabled,
    (disabled) => disabled === false,
    'Comentar never enabled in the modal',
  );

  await keyTaken(canvas, 'h');
  assert.equal(toolIn(dialog), 'pan', 'H');
  await keyTaken(canvas, 'v');
  assert.equal(toolIn(dialog), 'select', 'V');
  await keyTaken(canvas, 'c');
  assert.equal(toolIn(dialog), 'comment', 'C');
  await keyTaken(canvas, 'v');
  assert.equal(toolIn(dialog), 'select', 'V after C');

  const start = zoomIn(dialog);
  assert.equal(start, 100, 'the toolbar shows no zoom');
  await keyTaken(canvas, '=', { ctrlKey: true });
  const zoomedIn = zoomIn(dialog) ?? 0;
  assert.ok(zoomedIn > 100, `Ctrl+= left the zoom at ${String(zoomedIn)}%`);
  await keyTaken(canvas, '-', { ctrlKey: true });
  await keyTaken(canvas, '-', { ctrlKey: true });
  const zoomedOut = zoomIn(dialog) ?? 0;
  assert.ok(zoomedOut < 100, `Ctrl+- left the zoom at ${String(zoomedOut)}%`);
  await keyTaken(canvas, '0', { ctrlKey: true, code: 'Digit0' });
  assert.equal(zoomIn(dialog), 100, 'Ctrl+0');

  // A canvas smaller than the 420×280 page: the fit shrinks it below 100%
  // (the shared fit never zooms past 100%).
  Object.defineProperty(canvas, 'clientWidth', {
    configurable: true,
    value: 300,
  });
  Object.defineProperty(canvas, 'clientHeight', {
    configurable: true,
    value: 200,
  });
  await keyTaken(canvas, '!', { shiftKey: true, code: 'Digit1' });
  assert.notEqual(zoomIn(dialog), 100, 'Shift+1');

  const field = await commentFieldAt(dialog, 40, 30);
  await react.act(async () => field.focus());
  const taken = await keyTaken(field, 'v');
  assert.equal(taken, false, 'v in the comment field was taken');
  assert.equal(toolIn(dialog), 'comment');
});

test('M10: with a draft, Enviar ao agente shows its count and sends the Thread', async () => {
  const h = harness();
  const { body, composer } = await drawnNode(h, fakeDrawing(), {
    composer: true,
  });
  const { dialog } = await open(body);

  await confirm(await commentFieldAt(dialog, 40, 30), 'mais contraste');
  await until(
    () => composer?.added.length,
    (length) => length === 1,
    'the note never joined the stack',
  );

  const send = (await until(
    () => query<HTMLButtonElement>(dialog, 'papercraft-send'),
    (button) => button !== null,
    'no Enviar ao agente in the modal',
  )) as HTMLButtonElement;
  assert.equal(send.textContent?.trim(), 'Enviar ao agente (1)');

  await react.act(async () => send.click());
  await until(
    () => h.sends.length,
    (length) => length === 1,
    'Enviar ao agente never called chat.send/v1',
  );
  assert.equal((h.sends[0] as { threadId?: string }).threadId, 't-1');
});

test('M11: without the revision list, the modal shows the node’s revision and no Revisão menu', async () => {
  const h = harness();
  h.revisions = 'reject';
  const { body } = await drawnNode(h);
  const { dialog } = await open(body);

  await until(
    () => h.revisionCalls.length,
    (length) => length === 1,
    'the modal never asked for the revisions',
  );
  await reads(dialog, 'drawio-page', 'pág 1/2');

  assert.equal(textIn(dialog, 'papercraft-revision'), 'rev 2');
  assert.equal(triggerOf(dialog, 'Revisão'), null);
});

test('M12: a page that cannot be drawn says so, and Tentar de novo draws it again', async () => {
  const h = harness();
  const { body, drawing } = await drawnNode(h, fakeDrawing(['reject']));
  const { dialog } = await open(body);
  await reads(dialog, 'drawio-page', 'pág 1/2');

  await choose(dialog, 'Página', 'Dois');

  await until(
    () => dialog.textContent ?? '',
    (text) => text.includes('O diagrama não pôde ser desenhado'),
    'the modal never said the page could not be drawn',
  );
  const retry = query<HTMLButtonElement>(dialog, 'drawio-diagram-retry');
  assert.ok(retry !== null, 'no Tentar de novo in the modal');

  await react.act(async () => retry.click());

  await until(
    () => imageIn(dialog)?.getAttribute('width'),
    (width) => width === '480',
    'page 2 never showed after the retry',
  );
  assert.deepEqual(
    drawing.renders.map((request) => request.pageId),
    ['p2', 'p2'],
  );
});

test('M13: an unleased node, even with its page cached, cannot expand', async () => {
  const h = harness();
  h.read = { status: 'unleased', lease: 'missing' };
  const { body } = await drawnNode(h);

  await until(
    () => body.textContent ?? '',
    (text) => text.includes('O Project está sem sandbox ativo'),
    'no sandbox line',
  );
  const header = await shown(body, 'papercraft-header', 'no header');
  await press(header as Element);
  const button = await until(
    () => query<HTMLButtonElement>(body, 'papercraft-expand'),
    (found) => found !== null,
    'no Expandir',
  );

  assert.equal(button?.disabled, true);
});

/* The pure parts -------------------------------------------------------------- */

test('M14: reviewKeyOf maps the Revisar chords and nothing else', () => {
  const chord = (init: Partial<Parameters<typeof modal.reviewKeyOf>[0]>) => ({
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    ...init,
  });
  const cases: [
    string,
    Parameters<typeof modal.reviewKeyOf>[0],
    string | undefined,
  ][] = [
    ['v', chord({ key: 'v', code: 'KeyV' }), 'select'],
    ['V', chord({ key: 'V', code: 'KeyV' }), 'select'],
    ['h', chord({ key: 'h', code: 'KeyH' }), 'pan'],
    ['H', chord({ key: 'H', code: 'KeyH' }), 'pan'],
    ['Ctrl+=', chord({ key: '=', code: 'Equal', ctrlKey: true }), 'zoom-in'],
    ['Meta+=', chord({ key: '=', code: 'Equal', metaKey: true }), 'zoom-in'],
    ['Ctrl++', chord({ key: '+', code: 'Equal', ctrlKey: true }), 'zoom-in'],
    ['Ctrl+-', chord({ key: '-', code: 'Minus', ctrlKey: true }), 'zoom-out'],
    ['Meta+-', chord({ key: '-', code: 'Minus', metaKey: true }), 'zoom-out'],
    [
      'Ctrl+0',
      chord({ key: '0', code: 'Digit0', ctrlKey: true }),
      'zoom-reset',
    ],
    [
      'Meta+0 on another layout',
      chord({ key: 'à', code: 'Digit0', metaKey: true }),
      'zoom-reset',
    ],
    [
      'Shift+1',
      chord({ key: '!', code: 'Digit1', shiftKey: true }),
      'zoom-fit',
    ],
    ['Alt+v', chord({ key: 'v', code: 'KeyV', altKey: true }), undefined],
    [
      'Alt+Ctrl+=',
      chord({ key: '=', code: 'Equal', ctrlKey: true, altKey: true }),
      undefined,
    ],
    [
      'Meta+Ctrl+=',
      chord({ key: '=', code: 'Equal', ctrlKey: true, metaKey: true }),
      undefined,
    ],
    [
      'default-prevented v',
      chord({ key: 'v', code: 'KeyV', defaultPrevented: true }),
      undefined,
    ],
    ['Ctrl+v', chord({ key: 'v', code: 'KeyV', ctrlKey: true }), undefined],
    ['= alone', chord({ key: '=', code: 'Equal' }), undefined],
    ['c', chord({ key: 'c', code: 'KeyC' }), undefined],
    ['Escape', chord({ key: 'Escape', code: 'Escape' }), undefined],
    ['Space', chord({ key: ' ', code: 'Space' }), undefined],
    [
      'Ctrl+Shift+1',
      chord({ key: '!', code: 'Digit1', shiftKey: true, ctrlKey: true }),
      undefined,
    ],
    ['1 alone', chord({ key: '1', code: 'Digit1' }), undefined],
  ];

  for (const [name, event, expected] of cases) {
    assert.equal(modal.reviewKeyOf(event), expected, name);
  }
});

test('K1: reviewKeyOf maps plain E, in any case, to edit, and E with a modifier to nothing', () => {
  const chord = (init: Partial<Parameters<typeof modal.reviewKeyOf>[0]>) => ({
    key: '',
    code: 'KeyE',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    ...init,
  });
  const cases: [
    string,
    Parameters<typeof modal.reviewKeyOf>[0],
    string | undefined,
  ][] = [
    ['e', chord({ key: 'e' }), 'edit'],
    ['E (Caps Lock)', chord({ key: 'E' }), 'edit'],
    ['Shift+E', chord({ key: 'E', shiftKey: true }), undefined],
    ['Ctrl+E', chord({ key: 'e', ctrlKey: true }), undefined],
    ['Meta+E', chord({ key: 'e', metaKey: true }), undefined],
    ['Alt+E', chord({ key: 'e', altKey: true }), undefined],
  ];

  for (const [name, event, expected] of cases) {
    assert.equal(modal.reviewKeyOf(event), expected, name);
  }
});

test('K2: isSaveChord is CmdOrCtrl+S and nothing else', () => {
  const chord = (init: Partial<Parameters<typeof modal.isSaveChord>[0]>) => ({
    key: 's',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    ...init,
  });
  const cases: [string, Parameters<typeof modal.isSaveChord>[0], boolean][] = [
    ['Meta+s', chord({ metaKey: true }), true],
    ['Ctrl+S', chord({ key: 'S', ctrlKey: true }), true],
    ['Meta+Ctrl+s', chord({ metaKey: true, ctrlKey: true }), false],
    ['Alt+Ctrl+s', chord({ ctrlKey: true, altKey: true }), false],
    ['Shift+Meta+S', chord({ key: 'S', metaKey: true, shiftKey: true }), false],
    [
      'default-prevented Ctrl+s',
      chord({ ctrlKey: true, defaultPrevented: true }),
      false,
    ],
    ['Ctrl+d', chord({ key: 'd', ctrlKey: true }), false],
    ['s alone', chord({}), false],
  ];

  for (const [name, event, expected] of cases) {
    assert.equal(modal.isSaveChord(event), expected, name);
  }
});

test('M15: revisionBlockOf takes the record’s revision, note and diagram hash, and the block’s title and scope', () => {
  const block = {
    projectId: 'p1',
    threadId: 't-1',
    artifactId: ARTIFACT,
    revision: 2,
    title: TITLE,
    changeNote: 'nota 2',
    sha256: 'sha-of-2',
  };

  assert.deepEqual(
    modal.revisionBlockOf(
      {
        artifactId: ARTIFACT,
        revision: 1,
        entries: [
          { path: 'notes.md', sha256: 'sha-of-notes' },
          { path: 'diagram.drawio', sha256: 'sha-of-1' },
        ],
        changeNote: 'primeira',
      },
      block,
    ),
    {
      projectId: 'p1',
      threadId: 't-1',
      artifactId: ARTIFACT,
      revision: 1,
      title: TITLE,
      changeNote: 'primeira',
      sha256: 'sha-of-1',
    },
  );
  assert.deepEqual(
    modal.revisionBlockOf(
      {
        artifactId: ARTIFACT,
        revision: 3,
        entries: [{ path: 'notes.md', sha256: 'sha-of-notes' }],
      },
      block,
    ),
    {
      projectId: 'p1',
      threadId: 't-1',
      artifactId: ARTIFACT,
      revision: 3,
      title: TITLE,
    },
  );
});

/* The hook's revision data (H1) ----------------------------------------------- */

type DiagramDataInput = Parameters<typeof dataModule.useDiagramData>[0];
type DiagramData = ReturnType<typeof dataModule.useDiagramData>;

/**
 * Mounts a probe running `useDiagramData` for revision 2 of the diagram with
 * block hash `sha256`, in a Project scope without a Thread; `seen.current` is
 * the hook's latest answer.
 */
const probeData = async (h: Harness, sha256: string) => {
  const { createRoot } = await import('react-dom/client');
  const seen: { current: DiagramData | undefined } = { current: undefined };
  const input: DiagramDataInput = {
    services: h.services,
    scope: { projectId: 'p1' },
    block: {
      projectId: 'p1',
      artifactId: ARTIFACT,
      revision: 2,
      title: TITLE,
      sha256,
    },
    drawing: fakeDrawing().drawing as unknown as DiagramDataInput['drawing'],
  };
  function Probe() {
    seen.current = dataModule.useDiagramData(input);

    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await react.act(async () => root.render(<Probe />));

  return {
    seen,
    dispose: async () => {
      await react.act(async () => root.unmount());
      host.remove();
    },
  };
};

test('H1: an ok read hands the checked XML and the revision count together with the model', async () => {
  const h = harness();
  const probe = await probeData(h, SHA);

  try {
    const data = await until(
      () => probe.seen.current,
      (current) => current?.model !== undefined,
      'the revision was never read',
    );

    assert.equal(data?.xml, XML);
    assert.equal(data?.revisions, 2);
  } finally {
    await probe.dispose();
  }
});

test('H1: an unleased, missing or mismatched read hands neither the XML nor the revision count', async () => {
  const cases: [string, Harness['read'], string, string][] = [
    ['unleased', { status: 'unleased', lease: 'missing' }, 'SHA', 'unleased'],
    ['missing', { status: 'missing' }, 'SHA', 'missing'],
    [
      'SHA mismatch',
      { status: 'ok', xml: XML, revision: 2, revisions: 2 },
      'SHA_R1',
      'unreadable',
    ],
  ];

  for (const [name, read, hash, failure] of cases) {
    const h = harness();
    h.read = read;
    const probe = await probeData(h, hash === 'SHA' ? SHA : SHA_R1);

    try {
      const data = await until(
        () => probe.seen.current,
        (current) => current?.failure !== undefined,
        `${name}: no failure`,
      );

      assert.equal(data?.failure, failure, name);
      assert.equal(data?.model, undefined, name);
      assert.equal(data?.xml, undefined, name);
      assert.equal(data?.revisions, undefined, name);
      assert.equal('xml' in (data ?? {}), false, `${name}: xml key`);
      assert.equal(
        'revisions' in (data ?? {}),
        false,
        `${name}: revisions key`,
      );
    } finally {
      await probe.dispose();
    }
  }
});
