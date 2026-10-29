// The diagram's modal in Editar with a modification, and the save (spec
// "Máquina de estados do modal do diagrama", phase 3; plan §5 sub-step 3.5 and
// §6): `autosave` keeps the editor's XML in memory, restarts reload it, the
// editor not answering keeps it, Salvar / CmdOrCtrl+S / `shortcut save` read
// it and save it, and the save's answer leads to Revisar on the answered
// revision or back to the editor. Since sub-step 3.6, `indisponível` with XML
// asks before leaving: Voltar and each close request open the exit dialog
// (rows 14, 15; the dialog itself is in `diagram-exit.test.tsx`). The
// editor's `DrawioClient` is faked at the iframe boundary
// (`fakeDrawing().editor`); every host service is faked
// (`support/diagram-harness.ts`).
//
// Contract matrix (plan §6):
// - R8, R9b, R11a/b (carregando-modificado);
// - R16, R17 (autosave), R18a/b/c (Salvar, CmdOrCtrl+S, shortcut save);
// - R20, R22a/b (restart and not answering with a modification);
// - R23, R23b, R25a/b, R26 (salvando), R28 (indisponível with XML);
// - K3 remainder (CmdOrCtrl+S taken in editando-modificado), C4.

import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';

import { DrawioError } from '@drawio/react';
import { ContractError } from 'bundle/contracts';

