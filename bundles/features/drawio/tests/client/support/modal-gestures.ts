// The gestures the modal tests make on `<drawio-diagram>`'s modal: a drawn
// node, Expandir, the toolbar menus, keys, the three ways to ask the modal
// to close, and Editar's controls (plan §3.8: `drawio-edit`,
// `drawio-edit-toolbar`, `drawio-save`, `drawio-done`, `drawio-editor-frame`,
// `drawio-editor-unavailable`, `drawio-editor-retry`, `drawio-editor-back`),
// and the exit dialog (`drawio-exit-dialog`, `drawio-exit-backdrop`,
// `drawio-exit-save`, `drawio-exit-discard`, `drawio-exit-continue`), and
// phase 4's Salvar no Project dialog (`drawio-export`, `drawio-export-path`,
// `drawio-export-confirm`, `-replace`, `-cancel`, `-backdrop`).
// `untilFlushed` waits without `setTimeout`, so it works while `node:test`
// mocks that API (`withMockTimers`).

import {
  ARTIFACT,
  type Body,
  blockOf,
  fakeDrawing,
  type Harness,
  mount,
  press,
  query,
  react,
  SHA,
  shown,
  until,
} from './diagram-harness.js';
import { window } from './dom.js';

/**
 * A node at revision 2, drawn from the cached page `p1` (with the revision's
 * first-page pointer); `block` (default `blockOf()`) names its Thread.
 */
export const drawnNode = async (
  h: Harness,
  drawing = fakeDrawing(),
  block: unknown = blockOf(),
) => {
  h.cache.seed(
    { artifactId: ARTIFACT, revision: 2, sha256: SHA },
    'p1',
    'light',
    true,
  );

  const body = await mount(h, drawing.drawing, block);
  await shown(body, 'drawio-diagram-image', 'the node never showed its page');

  return { body, drawing };
};

export const modalOf = () => query(document.body, 'canvas-modal');

export const imageIn = (dialog: HTMLElement) =>
  query<HTMLImageElement>(dialog, 'drawio-diagram-image');

export const textIn = (dialog: HTMLElement, testId: string) =>
  query(dialog, testId)?.textContent?.trim();

/** Waits until the modal's `testId` reads `text`. */
export const reads = (dialog: HTMLElement, testId: string, text: string) =>
  until(
    () => textIn(dialog, testId),
    (found) => found === text,
    `${testId} never read ${text}: ${String(textIn(dialog, testId))}`,
  );

/**
 * Presses Expandir (focused first, as a pointer would leave it) and waits
 * for the modal's drawing and its revision list (`rev 2/3`).
 */
export const open = async (body: Body) => {
  const header = await shown(body, 'papercraft-header', 'no header');
  await press(header as Element);
  const button = (await until(
    () => query<HTMLButtonElement>(body, 'papercraft-expand'),
    (found) => found !== null && !found.disabled,
    'Expandir never enabled',
  )) as HTMLButtonElement;
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
  await until(
    () => triggerOf(dialog, 'Revisão')?.textContent?.trim(),
    (text) => text === 'rev 2/3',
    'the Revisão menu never read rev 2/3',
  );

  return { dialog, button };
};

export const triggerOf = (dialog: HTMLElement, menu: string) =>
  dialog.querySelector<HTMLElement>(`[aria-label="${menu}"]`);

/** Opens the toolbar menu `menu` (a press: down, then the click) and chooses `item`. */
export const choose = async (
  dialog: HTMLElement,
  menu: string,
  item: string,
) => {
  const trigger = (await until(
    () => triggerOf(dialog, menu),
    (found) => found !== null,
    `no ${menu} menu`,
  )) as HTMLElement;

  await react.act(async () => {
    const init = { bubbles: true, cancelable: true, button: 0 };
    trigger.dispatchEvent(
      new window.PointerEvent('pointerdown', init) as never,
    );
    trigger.dispatchEvent(new window.MouseEvent('click', init) as never);
  });

  const option = (await until(
    () =>
      [
        ...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
      ].find((element) => element.textContent?.trim() === item) ?? null,
    (found) => found !== null,
    `the ${menu} menu has no item ${item}`,
  )) as HTMLElement;

  await react.act(async () => option.click());
};

/** Waits for page 2 of the revision on screen. */
export const onPageTwo = async (dialog: HTMLElement) => {
  await reads(dialog, 'drawio-page', 'pág 1/2');
  await choose(dialog, 'Página', 'Dois');
  await reads(dialog, 'drawio-page', 'pág 2/2');
  await until(
    () => imageIn(dialog)?.getAttribute('width'),
    (width) => width === '480',
    'page 2 never showed',
  );
};

/** Revisar's canvas, focused. */
export const canvasIn = async (dialog: HTMLElement) => {
  const canvas = dialog.querySelector<HTMLElement>(
    '[aria-label="canvas do diagrama"]',
  );
  if (canvas === null) throw new Error('the modal has no canvas');
  await react.act(async () => canvas.focus());

  return canvas;
};

