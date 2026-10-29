// The diagram's modal asking before an unsaved edit is lost (spec "Máquina de
// estados do modal do diagrama", rows 14, 15, 24 and the exit dialog D1–D3,
// phase 3; plan §2 "Exit dialog", §5 sub-step 3.6 and §6). In
// `carregando-modificado`, `editando-modificado` and `indisponível` with XML,
// Concluir edição / Voltar open the exit dialog towards Revisar, and each close
// request opens it towards `fechado`; the dialog then saves, discards or goes
// back to editing. The editor's `DrawioClient` is faked at the iframe boundary
// (`fakeDrawing().editor`); every host service is faked
// (`support/diagram-harness.ts`).
//
// Contract matrix (plan §6):
// - R14a/b/c (Concluir edição / Voltar), R15a/b/c (each closer);
// - D1a (Salvar towards revisar), D1b = R24 (Salvar towards fechado),
//   D1 + row 25 (the save from the dialog fails);
// - D2a/b (Descartar), D3a/b/c (Continuar editando, Esc, dialog backdrop);
// - D4 (the load answering under the dialog); C5 (asks on every closer).

import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';

import { DrawioError } from '@drawio/react';
import { ContractError } from 'bundle/contracts';

import {
  ARTIFACT,
  drawingModule,
  fakeDrawing,
  type Harness,
  harness,
  loadClient,
  react,
  recordsThrough4,
  unmountAll,
  until,
  XML,
} from './support/diagram-harness.js';
import { window } from './support/dom.js';
import {
  click,
  closers,
  drawnNode,
  editorMounted,
  exitAsked,
  exitDialogOf,
  exitEscape,
  exitGone,
  exitPress,
  flush,
  frameIn,
  imageIn,
  modalOf,
  open,
  pressEdit,
  pressExitBackdrop,
  reads,
  saveButtonIn,
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

/** The editor's XML after the user's edit (an `autosave`): the memory. */
const X1 = XML.replace('value="A"', 'value="A1"');

/** The modal open in Revisar on revision 2 (B), page 1. */
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
  await salvarEnabled(
    editing.dialog,
    'Salvar never enabled in editando-modificado',
  );

  return editing;
};

/** `editando-modificado`, then an unexpected `init`: `carregando-modificado` (row 20). */
const carregandoModificado = async (h: Harness = harness()) => {
  const modified = await modificado(h);
  await modified.drawing.editor.init();
  await flush(2);

  return modified;
};

/** `carregando-modificado`, then the load fails: `indisponível` with XML (row 11). */
const indisponivelComXml = async (h: Harness = harness()) => {
  const loading = await carregandoModificado(h);
  await loading.drawing.editor.rejectLoad(
    new DrawioError('editor', 'bad diagram'),
  );
  await unavailable(loading.dialog);

  return loading;
};

type State = 'carregando-modificado' | 'editando-modificado' | 'indisponível';

/** The three states holding an unsaved edit, and how each leaves for Revisar (row 14). */
const states: readonly [
  State,
  (h: Harness) => ReturnType<typeof modificado>,
  string,
][] = [
  ['carregando-modificado', carregandoModificado, 'drawio-done'],
  ['editando-modificado', modificado, 'drawio-done'],
  ['indisponível', indisponivelComXml, 'drawio-editor-back'],
];

const salvarEnabled = (dialog: HTMLElement, message: string) =>
  untilFlushed(
    () => saveButtonIn(dialog)?.disabled,
    (disabled) => disabled === false,
    message,
  );

const loadsOf = (client: { loads: { request: unknown }[] }) =>
  client.loads.map((load) => load.request);

/** Waits for Revisar back on screen: the drawing and no editor. */
const backInRevisar = (dialog: HTMLElement) =>
  untilFlushed(
    () => imageIn(dialog) !== null && frameIn(dialog) === null,
    (back) => back,
    'Revisar never came back',
  );

/** Waits for the modal to close and the focus to return to Expandir (`onCloseRequest`). */
const closedOnExpand = async (expand: HTMLElement, label: string) => {
  await until(
    modalOf,
    (found) => found === null,
    `${label}: the modal is still open`,
  );
  await until(
    () => document.activeElement,
    (focused) => focused === expand,
    `${label}: the focus is not back on Expandir`,
  );
};

/** The state under the dialog did not change: the editor (or `indisponível`) is still there. */
const stillIn = (dialog: HTMLElement, state: State, label: string) => {
  assert.ok(modalOf() !== null, `${label}: the modal closed`);
  assert.equal(
    dialog.querySelector('[data-testid="drawio-saving"]'),
    null,
    `${label}: saving`,
  );
  if (state === 'indisponível') {
    assert.ok(unavailableIn(dialog) !== null, `${label}: left indisponível`);
    assert.equal(frameIn(dialog), null, `${label}: an editor came back`);
  } else {
    assert.ok(frameIn(dialog) !== null, `${label}: the iframe is gone`);
    assert.equal(unavailableIn(dialog), null, `${label}: indisponível`);
  }
};

