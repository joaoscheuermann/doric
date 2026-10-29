// The new-revision banner in Editar (spec "O modal do diagrama", "Faixa de
// revisão nova", and the failure mode "Revisão nova durante a edição"; plan
// §4 "Revisions watch", §5 sub-step 3.7 and §6, criterion C9). Editar keeps B
// and `latest = revisions` of B's read; every `artifacts.revised/v1` of the
// artifact in the Thread's log, replayed or live, makes `latest =
// max(latest, revision)`; in `carregando*` and `editando*`, with `latest > B`,
// `drawio-banner-newer` reads "A revisão {latest} foi publicada depois da
// revisão {B}, de onde esta edição parte". Each test uses its own Thread, since
// the window shares one log per Thread (`desktop/ui/canvas` thread-log). The
// editor's `DrawioClient` is faked at the iframe boundary; every host service
// is faked (`support/diagram-harness.ts`).
//
// Contract matrix (plan §6): B1, B2, B3, B4, B5.

import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';

import { DrawioError } from '@drawio/react';

import {
  ARTIFACT,
  blockOf,
  drawingModule,
  fakeDrawing,
  type Harness,
  harness,
  loadClient,
  react,
  recordsThrough4,
  revisedOf,
  unmountAll,
  XML,
} from './support/diagram-harness.js';
import { window } from './support/dom.js';
import {
  choose,
  click,
  drawnNode,
  editorMounted,
  flush,
  frameIn,
  imageIn,
  open,
  pressEdit,
  reads,
  saveButtonIn,
  textIn,
  unavailable,
  untilFlushed,
} from './support/modal-gestures.js';

before(loadClient);

afterEach(unmountAll);

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

/* Helpers --------------------------------------------------------------------- */

const NEWER = 'drawio-banner-newer';

/** The banner's text for `latest` over `base` (plan §3.8). */
const newer = (latest: number, base: number) =>
  `A revisão ${String(latest)} foi publicada depois da revisão ${String(base)}, de onde esta edição parte`;

/** The editor's XML after the user's edit (an `autosave`). */
const X1 = XML.replace('value="A"', 'value="A1"');

/**
 * The modal open in Revisar on revision 2 (B), for a node whose block names
 * `threadId` (`null`: no Thread at all).
 */
const revisar = async (h: Harness, threadId: string | null) => {
  const drawing = fakeDrawing();
  const block =
    threadId === null
      ? (() => {
          const base = blockOf();
          const { threadId: _dropped, ...data } = base.data;

          return { ...base, data };
        })()
      : blockOf({ threadId });
  const { body } = await drawnNode(h, drawing, block);
  const { dialog, button } = await open(body);

  return { h, drawing, body, dialog, expand: button };
};

/** Editar pressed: the editor mounted, nothing answered (`carregando`). */
const carregando = async (h: Harness, threadId: string | null) => {
  const opened = await revisar(h, threadId);
  await pressEdit(opened.dialog);
  const client = await editorMounted(opened.dialog, opened.drawing);

  return { ...opened, client };
};

/** `carregando`, then `init` and its `load` answered: `editando`. */
const editando = async (h: Harness, threadId: string | null) => {
  const loading = await carregando(h, threadId);
  await loading.drawing.editor.init();
  await loading.drawing.editor.resolveLoad();
  await flush(2);

  return loading;
};

const bannerIn = (dialog: HTMLElement) => textIn(dialog, NEWER);

/** Waits for the banner to read `text`. */
const bannerReads = (dialog: HTMLElement, text: string) =>
  untilFlushed(
    () => bannerIn(dialog),
    (found) => found === text,
    `${NEWER} never read "${text}": ${String(bannerIn(dialog))}`,
  );

/** Lets every pending answer settle, then states there is no banner. */
const noBanner = async (dialog: HTMLElement, label: string) => {
  await flush(5);
  assert.equal(bannerIn(dialog), undefined, label);
};

/** In `editando`, autosave X1, Salvar and answer its `getXml`: the save is called. */
const saveFromEditando = async (
  h: Harness,
  dialog: HTMLElement,
  drawing: ReturnType<typeof fakeDrawing>,
) => {
  await drawing.editor.emit({ event: 'autosave', xml: X1 });
  await untilFlushed(
    () => saveButtonIn(dialog)?.disabled,
    (disabled) => disabled === false,
    'Salvar never enabled in editando-modificado',
  );
  const client = drawing.editor.last();
  const before = client.getXmls.length;
  await click(dialog, 'drawio-save');
  await untilFlushed(
    () => client.getXmls.length,
    (length) => length === before + 1,
    'Salvar never asked the editor for its XML',
  );
  await drawing.editor.answerXml(X1);
  await untilFlushed(
    () => h.saves.length,
    (length) => length === 1,
    'Salvar never saved',
  );
};

/** Waits for Revisar back on screen: the drawing and no editor. */
const backInRevisar = (dialog: HTMLElement) =>
  untilFlushed(
    () => imageIn(dialog) !== null && frameIn(dialog) === null,
    (back) => back,
    'Revisar never came back',
  );

/* B1–B3 ----------------------------------------------------------------------- */

test('B1: Editar on revision 2 (read: 2 revisions), then a live artifacts.revised/v1 of revision 3 shows the banner', async () => {
  const h = harness();
  const { dialog } = await editando(h, 't-banner-b1');
  await noBanner(dialog, 'a banner before any newer revision');

  await h.push(revisedOf(3));

  await bannerReads(dialog, newer(3, 2));
});

