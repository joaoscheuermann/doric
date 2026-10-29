// The diagram's modal saving the revision on screen to the Project (spec
// "Exportar", phase 4; plan §2 "Client", §3.6, §4 `diagram-modal.tsx` and
// §6 "Client"). In Revisar, Salvar no Project opens a dialog inside the
// modal: a path field (`docs/diagrams/<slug>`), a hint, Salvar, Cancelar and,
// when the files exist, Substituir. Salvar renders page 1 as `xmlsvg` with
// the injected `drawing.render` and calls `drawio.diagrams/v1.export`. The
// renderer and every host service are faked at their boundary
// (`support/diagram-harness.ts`); the toast is read from the one
// `desktop/ui/sonner` store the modal writes to.
//
// Contract matrix (plan §6 "Client"):
// - X1 the button's enabled state; X2 opening, the path and the hint;
// - X3 Salvar: the render, the export input, the toast; X4 page 2 of rev 1;
// - X5 `exists` and Substituir; X6 the three `blocked` reasons;
// - X7 a render that rejects; X8 export rejections; X9 no lease;
// - X10 `defaultExportPath`; X11 closing only the dialog; X12 while busy.

import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';

import { ContractError } from 'bundle/contracts';

import type { ExportResult } from '../../src/contracts/index.js';
import {
  ARTIFACT,
  fakeDrawing,
  type Harness,
  harness,
  loadClient,
  modal,
  query,
  react,
  type,
  unmountAll,
  until,
  XML,
  XML_R1,
  XMLSVG,
} from './support/diagram-harness.js';
import { window } from './support/dom.js';
import {
  choose,
  confirmExport,
  contentIn,
  drawnNode,
  exportButtonIn,
  exportDialogOf,
  exportEscape,
  exportGone,
  exportPathOf,
  exportPress,
  flush,
  frameIn,
  keyTaken,
  modalOf,
  onPageTwo,
  open,
  pressBackdrop,
  pressExport,
  pressExportBackdrop,
  triggerOf,
  untilFlushed,
} from './support/modal-gestures.js';

type Toasts = typeof import('desktop/ui/sonner');
let toasts: Toasts;

before(async () => {
  await loadClient();
  toasts = await import('desktop/ui/sonner');
});

afterEach(unmountAll);

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

/* Copy (plan §4 `ExportDialog`, spec "Exportar" steps 1, 2, 4, 5; Q5) --------- */

const hintOf = (path: string) =>
  `Grava ${path}.drawio, com todas as páginas, e ${path}.drawio.svg, só com a página 1`;
const writtenOf = (path: string) => `Gravado em ${path}.drawio e .drawio.svg`;
const RENDER_FAILED = 'O diagrama não pôde ser desenhado';
const NO_LEASE =
  'O Project está sem sandbox ativo; tente de novo quando ele voltar';
const failedOf = (message: string) =>
  `Não foi possível salvar no Project: ${message}`;
const BLOCKED: readonly [
  'directory' | 'special' | 'not-a-folder',
  string,
  string,
][] = [
  [
    'directory',
    'docs/diagrams/fluxo.drawio',
    'Já existe uma pasta em docs/diagrams/fluxo.drawio; escolha outro caminho',
  ],
  [
    'special',
    'docs/diagrams/fluxo.drawio.svg',
    'docs/diagrams/fluxo.drawio.svg não é um arquivo comum; escolha outro caminho',
  ],
  [
    'not-a-folder',
    'docs',
    'docs existe e não é uma pasta; escolha outro caminho',
  ],
];

/** The path the dialog starts with for the title `Fluxo`. */
const FLUXO = 'docs/diagrams/fluxo';

/* Helpers --------------------------------------------------------------------- */

/** The modal open in Revisar on revision 2, page 1. */
const revisar = async (h: Harness = harness()) => {
  const drawing = fakeDrawing();
  const { body } = await drawnNode(h, drawing);
  const { dialog } = await open(body);

  return { h, drawing, body, dialog };
};