/** The close request `name` of `closers`. */
const closerNamed = (name: string) => {
  const found = closers.find(([closer]) => closer === name);
  if (found === undefined) throw new Error(`no closer ${name}`);

  return found[1];
};

/** The open exit dialog is an alert dialog. */
const alertDialog = (exit: HTMLElement, label: string) =>
  assert.equal(exit.getAttribute('role'), 'alertdialog', label);

/* Rows 14 and 15 -------------------------------------------------------------- */

test('R14a/b/c: in carregando-modificado, editando-modificado and indisponível with XML, Concluir edição / Voltar opens the exit dialog towards Revisar without changing the state', async () => {
  for (const [state, reach, leave] of states) {
    const h = harness();
    const { dialog, client } = await reach(h);

    await click(dialog, leave);

    const exit = await exitAsked(`${state}: ${leave} never opened the dialog`);
    alertDialog(exit, state);
    stillIn(dialog, state, state);
    if (state !== 'indisponível') {
      assert.equal(client.closed, 0, `${state}: the client was closed`);
    }

    // The destination is Revisar: Descartar (D2) lands there, the modal open.
    await exitPress('drawio-exit-discard');
    await backInRevisar(dialog);
    assert.ok(modalOf() !== null, `${state}: the destination closed it`);
    assert.equal(h.saves.length, 0, state);
    await unmountAll();
  }
});

test('R15a/b/c: in carregando-modificado, editando-modificado and indisponível with XML, Esc, the backdrop and the close button open the exit dialog towards fechado; the modal stays open', async () => {
  for (const [state, reach] of states) {
    for (const [closer, close] of closers) {
      const label = `${state}, ${closer}`;
      const h = harness();
      const { dialog, expand } = await reach(h);

      await close(dialog);

      const exit = await exitAsked(`${label}: the dialog never opened`);
      alertDialog(exit, label);
      await flush(3);
      stillIn(dialog, state, label);

      // The destination is fechado: Descartar (D2) closes the modal.
      await exitPress('drawio-exit-discard');
      await closedOnExpand(expand, label);
      assert.equal(h.saves.length, 0, label);
      await unmountAll();
    }
  }
});

test('C5: closing with nothing to lose goes straight out; with a modification Esc, the backdrop and the close button all ask first', async () => {
  for (const [closer, close] of closers) {
    const unmodified = await editando();
    await close(unmodified.dialog);
    await closedOnExpand(unmodified.expand, `editando, ${closer}`);
    await unmountAll();

    const { dialog } = await modificado();
    await close(dialog);
    await exitAsked(`editando-modificado, ${closer}: closed without asking`);
    await flush(3);
    assert.ok(modalOf() !== null, `editando-modificado, ${closer}: closed`);
    await unmountAll();
  }
});

/* D1: Salvar ------------------------------------------------------------------ */

test('D1a: Salvar towards Revisar closes the dialog and the editor, saves the memory without asking the editor, and shows the answered revision', async () => {
  const h = harness();
  const sha = await drawingModule.sha256Hex(X1);
  h.readsOf.set(4, { status: 'ok', xml: X1, revision: 4, revisions: 4 });
  const { dialog, client } = await modificado(h);
  h.revisions = recordsThrough4(sha);
  const getXmls = client.getXmls.length;
  await click(dialog, 'drawio-done');
  await exitAsked('Concluir edição never opened the dialog');

  await exitPress('drawio-exit-save');

  await untilFlushed(
    () => h.saves.length,
    (length) => length === 1,
    'Salvar in the dialog never saved',
  );
  assert.deepEqual(h.saves, [{ artifactId: ARTIFACT, xml: X1 }]);
  assert.equal(client.getXmls.length, getXmls, 'Salvar asked for the XML');
  assert.equal(exitDialogOf(), null, 'the dialog stayed open');
  assert.ok(client.closed >= 1, 'the client was not closed');
  await backInRevisar(dialog);
  await reads(dialog, 'papercraft-revision', 'rev 4');
  assert.ok(modalOf() !== null, 'the modal closed');
});

test('D1b / R24: Salvar towards fechado shows Salvando…, and once save answers the modal closes back on Expandir', async () => {
  const h = harness();
  h.saveDefault = 'pending';
  const sha = await drawingModule.sha256Hex(X1);
  const { dialog, expand, client } = await modificado(h);
  await closerNamed('the backdrop')(dialog);
  await exitAsked('the backdrop never opened the dialog');

  await exitPress('drawio-exit-save');

  await untilFlushed(
    () => h.saves.length,
    (length) => length === 1,
    'Salvar in the dialog never saved',
  );
  assert.deepEqual(h.saves, [{ artifactId: ARTIFACT, xml: X1 }]);
  assert.equal(exitDialogOf(), null, 'the dialog stayed open');
  assert.ok(client.closed >= 1, 'the client was not closed');
  await reads(dialog, 'drawio-saving', 'Salvando…');
  assert.ok(modalOf() !== null, 'closed before save answered');

  await react.act(async () => {
    h.pendingSaves[0]?.resolve({ revision: 4, revisions: 4, sha256: sha });
  });

  await closedOnExpand(expand, 'R24');
});