/** The modal's content root: where a key lands when no canvas has the focus. */
export const contentIn = (dialog: HTMLElement): HTMLElement => {
  const content = query(dialog, 'canvas-modal-content');
  if (content === null) throw new Error('the modal has no content root');

  return content;
};

/** A keydown at `target`, and whether something took it (`defaultPrevented`). */
export const keyTaken = async (
  target: EventTarget,
  key: string,
  init: Record<string, unknown> = {},
): Promise<boolean> => {
  const event = new window.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await react.act(async () => {
    target.dispatchEvent(event as never);
  });

  return event.defaultPrevented;
};

/** The modal's backdrop pressed the way a pointer presses it. */
export const pressBackdrop = async () => {
  const backdrop = query(document.body, 'canvas-modal-backdrop');
  if (backdrop === null) throw new Error('the modal has no backdrop');
  await react.act(async () => {
    const init = { bubbles: true, cancelable: true, button: 0 };
    backdrop.dispatchEvent(
      new window.PointerEvent('pointerdown', init) as never,
    );
    backdrop.dispatchEvent(new window.MouseEvent('mousedown', init) as never);
    backdrop.dispatchEvent(new window.PointerEvent('pointerup', init) as never);
    backdrop.dispatchEvent(new window.MouseEvent('mouseup', init) as never);
    backdrop.dispatchEvent(new window.MouseEvent('click', init) as never);
  });
};

/** The three close requests (spec row 6): Esc, the backdrop, the close button. */
export const closers: readonly [
  string,
  (dialog: HTMLElement) => Promise<void>,
][] = [
  [
    'Esc',
    async (dialog) => {
      const content = contentIn(dialog);
      await react.act(async () => content.focus());
      await keyTaken(content, 'Escape');
    },
  ],
  ['the backdrop', async () => pressBackdrop()],
  [
    'the close button',
    async (dialog) =>
      react.act(async () => {
        query(dialog, 'canvas-modal-close')?.click();
      }),
  ],
];

/* Editar ---------------------------------------------------------------------- */

export const editButtonIn = (dialog: HTMLElement) =>
  query<HTMLButtonElement>(dialog, 'drawio-edit');
export const frameIn = (dialog: HTMLElement) =>
  query<HTMLIFrameElement>(dialog, 'drawio-editor-frame');
export const unavailableIn = (dialog: HTMLElement) =>
  query(dialog, 'drawio-editor-unavailable');
export const saveButtonIn = (dialog: HTMLElement) =>
  query<HTMLButtonElement>(dialog, 'drawio-save');
export const doneButtonIn = (dialog: HTMLElement) =>
  query<HTMLButtonElement>(dialog, 'drawio-done');

/** Clicks the button `testId` of the modal, once it exists. */
export const click = async (dialog: HTMLElement, testId: string) => {
  const button = query<HTMLButtonElement>(dialog, testId);
  if (button === null) throw new Error(`the modal has no ${testId}`);
  await react.act(async () => button.click());
};

/** Lets React, the fakes and their promises run once, without `setTimeout`. */
export const flush = async (rounds = 1) => {
  for (let round = 0; round < rounds; round += 1) {
    await react.act(async () => {
      await new Promise((done) => setImmediate(done));
    });
  }
};

/**
 * Polls like `until`, but lets React and the fakes run with `setImmediate`
 * (never mocked here), so it also works while `setTimeout` is mocked.
 */
export const untilFlushed = async <T>(
  read: () => T,
  holds: (value: T) => boolean,
  message: string,
): Promise<T> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();

    if (holds(value)) return value;

    await flush();
  }

  throw new Error(message);
};

/** Presses Editar (the toolbar button) once it exists. */
export const pressEdit = async (dialog: HTMLElement) => {
  const button = await untilFlushed(
    () => editButtonIn(dialog),
    (found) => found !== null,
    'Revisar has no Editar (drawio-edit)',
  );
  await untilFlushed(
    () => button?.disabled,
    (disabled) => disabled === false,
    'Editar never enabled',
  );
  await react.act(async () => button?.click());
};

/**
 * Waits for the editor's iframe and for `count` clients over it
 * (`createEditorClient`), and answers nothing yet: the phase is `carregando`.
 */
export const editorMounted = async (
  dialog: HTMLElement,
  drawing: ReturnType<typeof fakeDrawing>,
  count = 1,
) => {
  await untilFlushed(
    () => frameIn(dialog),
    (frame) => frame !== null,
    'Editar never mounted the editor (drawio-editor-frame)',
  );
  await untilFlushed(
    () => drawing.editor.clients.length,
    (length) => length === count,
    `createEditorClient was not called ${String(count)} time(s)`,
  );

  return drawing.editor.last();
};

/* Exit dialog (plan §3.8, `ExitDialog`) --------------------------------------- */

/** The exit dialog, wherever the modal renders it. */
export const exitDialogOf = () => query(document.body, 'drawio-exit-dialog');

/** Waits for the exit dialog to open. */
export const exitAsked = async (message: string): Promise<HTMLElement> =>
  (await untilFlushed(
    exitDialogOf,
    (found) => found !== null,
    message,
  )) as HTMLElement;

