// The diagram's modal in Editar without a modification (spec "Máquina de
// estados do modal do diagrama", phase 3; plan §5 sub-step 3.4 and §6): the
// Editar button and the E key, the editor's own header and toolbar, loading,
// restarts, the load deadline, the heartbeat, leaving with nothing to lose,
// and `indisponível` without XML. The editor's `DrawioClient` is faked at the
// iframe boundary (`fakeDrawing().editor`); every host service is faked
// (`support/diagram-harness.ts`).
//
// Contract matrix (plan §6):
// - Q4: Editar disabled without the revision's XML, E does nothing;
// - R4 (button and E), R5 (missing-assets, handler-failed, rejected status);
// - R7, R9a, R10a (deadline; row 9 does not re-arm it), R10b (+ restarted);
// - R12a/b, R13a/b (each closer from each state);
// - R19, R21 (heartbeat), R27, R29, R30;
// - K3 (CmdOrCtrl+S neither saves in Revisar nor reads XML in `editando`),
//   K4 (Revisar keys do nothing in Editar), L1 (openLink and exit ignored).

import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';

import { DrawioError } from '@drawio/react';

import {
  EDITOR_HEARTBEAT_MS,
  EDITOR_LOAD_TIMEOUT_MS,
} from '../../src/contracts/index.js';
import {
  fakeDrawing,
  type Harness,
  harness,
  loadClient,
  query,
  react,
  TITLE,
  unmountAll,
  until,
  withMockTimers,
  XML,
} from './support/diagram-harness.js';
import { window } from './support/dom.js';
import {
  canvasIn,
  choose,
  click,
  closers,
  contentIn,
  doneButtonIn,
  drawnNode,
  editButtonIn,
  editorMounted,
  flush,
  frameIn,
  imageIn,
  keyTaken,
  modalOf,
  onPageTwo,
  open,
  pressEdit,
  reads,
  saveButtonIn,
  textIn,
  unavailable,
  unavailableIn,
  untilFlushed,
} from './support/modal-gestures.js';

before(loadClient);

afterEach(unmountAll);

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

/* Helpers --------------------------------------------------------------------- */

/** The `indisponível` copy (plan §3.8, `unavailableReasonOf`). */
const REASON = {
  missingAssets: 'O editor de diagramas não está instalado neste app',
  handlerFailed: 'O editor de diagramas não pôde ser iniciado',
  statusRejected: 'Não foi possível verificar o editor de diagramas',
  loadFailed: 'O editor não carregou o diagrama',
  notAnswering: 'O editor parou de responder',
} as const;

/** The modal open in Revisar on revision 2, page 1. */
const revisar = async (h: Harness = harness()) => {
  const drawing = fakeDrawing();
  const { body } = await drawnNode(h, drawing);
  const { dialog, button } = await open(body);

  return { h, drawing, body, dialog, expand: button };
};

/** Editar pressed in `revisar`: the editor mounted, nothing answered (`carregando`). */
const carregando = async (h: Harness = harness()) => {
  const opened = await revisar(h);
  await pressEdit(opened.dialog);
  const client = await editorMounted(opened.dialog, opened.drawing);

  return { ...opened, client };
};

/** `carregando`, then `init` and its `load` answered: `editando`. */
const editando = async (h: Harness = harness()) => {
  const loading = await carregando(h);
  await loading.drawing.editor.init();
  await loading.drawing.editor.resolveLoad();
  await flush(2);

  return loading;
};

/** `carregando`, then the `load` rejects with an editor error: `indisponível` without XML. */
const indisponivel = async (h: Harness = harness()) => {
  const loading = await carregando(h);
  await loading.drawing.editor.init();
  await loading.drawing.editor.rejectLoad(
    new DrawioError('editor', 'bad diagram'),
  );
  await unavailable(loading.dialog);

  return loading;
};

const editorClosed = (closed: number) => closed >= 1;

/** Waits for Revisar back on screen: the drawing and no editor. */
const backInRevisar = async (dialog: HTMLElement) => {
  await untilFlushed(
    () => imageIn(dialog) !== null && frameIn(dialog) === null,
    (back) => back,
    'Revisar never came back',
  );
};

/* Q4 -------------------------------------------------------------------------- */