import {
  EDITOR_HEARTBEAT_MS,
  EDITOR_LOAD_TIMEOUT_MS,
} from '../../src/contracts/index.js';
import {
  ARTIFACT,
  drawingModule,
  fakeDrawing,
  type Harness,
  harness,
  loadClient,
  query,
  react,
  recordsThrough4,
  SHA_R3,
  unmountAll,
  withMockTimers,
  XML,
} from './support/diagram-harness.js';
import { window } from './support/dom.js';
import {
  click,
  closers,
  contentIn,
  drawnNode,
  editorMounted,
  exitAsked,
  exitGone,
  exitPress,
  flush,
  frameIn,
  imageIn,
  keyTaken,
  modalOf,
  open,
  pressEdit,
  reads,
  saveButtonIn,
  textIn,
  triggerOf,
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

/** The editor's XML after the user's edits: X1 and X2 (autosaves), X3 (the save's `getXml`). */
const X1 = XML.replace('value="A"', 'value="A1"');
const X2 = XML.replace('value="A"', 'value="A2"');
const X3 = XML.replace('value="A"', 'value="A3"');

/** The `indisponível` copy (plan §3.8, `unavailableReasonOf`). */
const REASON = {
  loadFailed: 'O editor não carregou o diagrama',
  notAnswering: 'O editor parou de responder',
} as const;

/** The banners (plan §3.8). */
const RESTARTED =
  'O editor reiniciou; a edição voltou do último salvamento automático';
/** The phase-2 phrase for a missing lease (`diagram-view.tsx`, `unleased`). */
const NO_LEASE = 'O Project está sem sandbox ativo';

/** The modal open in Revisar on revision 2, page 1. */
const revisar = async (h: Harness = harness()) => {
  const drawing = fakeDrawing();
  const { body } = await drawnNode(h, drawing);
  const { dialog, button } = await open(body);

  return { h, drawing, body, dialog, expand: button };
};

/** Editar pressed, `init` and its `load` answered: `editando`. */
const editando = async (h: Harness = harness()) => {
  const opened = await revisar(h);
  await pressEdit(opened.dialog);
  const client = await editorMounted(opened.dialog, opened.drawing);
  await opened.drawing.editor.init();
  await opened.drawing.editor.resolveLoad();
  await flush(2);

  return { ...opened, client };
};

/** `editando`, then `autosave{xml: X1}`: `editando-modificado` (row 16). */
const modificado = async (h: Harness = harness()) => {
  const editing = await editando(h);
  await editing.drawing.editor.emit({ event: 'autosave', xml: X1 });
  await flush(3);

  return editing;
};

/** `editando-modificado`, then an unexpected `init`: `carregando-modificado` (row 20). */
const carregandoModificado = async (h: Harness = harness()) => {
  const modified = await modificado(h);
  await modified.drawing.editor.init();
  await flush(2);

  return modified;
};

const loadsOf = (client: { loads: { request: unknown }[] }) =>
  client.loads.map((load) => load.request);

const salvarEnabled = (dialog: HTMLElement, message: string) =>
  untilFlushed(
    () => saveButtonIn(dialog)?.disabled,
    (disabled) => disabled === false,
    message,
  );

/** Presses Salvar and waits for its `getXml` (row 18), without answering it. */
const pressSave = async (
  dialog: HTMLElement,
  client: { getXmls: unknown[] },
) => {
  const before = client.getXmls.length;
  await click(dialog, 'drawio-save');
  await untilFlushed(
    () => client.getXmls.length,
    (length) => length === before + 1,
    'Salvar never asked the editor for its XML (getXml)',
  );
};

/** `editando-modificado`, Salvar, and its `getXml` answered X3: `salvando`. */
const salvando = async (h: Harness = harness()) => {
  const modified = await modificado(h);
  await pressSave(modified.dialog, modified.client);
  await modified.drawing.editor.answerXml(X3);
  await untilFlushed(
    () => h.saves.length,
    (length) => length === 1,
    'the save was never called',
  );

  return modified;
};

/** Waits for Revisar back on screen: the drawing and no editor. */
const backInRevisar = (dialog: HTMLElement) =>
  untilFlushed(
    () => imageIn(dialog) !== null && frameIn(dialog) === null,
    (back) => back,
    'Revisar never came back',
  );

/** The harness answers revision 4 with X3, as `save`'s default answer names it. */
const answeringRevision4 = async (h: Harness) => {
  const sha = await drawingModule.sha256Hex(X3);
  h.readsOf.set(4, { status: 'ok', xml: X3, revision: 4, revisions: 4 });

  return sha;
};

/**
 * `indisponível` with XML asks before leaving (rows 14, 15): Voltar and each
 * close request open the exit dialog over it, and Continuar editando (D3)
 * leaves it as it was, with the modal open.
 */
const asksWithXml = async (dialog: HTMLElement, label: string) => {
  const leaves: readonly [string, (dialog: HTMLElement) => Promise<void>][] = [
    ['Voltar', async (on) => click(on, 'drawio-editor-back')],
    ...closers,
  ];
  for (const [leave, request] of leaves) {
    await request(dialog);
    await exitAsked(`${label}, ${leave}: the exit dialog never opened`);
    assert.ok(modalOf() !== null, `${label}, ${leave}: the modal closed`);
    assert.ok(unavailableIn(dialog) !== null, `${label}, ${leave}`);

    await exitPress('drawio-exit-continue');
    await exitGone(`${label}, ${leave}: the exit dialog stayed open`);
    assert.ok(modalOf() !== null, `${label}, ${leave}: the modal closed`);
    assert.ok(unavailableIn(dialog) !== null, `${label}, ${leave}`);
  }
};

/** Tentar de novo from `indisponível` with XML loads `xml` in a new client (row 28). */
const retryLoads = async (
  dialog: HTMLElement,
  drawing: ReturnType<typeof fakeDrawing>,
  count: number,
  xml: string,
  label: string,
) => {
  await click(dialog, 'drawio-editor-retry');
  const client = await editorMounted(dialog, drawing, count);
  assert.equal(unavailableIn(dialog), null, label);
  await drawing.editor.init();
  assert.deepEqual(loadsOf(client), [{ xml, autosave: true }], label);

  return client;
};

/* Autosave -------------------------------------------------------------------- */

test('R16: in editando, autosave keeps the XML and leads to editando-modificado: Salvar enabled, nothing saved', async () => {
  const { h, dialog, drawing, client } = await editando();
  assert.equal(saveButtonIn(dialog)?.disabled, true, 'Salvar in editando');

  await drawing.editor.emit({ event: 'autosave', xml: X1 });

  await salvarEnabled(dialog, 'Salvar never enabled after autosave');
  await flush(3);
  assert.equal(h.saves.length, 0, 'autosave saved');
  assert.equal(client.getXmls.length, 0, 'autosave asked for the XML');
  assert.ok(frameIn(dialog) !== null, 'the editor left');
});

test('R17: in editando-modificado, a later autosave replaces the memory: a restart loads X2, and nothing is saved', async () => {
  const { h, dialog, drawing, client } = await modificado();
  await drawing.editor.emit({ event: 'autosave', xml: X2 });
  await flush(3);

  await drawing.editor.init();

  assert.deepEqual(loadsOf(client), [
    { xml: XML, autosave: true },
    { xml: X2, autosave: true },
  ]);
  assert.equal(h.saves.length, 0, 'autosave saved');
  assert.ok(frameIn(dialog) !== null);
});

test('C4: no autosave, in editando or editando-modificado, ever calls save', async () => {
  const { h, dialog, drawing } = await editando();

  for (const xml of [X1, X2, X1]) {
    await drawing.editor.emit({ event: 'autosave', xml });
  }
  await drawing.editor.init();
  await drawing.editor.resolveLoad();
  await drawing.editor.emit({ event: 'autosave', xml: X3 });
  await flush(5);

  await salvarEnabled(dialog, 'Salvar never enabled after the autosaves');
  assert.equal(h.saves.length, 0, 'an autosave saved');
});

/* carregando-modificado ------------------------------------------------------- */

test('R20: in editando-modificado, an unexpected init loads the memory, shows the restarted banner and goes to carregando-modificado', async () => {
  const { dialog, drawing, client } = await modificado();
  await salvarEnabled(dialog, 'Salvar never enabled in editando-modificado');

  await drawing.editor.init();

  assert.deepEqual(loadsOf(client), [
    { xml: XML, autosave: true },
    { xml: X1, autosave: true },
  ]);
  await reads(dialog, 'drawio-banner-restarted', RESTARTED);
  assert.equal(saveButtonIn(dialog)?.disabled, true, 'Salvar while loading');
  assert.ok(frameIn(dialog) !== null);
  assert.equal(unavailableIn(dialog), null);
});

test('R8: in carregando-modificado, the load answering leads to editando-modificado with Salvar enabled', async () => {
  const { dialog, drawing, client } = await carregandoModificado();
  assert.deepEqual(loadsOf(client).at(-1), { xml: X1, autosave: true });
  assert.equal(saveButtonIn(dialog)?.disabled, true, 'Salvar while loading');

  await drawing.editor.resolveLoad();

  await salvarEnabled(dialog, 'Salvar never enabled once loaded again');
  assert.ok(frameIn(dialog) !== null);
});

test('R9b: in carregando-modificado, another init loads the memory again', async () => {
  const { dialog, drawing, client } = await carregandoModificado();

  await drawing.editor.init();

  assert.deepEqual(loadsOf(client), [
    { xml: XML, autosave: true },
    { xml: X1, autosave: true },
    { xml: X1, autosave: true },
  ]);
  assert.ok(frameIn(dialog) !== null);
  assert.equal(unavailableIn(dialog), null);
});

test('R11a: in carregando-modificado, EDITOR_LOAD_TIMEOUT_MS without a load gives indisponível with XML; Tentar de novo loads the memory', async () => {
  const { dialog, drawing } = await revisar();

  await withMockTimers(
    async (timers) => {
      await pressEdit(dialog);
      const first = await editorMounted(dialog, drawing);
      await drawing.editor.init();
      await drawing.editor.resolveLoad();
      await drawing.editor.emit({ event: 'autosave', xml: X1 });
      await flush(3);
      await drawing.editor.init();
      assert.deepEqual(loadsOf(first).at(-1), { xml: X1, autosave: true });

      await react.act(async () => timers.tick(EDITOR_LOAD_TIMEOUT_MS - 1));
      await flush(3);
      assert.ok(
        frameIn(dialog) !== null,
        'the editor left before its deadline',
      );

      await react.act(async () => timers.tick(1));
      const text = await unavailable(dialog);
      assert.ok(text.includes(REASON.loadFailed), text);
      assert.equal(frameIn(dialog), null, 'the iframe is still there');
      assert.ok(first.closed >= 1, 'the client was not closed');
    },
    ['setTimeout'],
  );

  await asksWithXml(dialog, 'R11a');
  await retryLoads(dialog, drawing, 2, X1, 'R11a: Tentar de novo');
});

test('R11b: in carregando-modificado, a DrawioError from load gives indisponível with XML; Tentar de novo loads the memory', async () => {
  const { dialog, drawing, client } = await carregandoModificado();

  await drawing.editor.rejectLoad(new DrawioError('editor', 'bad diagram'));

  const text = await unavailable(dialog);
  assert.ok(text.includes(REASON.loadFailed), text);
  assert.equal(frameIn(dialog), null, 'the iframe is still there');
  assert.ok(client.closed >= 1, 'the client was not closed');
  await asksWithXml(dialog, 'R11b');
  await retryLoads(dialog, drawing, 2, X1, 'R11b: Tentar de novo');
});

/* Not answering --------------------------------------------------------------- */

test('R22a: in editando-modificado, a heartbeat getXml timing out gives indisponível with XML (C8)', async () => {
  const { dialog, drawing } = await revisar();

  await withMockTimers(
    async (timers) => {
      await pressEdit(dialog);
      const client = await editorMounted(dialog, drawing);
      assert.equal(client.options.requestTimeout, EDITOR_LOAD_TIMEOUT_MS);
      await drawing.editor.init();
      await drawing.editor.resolveLoad();
      await drawing.editor.emit({ event: 'autosave', xml: X1 });
      await salvarEnabled(
        dialog,
        'Salvar never enabled in editando-modificado',
      );

      await react.act(async () => timers.tick(EDITOR_HEARTBEAT_MS));
      await untilFlushed(
        () => client.getXmls.length,
        (length) => length === 1,
        'no heartbeat getXml in editando-modificado',
      );
      await drawing.editor.failXml(new DrawioError('timeout', 'no answer'));

      const text = await unavailable(dialog);
      assert.ok(text.includes(REASON.notAnswering), text);
      assert.equal(frameIn(dialog), null, 'the iframe is still there');
      assert.ok(client.closed >= 1, 'the client was not closed');
    },
    ['setInterval'],
  );

  await asksWithXml(dialog, 'R22a');
  await retryLoads(dialog, drawing, 2, X1, 'R22a: Tentar de novo');
});

test("R22b: row 18's getXml timing out gives indisponível with XML, and nothing is saved", async () => {
  const { h, dialog, drawing, client } = await modificado();
  await salvarEnabled(dialog, 'Salvar never enabled in editando-modificado');
  await pressSave(dialog, client);

  await drawing.editor.failXml(new DrawioError('timeout', 'no answer'));

  const text = await unavailable(dialog);
  assert.ok(text.includes(REASON.notAnswering), text);
  assert.equal(frameIn(dialog), null, 'the iframe is still there');
  assert.equal(h.saves.length, 0, 'saved without the XML');
  await asksWithXml(dialog, 'R22b');
  await retryLoads(dialog, drawing, 2, X1, 'R22b: Tentar de novo');
});

/* Saving ---------------------------------------------------------------------- */

test('R18a/b/c + K3: Salvar, CmdOrCtrl+S and shortcut save read the XML, unload the editor and save it, showing Salvando…', async () => {
  const triggers: [
    string,
    (
      dialog: HTMLElement,
      drawing: ReturnType<typeof fakeDrawing>,
    ) => Promise<void>,
  ][] = [
    ['Salvar', async (dialog) => click(dialog, 'drawio-save')],
    [
      'Ctrl+S',
      async (dialog) => {
        const taken = await keyTaken(contentIn(dialog), 's', { ctrlKey: true });
        assert.equal(taken, true, 'Ctrl+S was not default-prevented');
      },
    ],
    [
      'Meta+S',
      async (dialog) => {
        const taken = await keyTaken(contentIn(dialog), 'S', { metaKey: true });
        assert.equal(taken, true, 'Meta+S was not default-prevented');
      },
    ],
    [
      'shortcut save',
      async (_dialog, drawing) =>
        drawing.editor.emit({ event: 'shortcut', command: 'save' }),
    ],
  ];

  for (const [name, trigger] of triggers) {
    const h = harness();
    h.saveDefault = 'pending';
    const { dialog, drawing, client } = await modificado(h);
    await salvarEnabled(dialog, `${name}: Salvar never enabled`);
    const before = client.getXmls.length;

    await trigger(dialog, drawing);

    await untilFlushed(
      () => client.getXmls.length,
      (length) => length === before + 1,
      `${name}: no getXml`,
    );
    assert.equal(
      saveButtonIn(dialog)?.disabled,
      true,
      `${name}: Salvar while getXml is pending`,
    );
    assert.equal(h.saves.length, 0, `${name}: saved before the XML`);

    await drawing.editor.answerXml(X3);

    await untilFlushed(
      () => frameIn(dialog),
      (frame) => frame === null,
      `${name}: the editor was not unloaded`,
    );
    await untilFlushed(
      () => h.saves.length,
      (length) => length === 1,
      `${name}: save was not called`,
    );
    assert.deepEqual(h.saves, [{ artifactId: ARTIFACT, xml: X3 }], name);
    assert.ok(client.closed >= 1, `${name}: the client was not closed`);
    await reads(dialog, 'drawio-saving', 'Salvando…');
    await unmountAll();
  }
});

test('R23: save answering revision 4 leads to Revisar on revision 4, page 1, freshly drawn, with the revisions read again; Editar loads X3', async () => {
  const h = harness();
  const sha = await answeringRevision4(h);
  const { dialog, drawing } = await modificado(h);
  h.revisions = recordsThrough4(sha);
  const revisionCalls = h.revisionCalls.length;
  await salvarEnabled(dialog, 'Salvar never enabled in editando-modificado');
  await pressSave(dialog, drawing.editor.last());

  await drawing.editor.answerXml(X3);

  await backInRevisar(dialog);
  await reads(dialog, 'papercraft-revision', 'rev 4');
  await reads(dialog, 'drawio-page', 'pág 1/2');
  assert.deepEqual(h.saves, [{ artifactId: ARTIFACT, xml: X3 }]);
  const put = h.puts.find((stored) => stored.revision === 4);
  assert.equal(put?.sha256, sha);
  assert.equal(put?.pageId, 'p1');
  assert.equal(put?.first, true, 'revision 4 was not drawn fresh');
  const drawn = drawing.renders.find((request) => request.xml === X3);
  assert.equal(drawn?.pageId, 'p1');
  await untilFlushed(
    () => h.revisionCalls.length,
    (length) => length === revisionCalls + 1,
    'artifacts/v1.revisions was not read again',
  );
  await untilFlushed(
    () => triggerOf(dialog, 'Revisão')?.textContent?.trim(),
    (text) => text === 'rev 4/4',
    'the Revisão menu never read rev 4/4',
  );

  await pressEdit(dialog);
  const client = await editorMounted(dialog, drawing, 2);
  await drawing.editor.init();
  assert.deepEqual(loadsOf(client), [{ xml: X3, autosave: true }]);
});

test('R23b: save answering the unchanged latest revision leads to Revisar on it, with one save', async () => {
  const h = harness();
  h.saveScript.push({ revision: 3, revisions: 3, sha256: SHA_R3 });
  const { dialog, drawing } = await modificado(h);
  await salvarEnabled(dialog, 'Salvar never enabled in editando-modificado');
  await pressSave(dialog, drawing.editor.last());

  await drawing.editor.answerXml(X3);

  await backInRevisar(dialog);
  await reads(dialog, 'papercraft-revision', 'rev 3');
  assert.equal(h.saves.length, 1);
});

test('R25a: save rejecting invalid_input shows the reason, makes a new editor that loads the memory, in carregando-modificado', async () => {
  const h = harness();
  h.saveScript.push({ reject: new ContractError('invalid_input', 'bad') });
  const { dialog, drawing } = await salvando(h);

  await reads(
    dialog,
    'drawio-banner-save-error',
    'Não foi possível salvar: bad',
  );
  const client = await editorMounted(dialog, drawing, 2);
  assert.equal(query(dialog, 'drawio-saving'), null, 'still Salvando…');
  await drawing.editor.init();
  assert.deepEqual(loadsOf(client), [{ xml: X3, autosave: true }]);
  assert.equal(saveButtonIn(dialog)?.disabled, true, 'Salvar while loading');
  await drawing.editor.resolveLoad();
  await salvarEnabled(dialog, 'Salvar never enabled once the memory loaded');
  assert.equal(h.saves.length, 1);
});

test('R25b: save rejecting unavailable without a lease shows the lease phrase and the editor returns with the memory (C6)', async () => {
  const h = harness();
  h.saveScript.push({
    reject: new ContractError(
      'unavailable',
      'The Project has no sandbox lease (missing).',
      { lease: 'missing' },
    ),
  });
  const { dialog, drawing } = await salvando(h);

  await untilFlushed(
    () => textIn(dialog, 'drawio-banner-save-error'),
    (text) => text?.includes(NO_LEASE) === true,
    `the banner never named the lease: ${String(textIn(dialog, 'drawio-banner-save-error'))}`,
  );
  assert.ok(
    !textIn(dialog, 'drawio-banner-save-error')?.includes('sandbox lease'),
    'the banner shows the host message',
  );
  const client = await editorMounted(dialog, drawing, 2);
  await drawing.editor.init();
  assert.deepEqual(loadsOf(client), [{ xml: X3, autosave: true }]);
});

test('R26: in salvando, Esc, the backdrop and the close button change nothing; the answer then leads to Revisar', async () => {
  for (const [closer, close] of closers) {
    const h = harness();
    h.saveDefault = 'pending';
    const sha = await answeringRevision4(h);
    const { dialog } = await salvando(h);
    h.revisions = recordsThrough4(sha);
    await reads(dialog, 'drawio-saving', 'Salvando…');

    await close(dialog);
    await flush(5);

    assert.ok(modalOf() !== null, `${closer}: the modal closed`);
    assert.equal(textIn(dialog, 'drawio-saving'), 'Salvando…', closer);
    assert.equal(h.saves.length, 1, closer);

    await react.act(async () => {
      h.pendingSaves[0]?.resolve({ revision: 4, revisions: 4, sha256: sha });
    });
    await backInRevisar(dialog);
    await reads(dialog, 'papercraft-revision', 'rev 4');
    assert.ok(modalOf() !== null, `${closer}: the modal closed after saving`);
    await unmountAll();
  }
});

/* Unavailable with XML -------------------------------------------------------- */

test('R28: in indisponível with XML, Tentar de novo makes a new editor that loads the memory, in carregando-modificado', async () => {
  const { dialog, drawing, client: first } = await carregandoModificado();
  await drawing.editor.rejectLoad(new DrawioError('editor', 'bad diagram'));
  await unavailable(dialog);

  const client = await retryLoads(dialog, drawing, 2, X1, 'R28');

  assert.notEqual(client, first);
  assert.equal(saveButtonIn(dialog)?.disabled, true, 'Salvar while loading');
  await drawing.editor.resolveLoad();
  await salvarEnabled(dialog, 'Salvar never enabled once the memory loaded');
});