test('D1 + row 25: a save from the dialog that fails shows the reason and the editor returns with the memory, the modal open', async () => {
  const h = harness();
  h.saveScript.push({ reject: new ContractError('invalid_input', 'bad') });
  const { dialog, drawing } = await modificado(h);
  await closerNamed('the close button')(dialog);
  await exitAsked('the close button never opened the dialog');

  await exitPress('drawio-exit-save');

  await reads(
    dialog,
    'drawio-banner-save-error',
    'Não foi possível salvar: bad',
  );
  const client = await editorMounted(dialog, drawing, 2);
  assert.ok(modalOf() !== null, 'the failed save closed the modal');
  assert.equal(exitDialogOf(), null, 'the dialog came back');
  await drawing.editor.init();
  assert.deepEqual(loadsOf(client), [{ xml: X1, autosave: true }]);
  assert.equal(saveButtonIn(dialog)?.disabled, true, 'Salvar while loading');
  await drawing.editor.resolveLoad();
  await salvarEnabled(dialog, 'Salvar never enabled once the memory loaded');
  assert.equal(h.saves.length, 1);
});

/* D2: Descartar --------------------------------------------------------------- */

test('D2a: Descartar towards Revisar shows B and forgets the memory: Editar again loads the XML of B', async () => {
  const h = harness();
  const { dialog, drawing, client } = await modificado(h);
  await click(dialog, 'drawio-done');
  await exitAsked('Concluir edição never opened the dialog');

  await exitPress('drawio-exit-discard');

  await backInRevisar(dialog);
  await reads(dialog, 'papercraft-revision', 'rev 2');
  assert.equal(exitDialogOf(), null, 'the dialog stayed open');
  assert.ok(client.closed >= 1, 'the client was not closed');
  assert.equal(h.saves.length, 0, 'Descartar saved');

  await pressEdit(dialog);
  const again = await editorMounted(dialog, drawing, 2);
  await drawing.editor.init();
  assert.deepEqual(loadsOf(again), [{ xml: XML, autosave: true }]);
});

test('D2b: Descartar towards fechado closes the modal; opening it and Editar again loads the XML of B', async () => {
  const h = harness();
  const { body, dialog, drawing, expand, client } = await modificado(h);
  await closerNamed('Esc')(dialog);
  await exitAsked('Esc never opened the dialog');

  await exitPress('drawio-exit-discard');

  await closedOnExpand(expand, 'D2b');
  assert.ok(client.closed >= 1, 'the client was not closed');
  assert.equal(h.saves.length, 0, 'Descartar saved');

  const reopened = await open(body);
  await pressEdit(reopened.dialog);
  const again = await editorMounted(reopened.dialog, drawing, 2);
  await drawing.editor.init();
  assert.deepEqual(loadsOf(again), [{ xml: XML, autosave: true }]);
});

/* D3: back to editing --------------------------------------------------------- */

test('D3a/b/c: Continuar editando, Esc and the dialog backdrop close the dialog only: the state, the editor and the modal stay', async () => {
  const ways: readonly [string, () => Promise<void>][] = [
    ['Continuar editando', async () => exitPress('drawio-exit-continue')],
    ['Esc', exitEscape],
    ['the dialog backdrop', pressExitBackdrop],
  ];

  for (const [way, back] of ways) {
    for (const [opener, ask] of [
      ['Concluir edição', async (on: HTMLElement) => click(on, 'drawio-done')],
      ...closers,
    ] as const) {
      const label = `${opener}, then ${way}`;
      const h = harness();
      const { dialog, client } = await modificado(h);
      await ask(dialog);
      await exitAsked(`${label}: the dialog never opened`);

      await back();

      await exitGone(`${label}: the dialog stayed open`);
      await flush(3);
      assert.ok(modalOf() !== null, `${label}: the modal closed`);
      stillIn(dialog, 'editando-modificado', label);
      assert.equal(saveButtonIn(dialog)?.disabled, false, `${label}: Salvar`);
      assert.equal(client.closed, 0, `${label}: the client was closed`);
      assert.equal(h.saves.length, 0, `${label}: saved`);
      await unmountAll();
    }
  }
});

/* D4 -------------------------------------------------------------------------- */

test('D4: the load answering under the dialog leads to editando-modificado, and the dialog stays open', async () => {
  const { dialog, drawing } = await carregandoModificado();
  assert.equal(saveButtonIn(dialog)?.disabled, true, 'Salvar while loading');
  await click(dialog, 'drawio-done');
  await exitAsked('Concluir edição never opened the dialog');

  await drawing.editor.resolveLoad();
  await flush(3);

  assert.ok(exitDialogOf() !== null, 'the load closed the dialog');
  stillIn(dialog, 'editando-modificado', 'D4');
  await exitPress('drawio-exit-continue');
  await exitGone('the dialog stayed open');
  await salvarEnabled(dialog, 'the state under the dialog stayed carregando');
});