/** Revisar, then Salvar no Project pressed: the dialog open. */
const exporting = async (h: Harness = harness()) => {
  const opened = await revisar(h);
  const exportDialog = await pressExport(opened.dialog);

  return { ...opened, exportDialog };
};

/** The renders that were the export's (`format: 'xmlsvg'`). */
const xmlsvgRenders = (drawing: ReturnType<typeof fakeDrawing>) =>
  drawing.renders.filter((request) => request.format === 'xmlsvg');

const textOfTestId = (testId: string) =>
  query(document.body, testId)?.textContent?.trim();

/** Waits until the dialog's `testId` reads `text`. */
const showsText = (testId: string, text: string) =>
  untilFlushed(
    () => textOfTestId(testId),
    (found) => found === text,
    `${testId} never read "${text}": ${String(textOfTestId(testId))}`,
  );

const buttonOf = (testId: string) =>
  query<HTMLButtonElement>(document.body, testId);

/** Waits for `count` export calls. */
const exportsMade = (h: Harness, count: number) =>
  untilFlushed(
    () => h.exports.length,
    (length) => length === count,
    `export was not called ${String(count)} time(s): ${String(h.exports.length)}`,
  );

/** The titles of the toasts shown since `from` (an index into the history). */
const toastsSince = (from: number) =>
  toasts.toast
    .getHistory()
    .slice(from)
    .map((entry) => ('title' in entry ? entry.title : undefined));

/* X1 -------------------------------------------------------------------------- */

test('X1: Salvar no Project is disabled while the revision on screen is unread or unleased, and enabled once it reads ok', async () => {
  const h = harness();
  h.readsPending.add(3);
  h.readsOf.set(1, { status: 'unleased', lease: 'missing' });
  const { dialog } = await revisar(h);
  await untilFlushed(
    () => exportButtonIn(dialog)?.disabled,
    (disabled) => disabled === false,
    'Salvar no Project (drawio-export) is not enabled on revision 2',
  );

  for (const revision of [3, 1]) {
    await choose(dialog, 'Revisão', `rev ${String(revision)}`);
    await until(
      () =>
        h.reads.some(
          (input) => (input as { revision?: number }).revision === revision,
        ),
      (read) => read,
      `revision ${String(revision)} was never read`,
    );
    await flush(5);
    assert.equal(
      exportButtonIn(dialog)?.disabled,
      true,
      `Salvar no Project on revision ${String(revision)}`,
    );
  }

  await choose(dialog, 'Revisão', 'rev 2');
  await untilFlushed(
    () => exportButtonIn(dialog)?.disabled,
    (disabled) => disabled === false,
    'Salvar no Project never enabled back on revision 2',
  );
});

/* X2 -------------------------------------------------------------------------- */