/** Waits for the exit dialog to close. */
export const exitGone = (message: string) =>
  untilFlushed(exitDialogOf, (found) => found === null, message);

/** Clicks the exit dialog's button `testId` (`drawio-exit-save`, `-discard`, `-continue`). */
export const exitPress = async (testId: string) => {
  const button = query<HTMLButtonElement>(document.body, testId);
  if (button === null) throw new Error(`the exit dialog has no ${testId}`);
  await react.act(async () => button.click());
};

/** Esc pressed inside the exit dialog, on its focused Continuar editando. */
export const exitEscape = async () => {
  const target =
    query<HTMLButtonElement>(document.body, 'drawio-exit-continue') ??
    exitDialogOf();
  if (target === null) throw new Error('no exit dialog');
  await react.act(async () => target.focus());
  await keyTaken(target, 'Escape');
};

/** The exit dialog's backdrop pressed the way a pointer presses it. */
export const pressExitBackdrop = async () => {
  const backdrop = query(document.body, 'drawio-exit-backdrop');
  if (backdrop === null) throw new Error('the exit dialog has no backdrop');
  await react.act(async () => {
    const init = { bubbles: true, cancelable: true, button: 0 };
    backdrop.dispatchEvent(
      new window.PointerEvent('pointerdown', init) as never,
    );
    backdrop.dispatchEvent(new window.MouseEvent('mousedown', init) as never);
    backdrop.dispatchEvent(new window.PointerEvent('pointerup', init) as never);
    backdrop.dispatchEvent(new window.MouseEvent('mouseup', init) as never);
    backdrop.dispatchEvent(new window.MouseEvent('click', init) as never);
  });
};

/** Waits for `drawio-editor-unavailable`, and its text. */
export const unavailable = async (dialog: HTMLElement) =>
  (
    await untilFlushed(
      () => unavailableIn(dialog),
      (found) => found !== null,
      'the modal never showed drawio-editor-unavailable',
    )
  )?.textContent ?? '';

/* Salvar no Project (phase 4, plan §4 `ExportDialog`) ------------------------- */

/** Revisar's Salvar no Project (the toolbar button). */
export const exportButtonIn = (dialog: HTMLElement) =>
  query<HTMLButtonElement>(dialog, 'drawio-export');

/** The export dialog's path field, wherever the modal renders it. */
export const exportPathOf = () =>
  query<HTMLInputElement>(document.body, 'drawio-export-path');

/**
 * The export dialog (`role="dialog"`) holding the path field, or `null` when
 * it is closed.
 */
export const exportDialogOf = (): HTMLElement | null =>
  exportPathOf()?.closest<HTMLElement>('[role="dialog"]') ?? null;

/** Presses Salvar no Project once it is enabled, and waits for the dialog. */
export const pressExport = async (dialog: HTMLElement) => {
  const button = await untilFlushed(
    () => exportButtonIn(dialog),
    (found) => found !== null,
    'Revisar has no Salvar no Project (drawio-export)',
  );
  await untilFlushed(
    () => button?.disabled,
    (disabled) => disabled === false,
    'Salvar no Project never enabled',
  );
  await react.act(async () => button?.click());

  return (await untilFlushed(
    exportDialogOf,
    (found) => found !== null,
    'Salvar no Project never opened its dialog',
  )) as HTMLElement;
};

/** Waits for the export dialog to close. */
export const exportGone = (message: string) =>
  untilFlushed(exportDialogOf, (found) => found === null, message);

/** Clicks the export dialog's button `testId` (`drawio-export-confirm`, `-replace`, `-cancel`). */
export const exportPress = async (testId: string) => {
  const button = query<HTMLButtonElement>(document.body, testId);
  if (button === null) throw new Error(`the export dialog has no ${testId}`);
  await react.act(async () => button.click());
};

/** Clicks Salvar (`drawio-export-confirm`). */
export const confirmExport = () => exportPress('drawio-export-confirm');

/**
 * Esc pressed inside the export dialog, on `target` (default: the focused
 * path field); answers whether something took it (`defaultPrevented`).
 */
export const exportEscape = async (
  target: HTMLElement | null = exportPathOf(),
): Promise<boolean> => {
  if (target === null) throw new Error('no export dialog');
  await react.act(async () => target.focus());

  return keyTaken(target, 'Escape');
};

/** The export dialog's backdrop pressed the way a pointer presses it. */
export const pressExportBackdrop = async () => {
  const backdrop = query(document.body, 'drawio-export-backdrop');
  if (backdrop === null) throw new Error('the export dialog has no backdrop');
  await react.act(async () => {
    const init = { bubbles: true, cancelable: true, button: 0 };
    backdrop.dispatchEvent(
      new window.PointerEvent('pointerdown', init) as never,
    );
    backdrop.dispatchEvent(new window.MouseEvent('mousedown', init) as never);
    backdrop.dispatchEvent(new window.PointerEvent('pointerup', init) as never);
    backdrop.dispatchEvent(new window.MouseEvent('mouseup', init) as never);
    backdrop.dispatchEvent(new window.MouseEvent('click', init) as never);
  });
};