test('Q4: Editar is disabled and E does nothing on a revision without its XML; back on revision 2 it is enabled', async () => {
  const h = harness();
  h.readsOf.set(3, { status: 'unleased', lease: 'missing' });
  const { dialog, drawing } = await revisar(h);
  await untilFlushed(
    () => editButtonIn(dialog)?.disabled,
    (disabled) => disabled === false,
    'Editar (drawio-edit) is not enabled on revision 2',
  );

  await choose(dialog, 'Revisão', 'rev 3');
  await until(
    () =>
      h.reads.some((input) => (input as { revision?: number }).revision === 3),
    (read) => read,
    'revision 3 was never read',
  );
  await flush(5);

  assert.equal(editButtonIn(dialog)?.disabled, true, 'Editar on revision 3');
  const statusBefore = h.statusCalls;
  await keyTaken(contentIn(dialog), 'e');
  await flush(5);
  assert.equal(frameIn(dialog), null, 'E mounted the editor');
  assert.equal(drawing.editor.clients.length, 0);
  assert.equal(h.statusCalls, statusBefore, 'E asked for the editor status');

  await choose(dialog, 'Revisão', 'rev 2');
  await untilFlushed(
    () => editButtonIn(dialog)?.disabled,
    (disabled) => disabled === false,
    'Editar never enabled back on revision 2',
  );
});

/* Opening and loading --------------------------------------------------------- */

test('R4: Editar, by the button and by E, asks for status, mounts the editor, loads the XML of B, and shows its own header and toolbar', async () => {
  const openers: [string, (dialog: HTMLElement) => Promise<void>][] = [
    ['the button', async (dialog) => pressEdit(dialog)],
    [
      'E',
      async (dialog) => {
        await untilFlushed(
          () => editButtonIn(dialog)?.disabled,
          (disabled) => disabled === false,
          'E: Editar never enabled',
        );
        const taken = await keyTaken(await canvasIn(dialog), 'e');
        assert.equal(taken, true, 'E was not taken');
      },
    ],
  ];

  for (const [opener, edit] of openers) {
    const h = harness();
    const { dialog, drawing } = await revisar(h);
    const statusBefore = h.statusCalls;

    await edit(dialog);

    const client = await editorMounted(dialog, drawing);
    assert.equal(h.statusCalls, statusBefore + 1, `${opener}: status()`);
    assert.equal(client.iframe, frameIn(dialog), `${opener}: the iframe`);
    assert.equal(client.loads.length, 0, `${opener}: load before init`);

    await drawing.editor.init();
    assert.deepEqual(
      client.loads.map((load) => load.request),
      [{ xml: XML, autosave: true }],
      `${opener}: the load`,
    );

    const header = query(dialog, 'papercraft-header');
    assert.ok(header !== null, `${opener}: no header in Editar`);
    assert.ok(
      header.textContent?.includes(TITLE),
      `${opener}: the header reads ${String(header.textContent)}`,
    );
    assert.equal(textIn(dialog, 'papercraft-revision'), 'rev 2', opener);
    assert.equal(query(dialog, 'papercraft-comment'), null, opener);
    assert.equal(query(dialog, 'papercraft-send'), null, opener);
    assert.ok(query(dialog, 'drawio-edit-toolbar') !== null, opener);
    assert.equal(saveButtonIn(dialog)?.disabled, true, `${opener}: Salvar`);
    assert.equal(doneButtonIn(dialog)?.disabled, false, `${opener}: Concluir`);
    await unmountAll();
  }
});

test('R5: an unavailable or failing status shows the reason and never creates the editor', async () => {
  const cases: [string, Harness['svgStatus'], string][] = [
    [
      'missing-assets',
      { available: false, reason: 'missing-assets' },
      REASON.missingAssets,
    ],
    [
      'handler-failed',
      { available: false, reason: 'handler-failed' },
      REASON.handlerFailed,
    ],
    [
      'a rejected status',
      { reject: new Error('drawio.svg/v1 is gone') },
      REASON.statusRejected,
    ],
  ];

  for (const [name, status, reason] of cases) {
    const h = harness();
    const { dialog, drawing } = await revisar(h);
    h.svgStatus = status;

    await pressEdit(dialog);

    const text = await unavailable(dialog);
    assert.ok(text.includes(reason), `${name}: ${text}`);
    assert.equal(drawing.editor.clients.length, 0, name);
    assert.equal(frameIn(dialog), null, name);
    assert.ok(query(dialog, 'drawio-editor-retry') !== null, name);
    assert.ok(query(dialog, 'drawio-editor-back') !== null, name);
    assert.equal(query(dialog, 'drawio-edit-toolbar'), null, name);
    await unmountAll();
  }
});