test('X2: Salvar no Project opens the dialog on docs/diagrams/fluxo, focused, with the hint; typing updates the hint', async () => {
  const { dialog } = await revisar();
  const button = await untilFlushed(
    () => exportButtonIn(dialog),
    (found) => found !== null,
    'Revisar has no Salvar no Project (drawio-export)',
  );
  assert.equal(button?.getAttribute('aria-label'), 'Salvar no Project');
  const edit = query(dialog, 'drawio-edit');
  assert.ok(
    edit !== null &&
      button !== null &&
      (edit.compareDocumentPosition(button) &
        window.Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
    'Salvar no Project does not come after Editar',
  );

  await pressExport(dialog);
  const field = exportPathOf();
  assert.equal(field?.value, FLUXO);
  assert.equal(document.activeElement, field, 'the path field has no focus');
  assert.equal(textOfTestId('drawio-export-hint'), hintOf(FLUXO));
  assert.equal(
    buttonOf('drawio-export-replace'),
    null,
    'Substituir before exists',
  );

  await react.act(async () => type(field as HTMLInputElement, 'docs/outro'));
  await showsText('drawio-export-hint', hintOf('docs/outro'));
});

/* X3 -------------------------------------------------------------------------- */

test('X3: Salvar renders page 1 as light xmlsvg without pageId, exports it, closes the dialog and toasts the files', async () => {
  const h = harness();
  const { drawing } = await exporting(h);
  const from = toasts.toast.getHistory().length;

  await confirmExport();
  await exportsMade(h, 1);

  assert.deepEqual(xmlsvgRenders(drawing), [
    { xml: XML, theme: 'light', format: 'xmlsvg' },
  ]);
  assert.deepEqual(h.exports, [
    {
      artifactId: ARTIFACT,
      revision: 2,
      path: FLUXO,
      svg: XMLSVG,
      overwrite: false,
    },
  ]);
  await exportGone('the dialog stayed open after written');
  assert.ok(modalOf() !== null, 'the modal closed');
  await untilFlushed(
    () => toastsSince(from),
    (titles) => titles.includes(writtenOf(FLUXO)),
    `no toast "${writtenOf(FLUXO)}": ${JSON.stringify(toastsSince(from))}`,
  );
});

/* X4 -------------------------------------------------------------------------- */

test('X4: on page 2 of revision 1, Salvar renders revision 1 without pageId and exports revision 1', async () => {
  const h = harness();
  const { dialog, drawing } = await revisar(h);
  await choose(dialog, 'Revisão', 'rev 1');
  await until(
    () => triggerOf(dialog, 'Revisão')?.textContent?.trim(),
    (text) => text === 'rev 1/3',
    'the Revisão menu never read rev 1/3',
  );
  await onPageTwo(dialog);

  await pressExport(dialog);
  await confirmExport();
  await exportsMade(h, 1);

  assert.deepEqual(xmlsvgRenders(drawing), [
    { xml: XML_R1, theme: 'light', format: 'xmlsvg' },
  ]);
  assert.equal(h.exports[0]?.revision, 1);
  assert.equal(h.exports[0]?.overwrite, false);
});

/* X5 -------------------------------------------------------------------------- */

const EXISTS: ExportResult = {
  status: 'exists',
  files: [`${FLUXO}.drawio`, `${FLUXO}.drawio.svg`],
};

test('X5a: exists lists the files and offers Substituir, which exports again with overwrite and the same SVG, rendering once', async () => {
  const h = harness();
  h.exportScript.push(EXISTS);
  const { drawing } = await exporting(h);
  const from = toasts.toast.getHistory().length;

  await confirmExport();
  await exportsMade(h, 1);
  const existing = await untilFlushed(
    () => query(document.body, 'drawio-export-existing'),
    (found) => found !== null,
    'exists never listed the files (drawio-export-existing)',
  );
  for (const file of EXISTS.status === 'exists' ? EXISTS.files : []) {
    assert.ok(
      existing?.textContent?.includes(file),
      `the list misses ${file}: ${String(existing?.textContent)}`,
    );
  }
  assert.ok(buttonOf('drawio-export-replace') !== null, 'no Substituir');

  await exportPress('drawio-export-replace');
  await exportsMade(h, 2);

  assert.deepEqual(h.exports[1], { ...h.exports[0], overwrite: true });
  assert.equal(xmlsvgRenders(drawing).length, 1, 'Substituir rendered again');
  await exportGone('the dialog stayed open after Substituir wrote');
  await untilFlushed(
    () => toastsSince(from),
    (titles) => titles.includes(writtenOf(FLUXO)),
    `no toast "${writtenOf(FLUXO)}": ${JSON.stringify(toastsSince(from))}`,
  );
});

test('X5b: Cancelar on exists closes the dialog without a second export', async () => {
  const h = harness();
  h.exportScript.push(EXISTS);
  await exporting(h);

  await confirmExport();
  await untilFlushed(
    () => buttonOf('drawio-export-replace'),
    (found) => found !== null,
    'exists never offered Substituir',
  );
  await exportPress('drawio-export-cancel');
  await exportGone('Cancelar left the dialog open');
  await flush(5);

  assert.equal(h.exports.length, 1);
  assert.ok(modalOf() !== null, 'Cancelar closed the modal');
});

/* X6 -------------------------------------------------------------------------- */

test('X6: blocked shows the reason with the path, offers no Substituir, keeps the dialog open, and the next Salvar sends the new path', async () => {
  for (const [reason, path, message] of BLOCKED) {
    const h = harness();
    h.exportScript.push({ status: 'blocked', path, reason });
    await exporting(h);

    await confirmExport();
    await showsText('drawio-export-message', message);
    assert.equal(
      query(document.body, 'drawio-export-message')?.getAttribute('role'),
      'alert',
      reason,
    );
    assert.equal(
      buttonOf('drawio-export-replace'),
      null,
      `${reason}: Substituir`,
    );
    assert.ok(exportDialogOf() !== null, `${reason}: the dialog closed`);
    const field = exportPathOf() as HTMLInputElement;
    assert.equal(field.disabled, false, `${reason}: the path is not editable`);

    await react.act(async () => type(field, 'docs/outro'));
    await untilFlushed(
      () => buttonOf('drawio-export-confirm')?.disabled,
      (disabled) => disabled === false,
      `${reason}: Salvar never enabled again`,
    );
    await confirmExport();
    await exportsMade(h, 2);
    assert.equal(h.exports[1]?.path, 'docs/outro', reason);
    assert.equal(h.exports[1]?.overwrite, false, reason);

    await unmountAll();
  }
});

/* X7 -------------------------------------------------------------------------- */

test('X7: a render that rejects shows "O diagrama não pôde ser desenhado", keeps the dialog open and never exports', async () => {
  const h = harness();
  const { drawing } = await exporting(h);
  drawing.script.push('reject');

  await confirmExport();
  await showsText('drawio-export-message', RENDER_FAILED);
  await flush(5);

  assert.equal(h.exports.length, 0);
  assert.ok(exportDialogOf() !== null, 'the dialog closed');
});

/* X8 -------------------------------------------------------------------------- */

test('X8: export rejecting invalid_input, not_found or internal shows the message and keeps the dialog open', async () => {
  const errors: readonly [string, string][] = [
    ['invalid_input', 'The export path is refused: it ends in .drawio.'],
    ['not_found', `Revision 2 of ${ARTIFACT} does not exist.`],
    ['internal', `Could not write ${FLUXO}.drawio.svg: disk full`],
  ];

  for (const [code, message] of errors) {
    const h = harness();
    h.exportScript.push({ reject: new ContractError(code, message) });
    await exporting(h);

    await confirmExport();
    await showsText('drawio-export-message', failedOf(message));
    assert.ok(exportDialogOf() !== null, `${code}: the dialog closed`);
    assert.equal(
      buttonOf('drawio-export-confirm')?.disabled,
      false,
      `${code}: Salvar stays disabled`,
    );

    await unmountAll();
  }
});

/* X9 -------------------------------------------------------------------------- */

test('X9: export rejecting unavailable without a lease shows the lease phrase and keeps the dialog open', async () => {
  const h = harness();
  h.exportScript.push({
    reject: new ContractError(
      'unavailable',
      'The Project has no sandbox lease (missing).',
      { lease: 'missing' },
    ),
  });
  await exporting(h);

  await confirmExport();
  await showsText('drawio-export-message', NO_LEASE);
  assert.ok(exportDialogOf() !== null, 'the dialog closed');
});

/* X10 ------------------------------------------------------------------------- */

test('X10a: defaultExportPath slugs the title under docs/diagrams, transliterating accents', () => {
  const cases: readonly [string, string][] = [
    ['Fluxo', 'docs/diagrams/fluxo'],
    ['Fluxo de Pedidos', 'docs/diagrams/fluxo-de-pedidos'],
    ['  --A__b--  ', 'docs/diagrams/a-b'],
    ['Ação de Pedido', 'docs/diagrams/acao-de-pedido'],
  ];

  for (const [title, path] of cases) {
    assert.equal(modal.defaultExportPath(title), path, JSON.stringify(title));
  }
});

test('X10b: defaultExportPath falls back to docs/diagrams/diagrama when the slug is empty', () => {
  for (const title of ['日本語', '***', '']) {
    assert.equal(
      modal.defaultExportPath(title),
      'docs/diagrams/diagrama',
      JSON.stringify(title),
    );
  }
});

/* X11 ------------------------------------------------------------------------- */

test('X11a: Esc from the field or a button, the backdrop and Cancelar close only the dialog; Esc is taken', async () => {
  const closers: readonly [string, () => Promise<void>][] = [
    [
      'Esc from the field',
      async () => {
        assert.equal(
          await exportEscape(),
          true,
          'Esc from the field not taken',
        );
      },
    ],
    [
      'Esc from Cancelar',
      async () => {
        assert.equal(
          await exportEscape(buttonOf('drawio-export-cancel')),
          true,
          'Esc from Cancelar not taken',
        );
      },
    ],
    ['the backdrop', pressExportBackdrop],
    ['Cancelar', () => exportPress('drawio-export-cancel')],
  ];

  for (const [closer, close] of closers) {
    const h = harness();
    await exporting(h);

    await close();
    await exportGone(`${closer} left the dialog open`);
    await flush(3);
    assert.ok(modalOf() !== null, `${closer} closed the modal`);
    assert.equal(h.exports.length, 0, closer);

    await unmountAll();
  }
});

test('X11b: with the dialog open, V and E are not taken, and the modal backdrop and close button do nothing', async () => {
  const { dialog, drawing } = await exporting();
  const field = exportPathOf() as HTMLInputElement;

  assert.equal(await keyTaken(field, 'v'), false, 'V taken in the field');
  assert.equal(await keyTaken(field, 'e'), false, 'E taken in the field');
  assert.equal(
    await keyTaken(contentIn(dialog), 'e'),
    false,
    'E taken by the modal',
  );
  await flush(5);
  assert.equal(frameIn(dialog), null, 'E mounted the editor');
  assert.equal(drawing.editor.clients.length, 0);

  await pressBackdrop();
  await flush(5);
  assert.ok(modalOf() !== null, 'the modal backdrop closed the modal');
  assert.ok(exportDialogOf() !== null, 'the modal backdrop closed the dialog');

  await react.act(async () => {
    query(dialog, 'canvas-modal-close')?.click();
  });
  await flush(5);
  assert.ok(modalOf() !== null, 'the close button closed the modal');
  assert.ok(exportDialogOf() !== null, 'the close button closed the dialog');
});

/* X12 ------------------------------------------------------------------------- */

test('X12: while an answer is pending the buttons are disabled and Esc and the backdrop do nothing; once it settles all works again', async () => {
  const h = harness();
  h.exportDefault = 'pending';
  await exporting(h);

  await confirmExport();
  await exportsMade(h, 1);
  await flush(3);

  for (const testId of ['drawio-export-confirm', 'drawio-export-cancel']) {
    assert.equal(buttonOf(testId)?.disabled, true, `${testId} while busy`);
  }
  await exportEscape();
  await pressExportBackdrop();
  await flush(5);
  assert.ok(
    exportDialogOf() !== null,
    'Esc or the backdrop closed the busy dialog',
  );
  assert.ok(modalOf() !== null, 'the modal closed while busy');

  await react.act(async () => {
    h.pendingExports[0]?.resolve(EXISTS);
  });
  await untilFlushed(
    () => buttonOf('drawio-export-replace')?.disabled,
    (disabled) => disabled === false,
    'Substituir never enabled once exists answered',
  );
  assert.equal(buttonOf('drawio-export-cancel')?.disabled, false);

  assert.equal(await exportEscape(), true, 'Esc not taken once settled');
  await exportGone('Esc never closed the dialog once settled');
  assert.equal(h.exports.length, 1);
});