test('B2: replayed revisions 1 and 2, a live repeat of 2 and another artifact’s revision 5 show no banner; revision 3 then does', async () => {
  const h = harness();
  h.log = [revisedOf(1), revisedOf(2)];
  const { dialog } = await editando(h, 't-banner-b2');
  await noBanner(dialog, 'the replay of revisions 1 and 2');

  await h.push(revisedOf(2));
  await noBanner(dialog, 'a live repeat of revision 2');

  await h.push(revisedOf(5, 'other'));
  await noBanner(dialog, 'revision 5 of another artifact');

  // The watch is alive: a newer revision of this artifact shows the banner.
  await h.push(revisedOf(3, ARTIFACT));
  await bannerReads(dialog, newer(3, 2));
});

test('B3: Editar on revision 1 chosen in the menu (read: 3 revisions) shows the banner from the start', async () => {
  const h = harness();
  const { dialog, drawing } = await revisar(h, 't-banner-b3');
  await choose(dialog, 'Revisão', 'rev 1');
  await reads(dialog, 'papercraft-revision', 'rev 1');

  await pressEdit(dialog);
  await editorMounted(dialog, drawing);

  await bannerReads(dialog, newer(3, 1));
});

/* B4: where the banner shows -------------------------------------------------- */

test('B4: the banner shows in carregando and editando', async () => {
  const h = harness();
  const { dialog, drawing } = await carregando(h, 't-banner-b4a');

  await h.push(revisedOf(3));
  await bannerReads(dialog, newer(3, 2));

  await drawing.editor.init();
  await flush(3);
  assert.equal(bannerIn(dialog), newer(3, 2), 'carregando after init');

  await drawing.editor.resolveLoad();
  await flush(3);
  assert.equal(bannerIn(dialog), newer(3, 2), 'editando');
});

test('B4: the banner is absent in indisponível, and back in carregando after Tentar de novo', async () => {
  const h = harness();
  const { dialog, drawing } = await revisar(h, 't-banner-b4b');
  await choose(dialog, 'Revisão', 'rev 1');
  await reads(dialog, 'papercraft-revision', 'rev 1');
  await pressEdit(dialog);
  await editorMounted(dialog, drawing);
  await bannerReads(dialog, newer(3, 1));

  await drawing.editor.init();
  await drawing.editor.rejectLoad(new DrawioError('editor', 'bad diagram'));
  await unavailable(dialog);

  await noBanner(dialog, 'a banner in indisponível');

  await click(dialog, 'drawio-editor-retry');
  await editorMounted(dialog, drawing, 2);
  await bannerReads(dialog, newer(3, 1));
});

test('B4: the banner is absent in salvando; after the save, Editar on the new revision starts without it, and a newer revision shows it again', async () => {
  const h = harness();
  h.saveDefault = 'pending';
  const sha = await drawingModule.sha256Hex(X1);
  h.readsOf.set(4, { status: 'ok', xml: X1, revision: 4, revisions: 4 });
  const { dialog, drawing } = await editando(h, 't-banner-b4c');
  await h.push(revisedOf(3));
  await bannerReads(dialog, newer(3, 2));

  await saveFromEditando(h, dialog, drawing);
  await reads(dialog, 'drawio-saving', 'Salvando…');
  await noBanner(dialog, 'a banner in salvando');

  h.revisions = recordsThrough4(sha);
  await react.act(async () => {
    h.pendingSaves[0]?.resolve({ revision: 4, revisions: 4, sha256: sha });
  });
  await backInRevisar(dialog);
  await reads(dialog, 'papercraft-revision', 'rev 4');

  await pressEdit(dialog);
  await editorMounted(dialog, drawing, 2);
  await noBanner(dialog, 'the banner of the previous edition came back');

  await h.push(revisedOf(5));
  await bannerReads(dialog, newer(5, 4));
});

/* B5: no Thread to watch ------------------------------------------------------ */

test('B5: without a threadId, or with runtime.threads/v1 throwing, no live revision shows a banner, and Salvar still saves', async () => {
  for (const [name, threadId, unavailableThreads] of [
    ['no threadId', null, false],
    ['runtime.threads/v1 throws', 't-banner-b5', true],
  ] as const) {
    const h = harness();
    h.threadsUnavailable = unavailableThreads;
    const sha = await drawingModule.sha256Hex(X1);
    h.readsOf.set(4, { status: 'ok', xml: X1, revision: 4, revisions: 4 });
    const { dialog, drawing } = await editando(h, threadId);
    h.revisions = recordsThrough4(sha);

    await h.push(revisedOf(3));
    await noBanner(dialog, `${name}: a banner`);

    await saveFromEditando(h, dialog, drawing);
    assert.deepEqual(h.saves, [{ artifactId: ARTIFACT, xml: X1 }], name);
    await backInRevisar(dialog);
    await reads(dialog, 'papercraft-revision', 'rev 4');
    await unmountAll();
  }
});

test('B5: without a watch, latest stays at the read: Editar on revision 1 (read: 3 revisions) still shows the banner', async () => {
  for (const [name, threadId, unavailableThreads] of [
    ['no threadId', null, false],
    ['runtime.threads/v1 throws', 't-banner-b5r', true],
  ] as const) {
    const h = harness();
    h.threadsUnavailable = unavailableThreads;
    const { dialog, drawing } = await revisar(h, threadId);
    await choose(dialog, 'Revisão', 'rev 1');
    await reads(dialog, 'papercraft-revision', 'rev 1');

    await pressEdit(dialog);
    await editorMounted(dialog, drawing);

    await bannerReads(dialog, newer(3, 1)).catch((error: unknown) => {
      throw new Error(`${name}: ${String(error)}`);
    });
    await unmountAll();
  }
});