test('R7: in carregando, the load answering leads to editando: Salvar stays disabled and the heartbeat starts', async () => {
  const { dialog, drawing } = await revisar();

  await withMockTimers(
    async (timers) => {
      await pressEdit(dialog);
      const client = await editorMounted(dialog, drawing);
      await drawing.editor.init();

      await react.act(async () => timers.tick(EDITOR_HEARTBEAT_MS));
      await flush(3);
      assert.equal(client.getXmls.length, 0, 'a heartbeat in carregando');

      await drawing.editor.resolveLoad();
      await flush(2);
      assert.equal(saveButtonIn(dialog)?.disabled, true, 'Salvar in editando');
      assert.equal(doneButtonIn(dialog)?.disabled, false, 'Concluir edição');

      await react.act(async () => timers.tick(EDITOR_HEARTBEAT_MS));
      await untilFlushed(
        () => client.getXmls.length,
        (length) => length === 1,
        'no heartbeat getXml in editando',
      );
    },
    ['setInterval'],
  );
});

test('R9a: in carregando, a second init loads the XML of B again', async () => {
  const { drawing, client, dialog } = await carregando();
  await drawing.editor.init();

  await drawing.editor.init();

  assert.deepEqual(
    client.loads.map((load) => load.request),
    [
      { xml: XML, autosave: true },
      { xml: XML, autosave: true },
    ],
  );
  assert.ok(frameIn(dialog) !== null);
  assert.equal(unavailableIn(dialog), null);
});

test('R10a: in carregando, EDITOR_LOAD_TIMEOUT_MS without a load removes the editor; a restart does not re-arm the deadline', async () => {
  const { dialog, drawing } = await revisar();

  await withMockTimers(
    async (timers) => {
      await pressEdit(dialog);
      const client = await editorMounted(dialog, drawing);
      await drawing.editor.init();

      await react.act(async () => timers.tick(EDITOR_LOAD_TIMEOUT_MS - 1));
      await flush(3);
      assert.ok(
        frameIn(dialog) !== null,
        'the editor left before its deadline',
      );
      assert.equal(unavailableIn(dialog), null);

      await drawing.editor.init();
      assert.equal(client.loads.length, 2, 'the restart did not load again');

      await react.act(async () => timers.tick(1));
      const text = await unavailable(dialog);
      assert.ok(text.includes(REASON.loadFailed), text);
      assert.equal(frameIn(dialog), null, 'the iframe is still there');
      assert.ok(editorClosed(client.closed), 'the client was not closed');
      assert.equal(
        query<HTMLButtonElement>(dialog, 'drawio-editor-back')?.disabled,
        false,
        'Voltar without XML',
      );
    },
    ['setTimeout'],
  );
});

test('R10b: in carregando, a DrawioError from load removes the editor; a restarted rejection keeps carregando', async () => {
  const { dialog, drawing, client } = await carregando();
  await drawing.editor.init();

  await drawing.editor.rejectLoad(new DrawioError('restarted', 'restarted'));
  await flush(3);
  assert.equal(unavailableIn(dialog), null, 'restarted made it unavailable');
  assert.ok(frameIn(dialog) !== null, 'restarted removed the editor');
  assert.equal(client.closed, 0);

  await drawing.editor.init();
  await drawing.editor.rejectLoad(new DrawioError('editor', 'bad diagram'));

  const text = await unavailable(dialog);
  assert.ok(text.includes(REASON.loadFailed), text);
  assert.equal(frameIn(dialog), null, 'the iframe is still there');
  assert.ok(editorClosed(client.closed), 'the client was not closed');
});

/* Leaving without changes ----------------------------------------------------- */

test('R12a/b: in carregando or editando, Concluir edição goes back to Revisar on B and the same page, without reading the revisions again', async () => {
  for (const state of ['carregando', 'editando'] as const) {
    const h = harness();
    const { dialog, drawing } = await revisar(h);
    await onPageTwo(dialog);
    const revisionCalls = h.revisionCalls.length;
    await pressEdit(dialog);
    const client = await editorMounted(dialog, drawing);
    await drawing.editor.init();
    if (state === 'editando') await drawing.editor.resolveLoad();

    await click(dialog, 'drawio-done');

    await backInRevisar(dialog);
    await reads(dialog, 'papercraft-revision', 'rev 2');
    await reads(dialog, 'drawio-page', 'pág 2/2');
    assert.ok(editorClosed(client.closed), `${state}: the client is open`);
    assert.ok(modalOf() !== null, `${state}: the modal closed`);
    assert.equal(h.revisionCalls.length, revisionCalls, state);
    await unmountAll();
  }
});

test('R13a/b: in carregando or editando, Esc, the backdrop and the close button close the modal, back on Expandir', async () => {
  for (const state of ['carregando', 'editando'] as const) {
    for (const [closer, close] of closers) {
      const { dialog, drawing, expand } = await revisar();
      await pressEdit(dialog);
      const client = await editorMounted(dialog, drawing);
      await drawing.editor.init();
      if (state === 'editando') await drawing.editor.resolveLoad();

      await close(dialog);

      await until(
        modalOf,
        (found) => found === null,
        `${state}, ${closer}: the modal is still open`,
      );
      assert.ok(editorClosed(client.closed), `${state}, ${closer}: client`);
      await until(
        () => document.activeElement,
        (focused) => focused === expand,
        `${state}, ${closer}: the focus is not back on Expandir`,
      );
      await unmountAll();
    }
  }
});

/* Restarts and heartbeat ------------------------------------------------------ */

test('R19: in editando, an unexpected init loads the XML of B and goes back to carregando', async () => {
  const { dialog, drawing } = await revisar();

  await withMockTimers(
    async (timers) => {
      await pressEdit(dialog);
      const client = await editorMounted(dialog, drawing);
      await drawing.editor.init();
      await drawing.editor.resolveLoad();

      await drawing.editor.init();

      assert.deepEqual(
        client.loads.map((load) => load.request),
        [
          { xml: XML, autosave: true },
          { xml: XML, autosave: true },
        ],
      );
      await react.act(async () => timers.tick(EDITOR_HEARTBEAT_MS));
      await flush(3);
      assert.equal(client.getXmls.length, 0, 'a heartbeat in carregando');

      await drawing.editor.resolveLoad();
      await react.act(async () => timers.tick(EDITOR_HEARTBEAT_MS));
      await untilFlushed(
        () => client.getXmls.length,
        (length) => length === 1,
        'no heartbeat once loaded again',
      );
    },
    ['setInterval'],
  );
});

test('R21: in editando, the heartbeat asks once at a time, and a timed-out answer makes the editor unavailable without XML', async () => {
  const { dialog, drawing } = await revisar();

  await withMockTimers(
    async (timers) => {
      await pressEdit(dialog);
      const client = await editorMounted(dialog, drawing);
      await drawing.editor.init();
      await drawing.editor.resolveLoad();

      await react.act(async () => timers.tick(EDITOR_HEARTBEAT_MS));
      await untilFlushed(
        () => client.getXmls.length,
        (length) => length === 1,
        'no heartbeat getXml',
      );
      await react.act(async () => timers.tick(EDITOR_HEARTBEAT_MS));
      await flush(3);
      assert.equal(client.getXmls.length, 1, 'a second getXml while pending');

      await drawing.editor.failXml(new DrawioError('timeout', 'no answer'));

      const text = await unavailable(dialog);
      assert.ok(text.includes(REASON.notAnswering), text);
      assert.equal(frameIn(dialog), null, 'the iframe is still there');
      assert.ok(editorClosed(client.closed), 'the client was not closed');
      assert.equal(
        query<HTMLButtonElement>(dialog, 'drawio-editor-back')?.disabled,
        false,
        'Voltar without XML',
      );
    },
    ['setInterval'],
  );
});

/* Unavailable without XML ----------------------------------------------------- */

test('R27: in indisponível without XML, Tentar de novo makes a new editor that loads the XML of B', async () => {
  const { dialog, drawing, client: first } = await indisponivel();

  await click(dialog, 'drawio-editor-retry');

  const client = await editorMounted(dialog, drawing, 2);
  assert.notEqual(client, first);
  assert.equal(unavailableIn(dialog), null);
  await drawing.editor.init();
  assert.deepEqual(
    client.loads.map((load) => load.request),
    [{ xml: XML, autosave: true }],
  );
  assert.equal(doneButtonIn(dialog)?.disabled, false, 'Concluir edição');
});

test('R29: in indisponível without XML, Voltar goes back to Revisar on B', async () => {
  const { dialog } = await indisponivel();

  await click(dialog, 'drawio-editor-back');

  await backInRevisar(dialog);
  await reads(dialog, 'papercraft-revision', 'rev 2');
  assert.equal(unavailableIn(dialog), null);
  assert.ok(editButtonIn(dialog) !== null, 'no Editar back in Revisar');
  assert.ok(modalOf() !== null, 'the modal closed');
});

test('R30: in indisponível without XML, a close request closes the modal', async () => {
  for (const [closer, close] of closers) {
    const { dialog, expand } = await indisponivel();

    await close(dialog);

    await until(
      modalOf,
      (found) => found === null,
      `${closer}: the modal is still open`,
    );
    await until(
      () => document.activeElement,
      (focused) => focused === expand,
      `${closer}: the focus is not back on Expandir`,
    );
    await unmountAll();
  }
});

/* Keys and links -------------------------------------------------------------- */

test('K3: CmdOrCtrl+S neither saves nor is taken in Revisar, and reads no XML in an unmodified editando', async () => {
  const revising = await revisar();
  const canvas = await canvasIn(revising.dialog);
  for (const chord of [{ ctrlKey: true }, { metaKey: true }]) {
    const taken = await keyTaken(canvas, 's', chord);
    assert.equal(taken, false, `Revisar took ${JSON.stringify(chord)}+S`);
  }
  await flush(3);
  assert.equal(revising.h.saves.length, 0, 'Revisar saved');
  await unmountAll();

  const { h, dialog, client } = await editando();
  await keyTaken(contentIn(dialog), 's', { ctrlKey: true });
  await keyTaken(contentIn(dialog), 's', { metaKey: true });
  await flush(3);
  assert.equal(client.getXmls.length, 0, 'CmdOrCtrl+S asked for the XML');
  assert.equal(h.saves.length, 0, 'CmdOrCtrl+S saved');
  assert.ok(frameIn(dialog) !== null, 'the editor left');
});

test('K4: in Editar, V, H and CmdOrCtrl+= change nothing', async () => {
  const { dialog, drawing, client } = await editando();
  const frame = frameIn(dialog);

  for (const [key, init] of [
    ['v', {}],
    ['h', {}],
    ['=', { ctrlKey: true }],
    ['=', { metaKey: true }],
  ] as const) {
    const taken = await keyTaken(contentIn(dialog), key, init);
    assert.equal(taken, false, `${key} ${JSON.stringify(init)} was taken`);
  }

  await flush(3);
  assert.equal(frameIn(dialog), frame, 'the editor was replaced');
  assert.equal(drawing.editor.clients.length, 1);
  assert.equal(client.closed, 0);
  assert.equal(unavailableIn(dialog), null);
  assert.ok(query(dialog, 'drawio-edit-toolbar') !== null);
});

test('L1: in editando, openLink and exit open nothing, change no phase and keep the iframe', async () => {
  const { dialog, drawing, client } = await editando();
  const frame = frameIn(dialog);
  const target = window as unknown as { open: (...args: unknown[]) => unknown };
  const original = target.open;
  const opened: unknown[] = [];
  target.open = (...args: unknown[]) => {
    opened.push(args);

    return null;
  };

  try {
    await drawing.editor.emit({
      event: 'openLink',
      href: 'https://example.com/',
      target: '_blank',
      allowOpener: false,
    });
    await drawing.editor.emit({ event: 'exit', modified: false });
    await flush(3);
  } finally {
    target.open = original;
  }

  assert.deepEqual(opened, [], 'window.open was called');
  assert.ok(frame !== null);
  assert.equal(frameIn(dialog), frame, 'the iframe was replaced');
  assert.equal(drawing.editor.clients.length, 1);
  assert.equal(client.closed, 0, 'the client was closed');
  assert.ok(modalOf() !== null, 'the modal closed');
  assert.equal(unavailableIn(dialog), null);
  assert.equal(doneButtonIn(dialog)?.disabled, false, 'Concluir edição');
  assert.equal(saveButtonIn(dialog)?.disabled, true, 'Salvar');
});
