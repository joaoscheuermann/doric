// A papercraft program's canvas, as the conversation mounts it (the
// `papercraft-fence` node, `chrome: 'node'`) and as the canvas window's route
// mounts it (`papercraft-canvas`, `chrome: 'canvas'`), over a program canvas
// source `{ kind: 'program', threadId, identity }` (papercraft-openui.md D19,
// D26). The program renders in its sandboxed frame — a fake speaking frame
// protocol 2 over a real `MessageChannel` (`support/fake-frame.ts`) — and the
// canvas hears its pointer, wheel, keys and focus as the frame reports them.
//
// What it covers: the node's chrome and focus (the first press only focuses
// it, its tools wait out a blur, Esc hands the focus back), the comment flow
// (the inline input at the pin, a confirmed note joins chat's composer stack
// as a `papercraft-program` item and nothing durable is written, threads,
// replies, edits and removals of drafts, sent pins and their states, resolve
// under the root's prompt), the send (chat's in the conversation, which the
// open note joins first; `papercraft.send/v1` and the header's button in the
// window), the window's command bar (tools, isolate, show-all, zoom, the
// revision reading) and tree, and what the canvas tells the frame (capture,
// cursor, hidden layers).
//
// Every host contract is a double at its boundary (`support/fence-host.ts`):
// the composer stack, `chat.send/v1`, `comments/v1`, the Thread's log and
// `commands/v1`, which runs the commands the client registered.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';

import { CommandsV1 } from 'bundle/contracts';
import { act } from 'react';

import { setComposerAvailable } from '../../src/client/comment.js';
import { PROGRAM_COMMENT_KIND } from '../../src/contracts/index.js';
import { closeWindow } from './support/dom.js';
import type { FakeFrame, Placed } from './support/fake-frame.js';
import { delivered } from './support/fake-frame.js';
import {
  flush,
  type Host,
  type HostOptions,
  type MountedElement,
  PROJECT,
  programFence,
  type StackItem,
  startHost,
  THREAD,
  until,
  viewOf,
} from './support/fence-host.js';

after(closeWindow);

/* The program ------------------------------------------------------------ */

const IDENTITY = 'settings';
/** The canvas id of the program (D26): `program:<threadId>/<identity>`. */
const CANVAS_ID = `program:${THREAD}/${IDENTITY}`;

/**
 * What the fake frame renders for the program: statement wrappers as the real
 * frame writes them (D6), a title and a save button.
 */
const MARKUP = [
  '<span data-papercraft-statement="root" data-papercraft-component="Stack" style="display: contents">',
  '<div class="stack">',
  '<span data-papercraft-statement="title" data-papercraft-component="TextContent" style="display: contents">',
  '<h1 id="title">Settings</h1>',
  '</span>',
  '<span data-papercraft-statement="save" data-papercraft-component="Button" style="display: contents">',
  '<button id="save">Save</button>',
  '</span>',
  '</div>',
  '</span>',
].join('');

const FIRST = [
  'root = Stack([title, save])',
  'title = TextContent("First")',
  'save = Button("Save")',
].join('\n');
/** The second revision of the same identity: a patch of its title. */
const SECOND = 'title = TextContent("Second")';

const firstFence = programFence(FIRST, { identity: IDENTITY, promptId: 'p-1' });
const secondFence = programFence(SECOND, {
  identity: IDENTITY,
  promptId: 'p-2',
});

/* Mounting ----------------------------------------------------------------- */

let hosts: Host[] = [];
const extras: Element[] = [];

afterEach(async () => {
  for (const extra of extras.splice(0)) extra.remove();
  for (const host of hosts) await host.dispose();
  hosts = [];
  setComposerAvailable(false);
});

interface MountOptions extends HostOptions {
  /** The layout the fake frames report, by selector. */
  readonly layout?: Readonly<Record<string, Placed>>;
  /** Mounts the node of the second revision (both fences listed). */
  readonly second?: boolean;
}

const hostOf = async (options: MountOptions): Promise<Host> => {
  const { layout, second: _second, ...rest } = options;
  const host = await startHost({
    ...rest,
    frame: {
      program: () => MARKUP,
      ...(layout === undefined ? {} : { layout }),
    },
  });
  hosts.push(host);

  return host;
};

const rendered = async (node: MountedElement): Promise<MountedElement> => {
  await until(
    () => node.frame()?.rendered === true,
    (done) => done,
    'the program frame never rendered',
  );
  await flush();

  return node;
};

/** The node of the program's fence, as chat mounts it in the conversation. */
const mountNode = async (
  options: MountOptions = {},
): Promise<{ host: Host; node: MountedElement }> => {
  const host = await hostOf(options);
  if (options.composer !== false) setComposerAvailable(true);
  const fences =
    options.second === true ? [firstFence, secondFence] : [firstFence];
  const fence = options.second === true ? secondFence : firstFence;
  const node = await rendered(await host.mountFence(viewOf(fence, fences)));

  return { host, node };
};

/** The canvas window of the program, as its route mounts it. */
const mountWindow = async (
  options: MountOptions = {},
): Promise<{ host: Host; node: MountedElement }> => {
  const host = await hostOf(options);
  if (options.composer !== false) setComposerAvailable(true);
  await host.setFences(
    options.second === true ? [firstFence, secondFence] : [firstFence],
  );
  const node = await rendered(
    await host.mountRoute({
      projectId: PROJECT,
      threadId: THREAD,
      identity: IDENTITY,
    }),
  );

  return { host, node };
};

/* Reading and driving the canvas ------------------------------------------ */

const q = <T extends Element = HTMLElement>(
  root: ParentNode,
  testId: string,
): T | null => root.querySelector(`[data-testid="${testId}"]`) as T | null;

const frameOf = (node: MountedElement): FakeFrame => {
  const frame = node.frame();
  assert.ok(frame !== undefined, 'the canvas has no live frame');

  return frame;
};

const canvasOf = (node: MountedElement) =>
  node.element.querySelector('.papercraft-canvas') as HTMLElement;

const activeOf = (node: MountedElement) =>
  (node.element.querySelector('[data-active]') as HTMLElement).dataset.active;

const toolOf = (node: MountedElement) =>
  (node.element.querySelector('.papercraft-container') as HTMLElement).dataset
    .tool;

const inputOf = (node: MountedElement) =>
  q(node.element, 'papercraft-comment-input')?.querySelector(
    'textarea',
  ) as HTMLTextAreaElement | null;

const threadOf = (node: MountedElement) => q(node.element, 'papercraft-thread');

const replyFieldOf = (node: MountedElement) =>
  threadOf(node)?.querySelector('textarea') as HTMLTextAreaElement | null;

const pinOf = (node: MountedElement, number: string) =>
  node.element.querySelector(
    `[data-testid="papercraft-pin"][data-pin="${number}"]`,
  ) as HTMLElement | null;

const pinsOf = (node: MountedElement) => [
  ...node.element.querySelectorAll('[data-testid="papercraft-pin"]'),
];

interface PointerInit {
  readonly x?: number;
  readonly y?: number;
  readonly altKey?: boolean;
}

/** The frame reports a pointer event over an element it rendered. */
const report = async (
  node: MountedElement,
  type: 'move' | 'down' | 'up' | 'click' | 'leave',
  selector: string,
  init: PointerInit = {},
) => {
  await act(async () => {
    frameOf(node).pointer(type, selector, init);
    await delivered();
  });
  await flush(2);
};

const moveOn = (node: MountedElement, selector: string, init?: PointerInit) =>
  report(node, 'move', selector, init);

const clickIn = (node: MountedElement, selector: string, init?: PointerInit) =>
  report(node, 'click', selector, init);

/** A press the way a pointer makes one: down, up, then the click. */
const press = async (
  node: MountedElement,
  selector: string,
  init?: PointerInit,
) => {
  await report(node, 'down', selector, init);
  await report(node, 'up', selector, init);
  await report(node, 'click', selector, init);
};

/** The reader's first press on the node, which only focuses it. */
const focusNode = (node: MountedElement) => press(node, '#title');

const key = (target: EventTarget, name: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: name,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
    await delivered();
  });

/** Sets a controlled field's value the way typing does. */
const typeInto = (field: HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }) as never);
  });

const click = (element: Element | null) =>
  act(async () => {
    (element as HTMLElement | null)?.click();
    await delivered();
  });

/** Focuses the node and arms comment mode from its header control. */
const commenting = async (node: MountedElement) => {
  await focusNode(node);
  await click(q(node.element, 'papercraft-comment'));
  assert.equal(toolOf(node), 'comment', 'comment mode never armed');
};

/** A button elsewhere in the app, to move the focus to. */
const elsewhere = () => {
  const button = document.createElement('button');
  document.body.append(button);
  extras.push(button as never);

  return button as unknown as HTMLButtonElement;
};

/** Names an element for a failure message. */
const nameOf = (element: Element | null) =>
  element === null
    ? 'nothing'
    : `<${element.tagName.toLowerCase()}${
        element.getAttribute('data-testid')
          ? ` data-testid="${element.getAttribute('data-testid')}"`
          : ''
      }>`;

const assertFocusOn = (expected: Element | null, what: string) =>
  assert.ok(
    expected !== null && document.activeElement === expected,
    `the focus should be on ${what}, but it is on ${nameOf(document.activeElement as Element | null)}`,
  );

/** What the canvas told the program's frame, of one kind, in order. */
const toldOf = <K extends FakeFrame['received'][number]['kind']>(
  node: MountedElement,
  kind: K,
) =>
  frameOf(node).received.filter((message) => message.kind === kind) as Extract<
    FakeFrame['received'][number],
    { kind: K }
  >[];

/** The capture the frame is in now: the last it was told, else its `init`'s. */
const captureOf = (node: MountedElement) =>
  toldOf(node, 'capture').at(-1)?.capture ?? frameOf(node).init?.capture;

/** The text of the program the frame was last handed. */
const shownProgram = (node: MountedElement) => {
  const message = node
    .frame()
    ?.programReceived.filter((one) => one.kind === 'program')
    .at(-1);

  return message !== undefined && 'text' in message
    ? String(message.text)
    : undefined;
};

/* Comments and drafts as the host holds them ------------------------------ */

type Anchor = Record<string, unknown>;

const SAVE_ANCHOR: Anchor = {
  form: 'selector',
  selector: 'save',
  label: 'Button',
};

const programTarget = (revision: number, anchor: Anchor = SAVE_ANCHOR) => ({
  kind: 'papercraft-program',
  id: IDENTITY,
  revision,
  anchor,
});

/** A draft of this program, as chat's stack holds it. */
const draftOf = (
  id: string,
  revision: number,
  note: string,
  extra: Record<string, unknown> = {},
): StackItem => ({
  id,
  kind: PROGRAM_COMMENT_KIND,
  elementTag: 'chat-comment-line',
  data: {
    target: programTarget(revision, { form: 'point', x: 10, y: 20 }),
    pin: 1,
    point: { x: 10, y: 20 },
    refs: { title: IDENTITY },
    ...extra,
  },
  note,
});

/** A durable comment of this program, as `comments/v1.list` answers it. */
const sentOf = (
  commentId: string,
  text: string,
  extra: Record<string, unknown> = {},
) => ({
  commentId,
  target: programTarget(1),
  text,
  resolved: false,
  createdAt: '2026-11-06T12:00:00Z',
  ...extra,
});

/** A `comments.*` event of the Thread's log, written under a prompt. */
const logged = (
  sequence: number,
  type: string,
  promptId: string,
  event: unknown,
) => ({ sequence, type, promptId, event });

interface AddedDraft {
  readonly threadId: string;
  readonly kind: string;
  readonly elementTag: string;
  readonly note: string;
  readonly data: {
    readonly target: {
      readonly kind: string;
      readonly id: string;
      readonly revision: number;
      readonly anchor: Anchor;
    };
    readonly pin?: number;
    readonly inReplyTo?: string;
    readonly refs?: unknown;
  };
}

const addedOf = (host: Host, index: number) =>
  host.calls.drafts[index]?.input as AddedDraft | undefined;

const untilDrafts = (host: Host, count: number, message: string) =>
  until(
    () => host.calls.drafts.length,
    (length) => length === count,
    message,
  );

const untilPin = (node: MountedElement, message: string) =>
  until(
    () => q(node.element, 'papercraft-pin'),
    (found) => found !== null,
    message,
  );

/** Opens one `⋯` menu of a thread as the keyboard does: Enter, then the click. */
const openMenu = async (trigger: Element | null | undefined) => {
  assert.ok(trigger != null, 'no menu trigger');
  await act(async () => {
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });

    trigger.dispatchEvent(enter as never);
    if (!enter.defaultPrevented)
      trigger.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          detail: 0,
        }),
      );
    await delivered();
  });
};

/** Picks one item of an open menu. */
const pick = async (node: MountedElement, testId: string) => {
  const item = await until(
    () => q(node.element, testId),
    (found) => found !== null,
    `the menu item ${testId} never showed`,
  );

  await click(item);
};

/* The node's chrome and focus ---------------------------------------------- */

test("the node's Abrir opens the program's canvas window through open-canvas/v2, once focused", async () => {
  const { host, node } = await mountNode();

  await focusNode(node);
  await click(q(node.element, 'papercraft-open'));

  const opened = host.calls.executes
    .map((call) => call.input as { id: string; input: unknown })
    .filter((call) => call.id === 'papercraft.open-canvas/v2');
  assert.deepEqual(
    opened.map((call) => call.input),
    [{ identity: IDENTITY, projectId: PROJECT, threadId: THREAD }],
  );
  // There is no approval step any more (D25).
  assert.equal(node.element.querySelector('[aria-label="Autorizar"]'), null);
});

test('the node header overlays the canvas with the identity, the revision and icon controls', async () => {
  const { node } = await mountNode({ second: true });
  await focusNode(node);
  const header = q(node.element, 'papercraft-header') as HTMLElement;

  assert.match(header.textContent ?? '', new RegExp(IDENTITY));
  assert.match(q(header, 'papercraft-revision')?.textContent ?? '', /rev 2/);
  assert.equal(
    q(header, 'papercraft-open')?.getAttribute('aria-label'),
    'Abrir',
  );
  const control = q<HTMLButtonElement>(header, 'papercraft-comment');
  assert.equal(control?.getAttribute('aria-label'), 'Comentar');
  assert.equal(control?.getAttribute('aria-pressed'), 'false');
  // The canvas fills the frame from the top: the header floats over it.
  assert.match(canvasOf(node).className, /\binset-0\b/);
});

test('the node is a square, with no resize handle', async () => {
  const { node } = await mountNode();
  const container = node.element.querySelector(
    '.papercraft-container',
  ) as HTMLElement;

  assert.match(container.className, /\baspect-square\b/);
  assert.match(container.className, /\bw-full\b/);
  assert.equal(container.style.height, '');
  assert.equal(node.element.querySelector('.papercraft-resize'), null);
});

test('the first press on the node only focuses it, and its controls come with the focus', async () => {
  const { node } = await mountNode();
  const container = node.element.querySelector(
    '.papercraft-container',
  ) as HTMLElement;

  // Unfocused, the node shows its name but none of its controls.
  assert.equal(activeOf(node), 'false');
  assert.match(
    q(node.element, 'papercraft-header')?.textContent ?? '',
    new RegExp(IDENTITY),
  );
  assert.equal(q(node.element, 'papercraft-open'), null);
  assert.equal(q(node.element, 'papercraft-comment'), null);
  assert.equal(q(node.element, 'papercraft-footer'), null);
  assert.doesNotMatch(container.className, /\boutline-primary\b/);

  // The first press focuses the canvas, outlines the frame, selects nothing.
  await press(node, '#save');
  assertFocusOn(canvasOf(node), 'the canvas');
  assert.equal(activeOf(node), 'true');
  assert.match(container.className, /\boutline-primary\b/);
  assert.equal(q(node.element, 'papercraft-selection'), null);
  assert.ok(q(node.element, 'papercraft-open') !== null);
  assert.ok(q(node.element, 'papercraft-comment') !== null);
  assert.ok(q(node.element, 'papercraft-footer') !== null);

  // The focused canvas answers the next one.
  await press(node, '#save');
  assert.ok(q(node.element, 'papercraft-selection') !== null);
});

test('the tools armed on the node wait out the blur and return with the focus', async () => {
  const { node } = await mountNode();
  await commenting(node);

  await moveOn(node, '#save');
  assert.ok(q(node.element, 'papercraft-hover') !== null);

  // The focus goes elsewhere in the app: the tools hide, comment mode stays,
  // and the element under the pointer is still outlined.
  const other = elsewhere();
  await act(async () => other.focus());
  await flush(2);
  assert.equal(activeOf(node), 'false');
  assert.equal(q(node.element, 'papercraft-comment'), null);
  assert.equal(toolOf(node), 'comment');
  await moveOn(node, '#save');
  assert.ok(q(node.element, 'papercraft-hover') !== null);

  // The press that brings the focus back drops no pin; the tool is there.
  await focusNode(node);
  assert.equal(q(node.element, 'papercraft-comment-input'), null);
  assert.equal(
    q(node.element, 'papercraft-comment')?.getAttribute('aria-pressed'),
    'true',
  );
});

test('Esc with nothing to cancel hands the focus back', async () => {
  const { node } = await mountNode();

  await focusNode(node);
  assert.equal(activeOf(node), 'true');

  await key(canvasOf(node), 'Escape');
  assert.equal(activeOf(node), 'false');
});

test('without the composer the comment control is disabled and nothing is drafted', async () => {
  const { host, node } = await mountNode({ composer: false });
  await focusNode(node);

  assert.equal(
    q<HTMLButtonElement>(node.element, 'papercraft-comment')?.disabled,
    true,
  );
  // C arms nothing either.
  await key(canvasOf(node), 'c');
  assert.equal(toolOf(node), 'select');

  await clickIn(node, '#title');
  assert.equal(q(node.element, 'papercraft-comment-input'), null);
  assert.equal(host.calls.drafts.length, 0);
});

test('the comment control enables once chat comes late, and its drafts join the Thread scope', async () => {
  const { host, node } = await mountNode({ composer: false });
  await focusNode(node);
  assert.equal(
    q<HTMLButtonElement>(node.element, 'papercraft-comment')?.disabled,
    true,
  );

  await act(async () => setComposerAvailable(true));
  await until(
    () => q<HTMLButtonElement>(node.element, 'papercraft-comment')?.disabled,
    (disabled) => disabled === false,
    'the late composer never enabled the comment control',
  );

  await click(q(node.element, 'papercraft-comment'));
  await clickIn(node, '#save');
  const field = inputOf(node);
  assert.ok(field !== null, 'the inline input never opened');
  await typeInto(field, 'more room');
  await key(field, 'Enter');
  await untilDrafts(host, 1, 'the note never joined the stack');

  // The composer was called in the program's Project and Thread.
  const scope = host.calls.drafts[0]?.scope as {
    readonly projectId?: string;
    readonly threadId?: string;
  };
  assert.equal(scope.projectId, PROJECT);
  assert.equal(scope.threadId, THREAD);
});

test('the comment control, C and Esc toggle comment mode', async () => {
  const { node } = await mountNode();
  await commenting(node);
  const control = q(node.element, 'papercraft-comment') as HTMLElement;
  const canvas = canvasOf(node);

  assert.equal(control.getAttribute('aria-pressed'), 'true');

  await key(canvas, 'c');
  assert.equal(toolOf(node), 'select');
  assert.equal(control.getAttribute('aria-pressed'), 'false');

  await key(canvas, 'C');
  assert.equal(toolOf(node), 'comment');

  await key(canvas, 'Escape');
  assert.equal(toolOf(node), 'select');
});

/* The hover and the selection ---------------------------------------------- */

test('the element a comment would land on is outlined unlike the selection; Alt clears it', async () => {
  const { node } = await mountNode();
  await commenting(node);

  await moveOn(node, '#save');
  const hover = q(node.element, 'papercraft-hover');
  assert.ok(hover !== null, 'no hover outline');
  assert.match(hover.className, /border-dashed/);
  assert.equal(q(node.element, 'papercraft-selection'), null);
  // The label names the element.
  assert.equal(
    q(node.element, 'papercraft-hover-label')?.textContent,
    'button#save',
  );

  await moveOn(node, '#save', { altKey: true });
  assert.equal(q(node.element, 'papercraft-hover'), null);
  assert.equal(q(node.element, 'papercraft-hover-label'), null);
});

test('the element under the pointer is outlined in any mode, never while the canvas pans', async () => {
  const { node } = await mountNode();
  const canvas = canvasOf(node);

  // Not focused, not commenting: the outline and its label still follow.
  assert.equal(activeOf(node), 'false');
  await moveOn(node, '#save');
  assert.match(
    (q(node.element, 'papercraft-hover') as HTMLElement).className,
    /border-dashed/,
  );
  assert.equal(
    q(node.element, 'papercraft-hover-label')?.textContent,
    'button#save',
  );

  // The pointer leaves the canvas: nothing stays outlined.
  await act(async () => {
    canvas.dispatchEvent(
      new PointerEvent('pointerleave', {
        bubbles: false,
        composed: true,
      }),
    );
    await delivered();
  });
  assert.equal(q(node.element, 'papercraft-hover'), null);

  // The space bar pans: nothing is outlined under the hand.
  await focusNode(node);
  await key(canvas, ' ');
  await moveOn(node, '#save');
  assert.equal(q(node.element, 'papercraft-hover'), null);
});

/* Pseudo-elements: their own targets ---------------------------------------- */

/** `#save`'s border box, in content px (and surface px at the identity view). */
const SAVE = { x: 100, y: 50, width: 120, height: 40 } as const;
/** Its absolute `::after`: a strip 6px tall right below it. */
const SAVE_AFTER = { x: 100, y: 90, width: 120, height: 6 } as const;
/** A point on the strip, at its centre, and one on `#save` itself. */
const ON_STRIP = { x: 160, y: 93 } as const;
const ON_SAVE = { x: 160, y: 70 } as const;
const STRIP_LAYOUT = { '#save': { box: SAVE, after: SAVE_AFTER } };

/** The surface box an outline draws, from its inline style. */
const boxOfOutline = (outline: HTMLElement | null) => {
  assert.ok(outline !== null, 'no outline drawn');

  return {
    x: Number.parseFloat(outline.style.left),
    y: Number.parseFloat(outline.style.top),
    width: Number.parseFloat(outline.style.width),
    height: Number.parseFloat(outline.style.height),
  };
};

test('the pointer on an absolute ::after outlines and names the pseudo-element, on its host the host', async () => {
  const { node } = await mountNode({ layout: STRIP_LAYOUT });

  await moveOn(node, '#save', ON_STRIP);
  assert.deepEqual(
    boxOfOutline(q(node.element, 'papercraft-hover')),
    SAVE_AFTER,
  );
  assert.equal(
    q(node.element, 'papercraft-hover-label')?.textContent,
    'button#save::after',
  );

  await moveOn(node, '#save', ON_SAVE);
  assert.deepEqual(boxOfOutline(q(node.element, 'papercraft-hover')), SAVE);
  assert.equal(
    q(node.element, 'papercraft-hover-label')?.textContent,
    'button#save',
  );
});

test('a click with the select tool on an absolute ::after selects the pseudo-element box', async () => {
  const { node } = await mountNode({ layout: STRIP_LAYOUT });

  await focusNode(node);
  await press(node, '#save', ON_STRIP);

  assert.deepEqual(
    boxOfOutline(q(node.element, 'papercraft-selection')),
    SAVE_AFTER,
  );
});

test("a comment on an absolute ::after anchors to its host's statement", async () => {
  const { host, node } = await mountNode({ layout: STRIP_LAYOUT });
  await commenting(node);

  await clickIn(node, '#save', ON_STRIP);
  const field = inputOf(node);
  assert.ok(field !== null, 'the inline input never opened');
  await typeInto(field, 'the strip');
  await key(field, 'Enter');
  await untilDrafts(host, 1, 'the confirmed note never joined the stack');

  // D19: a program anchors by its statement name, labelled by its component.
  const anchor = addedOf(host, 0)?.data.target.anchor;
  assert.equal(anchor?.form, 'selector');
  assert.equal(anchor?.selector, 'save');
  assert.equal(anchor?.label, 'Button');
});

/* The inline input ----------------------------------------------------------- */

test('the new comment opens in a popover, and the hover label steps aside while it is open', async () => {
  const { node } = await mountNode();
  await commenting(node);

  await moveOn(node, '#save');
  assert.ok(q(node.element, 'papercraft-hover-label') !== null);

  await clickIn(node, '#save');
  const popover = q(node.element, 'papercraft-comment-input');
  assert.ok(popover !== null, 'the inline input never opened');
  for (const surface of [
    /\bbg-popover\b/,
    /\btext-popover-foreground\b/,
    /\bborder\b/,
    /\brounded-lg\b/,
  ])
    assert.match(popover.className, surface);
  // The label never covers the field or its pending pin.
  assert.equal(q(node.element, 'papercraft-hover-label'), null);

  // Esc still cancels, and the label comes back.
  await key(inputOf(node) as HTMLTextAreaElement, 'Escape');
  assert.equal(q(node.element, 'papercraft-comment-input'), null);
  assert.ok(q(node.element, 'papercraft-hover-label') !== null);
});

test('a click opens the inline input; Enter confirms one papercraft-program draft with its note', async () => {
  const { host, node } = await mountNode();
  await commenting(node);

  await clickIn(node, '#save');
  const field = inputOf(node);
  assert.ok(field !== null, 'the inline input never opened');
  assert.equal(field.getAttribute('placeholder'), 'Adicionar comentário');
  // Nothing reached the stack while the note is being written.
  assert.equal(host.calls.drafts.length, 0);
  assert.equal(
    q<HTMLButtonElement>(node.element, 'papercraft-comment-confirm')?.disabled,
    true,
  );

  await typeInto(field, 'more room');
  // Shift+Enter breaks the line: nothing is confirmed.
  await key(field, 'Enter', { shiftKey: true });
  await flush(2);
  assert.equal(host.calls.drafts.length, 0);
  assert.ok(inputOf(node) !== null);
  await key(field, 'Enter');

  await untilDrafts(host, 1, 'the confirmed note never joined the stack');
  const added = addedOf(host, 0) as AddedDraft;
  assert.equal(added.threadId, THREAD);
  assert.equal(added.note, 'more room');
  assert.equal(added.kind, PROGRAM_COMMENT_KIND);
  // Chat draws the line itself.
  assert.equal(added.elementTag, 'chat-comment-line');
  assert.equal(added.data.target.kind, 'papercraft-program');
  assert.equal(added.data.target.id, IDENTITY);
  assert.equal(added.data.target.revision, 1);
  assert.deepEqual(
    {
      form: added.data.target.anchor.form,
      selector: added.data.target.anchor.selector,
      label: added.data.target.anchor.label,
    },
    SAVE_ANCHOR,
  );
  assert.equal(added.data.pin, 1);
  assert.equal(added.data.inReplyTo, undefined);
  assert.deepEqual(added.data.refs, { title: IDENTITY });

  // The input closes, the draft is a numbered pin, and comment mode stays.
  await until(
    () => q(node.element, 'papercraft-pin')?.getAttribute('data-pin'),
    (pin) => pin === '1',
    'the draft never became a pin',
  );
  assert.equal(q(node.element, 'papercraft-comment-input'), null);
  assert.equal(toolOf(node), 'comment');
  // Still a draft: nothing was sent.
  assert.equal(host.calls.sends.length, 0);
});

test('Enter and the send button both confirm the inline input and hand the focus back to the canvas', async () => {
  for (const [action, confirm] of [
    [
      'Enter',
      (node: MountedElement) => key(inputOf(node) as HTMLElement, 'Enter'),
    ],
    [
      'the send button',
      (node: MountedElement) =>
        click(q(node.element, 'papercraft-comment-confirm')),
    ],
  ] as const) {
    const { host, node } = await mountNode();
    await commenting(node);

    await clickIn(node, '#save');
    const field = inputOf(node);
    assert.ok(field !== null, `${action}: the inline input never opened`);
    await typeInto(field, 'more room');
    await confirm(node);
    await untilDrafts(
      host,
      1,
      `${action}: the confirmed note never joined the stack`,
    );
    assert.equal(q(node.element, 'papercraft-comment-input'), null);

    // The canvas holds the focus again, not the page.
    assertFocusOn(canvasOf(node), `the canvas after ${action}`);

    // So the very next press is answered: it opens a new input.
    await press(node, '#title');
    assert.ok(
      inputOf(node) !== null,
      `${action}: the press after the confirm was spent on focusing the node`,
    );

    await host.dispose();
    hosts = hosts.filter((one) => one !== host);
  }
});

test('an empty input that loses focus is discarded, and Esc cancels a written one', async () => {
  const { host, node } = await mountNode();
  await commenting(node);

  await clickIn(node, '#save');
  await act(async () => inputOf(node)?.blur());
  await flush(2);
  assert.equal(q(node.element, 'papercraft-comment-input'), null);
  // The focus went elsewhere: the canvas does not take it back.
  assert.ok(
    document.activeElement !== canvasOf(node),
    'the canvas took back a focus that went elsewhere',
  );

  // The focus left the node with the input: the next press only focuses it.
  await focusNode(node);
  await clickIn(node, '#save');
  const field = inputOf(node);
  assert.ok(field !== null, 'the inline input never opened again');
  await typeInto(field, 'never mind');
  await key(field, 'Escape');
  assert.equal(q(node.element, 'papercraft-comment-input'), null);

  await flush(2);
  assert.equal(host.calls.drafts.length, 0);
});

test('Esc cancels the inline input and hands the focus back to the canvas, whose keys still work', async () => {
  const { host, node } = await mountNode();
  await commenting(node);
  const canvas = canvasOf(node);

  await clickIn(node, '#save');
  const field = inputOf(node);
  assert.ok(field !== null, 'the inline input never opened');
  await typeInto(field, 'never mind');
  await key(field, 'Escape');
  assert.equal(q(node.element, 'papercraft-comment-input'), null);

  assertFocusOn(canvas, 'the canvas');

  // The canvas commands answer: C leaves comment mode.
  assert.equal(toolOf(node), 'comment');
  await key(canvas, 'c');
  assert.equal(toolOf(node), 'select');

  await flush(2);
  assert.equal(host.calls.drafts.length, 0);
});

test('Alt forces a free point over an element', async () => {
  const { host, node } = await mountNode();
  await commenting(node);

  await clickIn(node, '#save', { altKey: true });
  const field = inputOf(node);
  assert.ok(field !== null, 'the inline input never opened');
  await typeInto(field, 'here');
  await key(field, 'Enter');

  await untilDrafts(host, 1, 'the note never joined the stack');
  assert.equal(addedOf(host, 0)?.data.target.anchor.form, 'point');
});

/* Threads of drafts ----------------------------------------------------------- */

test('a draft pin opens its thread; a reply joins the stack answering it', async () => {
  const { host, node } = await mountNode({
    items: [draftOf('comment-d1', 1, 'first take')],
  });
  await commenting(node);

  const pin = await untilPin(node, 'the draft never became a pin');
  assert.equal(pin?.dataset.state, 'draft');
  await click(pin);

  const thread = threadOf(node);
  assert.ok(thread !== null, 'the thread never opened');
  assert.equal(pin?.dataset.active, 'true');
  const messages = thread.querySelectorAll(
    '[data-testid="papercraft-thread-message"]',
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0]?.textContent ?? '', /na pilha/);
  assert.match(messages[0]?.textContent ?? '', /first take/);
  // A draft root cannot be resolved: there is nothing durable yet.
  assert.equal(q(thread, 'papercraft-thread-resolve'), null);

  const field = replyFieldOf(node);
  assert.ok(field !== null, 'the thread has no reply field');
  await typeInto(field, 'and the spacing?');
  await key(field, 'Enter');

  await untilDrafts(host, 1, 'the reply never joined the stack');
  // The thread stays open for the next reply, and keeps the focus.
  assertFocusOn(replyFieldOf(node), 'the reply field');
  const reply = addedOf(host, 0) as AddedDraft;
  assert.equal(reply.note, 'and the spacing?');
  assert.equal(reply.data.inReplyTo, 'comment-d1');
  assert.equal(reply.data.pin, 1);
  assert.equal(reply.data.target.id, IDENTITY);
  assert.equal(reply.data.target.kind, 'papercraft-program');
  // Nothing sent: the reply leaves with the next prompt.
  assert.equal(host.calls.sends.length, 0);
  await until(
    () =>
      threadOf(node)?.querySelectorAll(
        '[data-testid="papercraft-thread-message"]',
      ).length,
    (length) => length === 2,
    'the drafted reply never showed in the thread',
  );
});

test('a draft of the thread is edited from its menu, and saving it empty removes it', async () => {
  const { host, node } = await mountNode({
    items: [
      draftOf('comment-d1', 1, 'first take'),
      draftOf('comment-r1', 1, 'a reply', { inReplyTo: 'comment-d1' }),
    ],
  });
  await commenting(node);

  const pin = await untilPin(node, 'the draft never became a pin');
  // The draft reply is no pin of its own.
  assert.equal(pinsOf(node).length, 1);
  await click(pin);

  await openMenu(
    threadOf(node)?.querySelectorAll(
      '[data-testid="papercraft-message-more"]',
    )[0],
  );
  await pick(node, 'papercraft-message-edit');

  const field = replyFieldOf(node) as HTMLTextAreaElement;
  assert.equal(field.value, 'first take');
  assert.equal(field.getAttribute('placeholder'), 'Editar comentário…');
  await typeInto(field, 'second take');
  await key(field, 'Enter');
  await until(
    () => host.calls.notes.length,
    (length) => length === 1,
    'the edit never reached the stack',
  );
  const edit = host.calls.notes[0]?.input as { id: string; note: string };
  assert.deepEqual(
    { id: edit.id, note: edit.note },
    {
      id: 'comment-d1',
      note: 'second take',
    },
  );

  // Editing the root again and saving it empty drops it and its replies.
  await openMenu(
    threadOf(node)?.querySelectorAll(
      '[data-testid="papercraft-message-more"]',
    )[0],
  );
  await pick(node, 'papercraft-message-edit');
  const emptied = replyFieldOf(node) as HTMLTextAreaElement;
  await typeInto(emptied, '');
  await key(emptied, 'Enter');
  await until(
    () => host.calls.removed.length,
    (length) => length === 2,
    'the emptied draft was never removed',
  );
  assert.deepEqual(
    host.calls.removed.map((call) => (call.input as { id: string }).id).sort(),
    ['comment-d1', 'comment-r1'],
  );
  await until(
    () => threadOf(node),
    (found) => found === null,
    'the thread of a removed draft stayed open',
  );
  assert.equal(host.calls.drafts.length, 0);
});

test('a draft is removed from the stack from its thread', async () => {
  const { host, node } = await mountNode({
    items: [draftOf('comment-d1', 1, 'first take')],
  });
  await commenting(node);

  await click(await untilPin(node, 'the draft never became a pin'));
  await openMenu(q(node.element, 'papercraft-thread-more'));
  await pick(node, 'papercraft-thread-remove');
  await until(
    () => host.calls.removed.length,
    (length) => length === 1,
    'the removal never reached the stack',
  );
  const removal = host.calls.removed[0]?.input as { id: string } | undefined;
  assert.equal(removal?.id, 'comment-d1');
});

test('Esc closes a thread without adding what its field holds', async () => {
  const { host, node } = await mountNode({
    items: [draftOf('comment-d1', 1, 'first take')],
  });
  await commenting(node);

  await click(await untilPin(node, 'the draft never became a pin'));
  const field = replyFieldOf(node);
  assert.ok(field !== null, 'the thread never opened');
  await typeInto(field, 'drop it');
  await key(field, 'Escape');

  assert.equal(threadOf(node), null);
  await flush(2);
  assert.equal(host.calls.drafts.length, 0);
});

test('closing a thread with Esc or its close button hands the focus back to the canvas', async () => {
  const { node } = await mountNode({
    items: [draftOf('comment-d1', 1, 'first take')],
  });
  await commenting(node);
  const canvas = canvasOf(node);

  // Esc in the reply field.
  await click(await untilPin(node, 'the draft never became a pin'));
  const field = replyFieldOf(node);
  assert.ok(field !== null, 'the thread never opened');
  await key(field, 'Escape');
  assert.equal(threadOf(node), null);
  assertFocusOn(canvas, 'the canvas');

  // The close button.
  await click(q(node.element, 'papercraft-pin'));
  assert.ok(threadOf(node) !== null, 'the thread never reopened');
  await click(q(node.element, 'papercraft-thread-close'));
  assert.equal(threadOf(node), null);
  assertFocusOn(canvas, 'the canvas');
});

/* Sent threads ---------------------------------------------------------------- */

test('sent pins say where their thread stands, and the control counts the open ones', async () => {
  const { node } = await mountNode({
    comments: [
      sentOf('c-open', 'more room'),
      sentOf('c-reply', 'which colour?', {
        author: 'agent',
        inReplyTo: 'c-open',
      }),
      sentOf('c-me', 'blue', { inReplyTo: 'c-open' }),
      sentOf('c-await', 'the title'),
      sentOf('c-agent', 'bigger or smaller?', {
        author: 'agent',
        inReplyTo: 'c-await',
      }),
      sentOf('c-done', 'done', { resolved: true }),
    ],
  });
  await commenting(node);

  await until(
    () => pinOf(node, '3')?.dataset.state,
    (state) => state === 'done',
    'the resolved thread never became a pin',
  );
  // The reader answered last: open; the colour alone says the state, no badge.
  assert.equal(pinOf(node, '1')?.dataset.state, 'open');
  // The agent asked last: the thread awaits the reader.
  assert.equal(pinOf(node, '2')?.dataset.state, 'await');
  assert.equal(q(node.element, 'papercraft-pin-badge'), null);
  // The replies are no pins; the control counts the unresolved roots.
  assert.equal(pinsOf(node).length, 3);
  assert.equal(q(node.element, 'papercraft-comment-count')?.textContent, '2');

  // The header hides the resolved pins, and shows them again.
  const eye = q(node.element, 'papercraft-show-resolved');
  assert.ok(eye !== null, 'no show/hide control with a resolved thread');
  await click(eye);
  assert.equal(pinOf(node, '3'), null);
  await click(eye);
  assert.equal(pinOf(node, '3')?.dataset.state, 'done');

  // The awaiting thread opens with its messages and its state chip; its
  // title names the component the statement renders (D19).
  await click(pinOf(node, '2'));
  const thread = threadOf(node) as HTMLElement;
  assert.equal(q(thread, 'papercraft-thread-title')?.textContent, 'Button');
  assert.equal(
    thread.querySelectorAll('[data-testid="papercraft-thread-message"]').length,
    2,
  );
  assert.match(
    q(thread, 'papercraft-thread-state')?.textContent ?? '',
    /aguardando você/,
  );
});

test('threads and drafts of an earlier revision carry over to the newest, keeping their numbers', async () => {
  const { host, node } = await mountNode({
    second: true,
    comments: [sentOf('c1', 'more room')],
    items: [draftOf('comment-d1', 1, 'and the title?', { pin: 2 })],
  });
  await commenting(node);

  await until(
    () => [pinOf(node, '1')?.dataset.state, pinOf(node, '2')?.dataset.state],
    ([sent, drafted]) => sent === 'open' && drafted === 'draft',
    "revision 1's thread and draft never showed on revision 2",
  );
  assert.equal(q(node.element, 'papercraft-comment-count')?.textContent, '2');

  // A reply answers the root on the root's own target.
  await click(pinOf(node, '1'));
  const field = replyFieldOf(node);
  assert.ok(field !== null, 'the thread never opened');
  await typeInto(field, 'still tight');
  await key(field, 'Enter');
  await untilDrafts(host, 1, 'the reply never joined the stack');
  const reply = addedOf(host, 0) as AddedDraft;
  assert.equal(reply.data.inReplyTo, 'c1');
  assert.equal(reply.data.target.revision, 1);
  await key(replyFieldOf(node) as HTMLTextAreaElement, 'Escape');

  // A new comment is written against the revision on screen, numbered next.
  await clickIn(node, '#title');
  const input = inputOf(node);
  assert.ok(input !== null, 'the inline input never opened');
  await typeInto(input, 'new');
  await key(input, 'Enter');
  await untilDrafts(host, 2, 'the new comment never joined the stack');
  const added = addedOf(host, 1) as AddedDraft;
  assert.equal(added.data.target.revision, 2);
  assert.equal(added.data.pin, 3);
});

test('a thread whose statement is gone from the revision on screen stays a reachable pin', async () => {
  const { node } = await mountNode({
    comments: [
      sentOf('c-gone', 'the old section', {
        target: programTarget(1, {
          form: 'selector',
          selector: 'gone',
          label: 'Card',
        }),
      }),
    ],
  });
  await commenting(node);

  const pin = await untilPin(
    node,
    'the thread without its statement was dropped',
  );
  assert.equal(pin?.dataset.detached, 'true');
  assert.equal(q(node.element, 'papercraft-comment-count')?.textContent, '1');

  await click(pin);
  assert.match(threadOf(node)?.textContent ?? '', /the old section/);
});

test('a sent thread resolves under the prompt its root was written in', async () => {
  const target = programTarget(1);
  const { host, node } = await mountNode({
    log: [
      logged(1, 'comments.added/v1', 'prompt-root', {
        commentId: 'c1',
        target,
        text: 'more room',
      }),
      logged(2, 'comments.added/v1', 'prompt-agent', {
        commentId: 'c2',
        target,
        text: 'done',
        author: 'agent',
        inReplyTo: 'c1',
      }),
    ],
  });
  await commenting(node);

  const pin = await until(
    () => q(node.element, 'papercraft-pin'),
    (found) => found?.dataset.state === 'await',
    'the logged thread never became an awaiting pin',
  );
  await click(pin);

  const resolve = q<HTMLButtonElement>(
    node.element,
    'papercraft-thread-resolve',
  );
  assert.ok(resolve !== null, 'the thread has no resolve control');
  assert.equal(resolve.disabled, false);
  await click(resolve);

  await until(
    () => host.calls.resolves.length,
    (length) => length === 1,
    'the resolve was never asked',
  );
  assert.deepEqual(host.calls.resolves[0]?.input, {
    commentId: 'c1',
    resolved: true,
  });
  assert.deepEqual(host.calls.resolves[0]?.scope, {
    projectId: PROJECT,
    threadId: THREAD,
    promptId: 'prompt-root',
  });
});

test('the durable comments are not listed again while the Thread log answers', async () => {
  const { host, node } = await mountNode({
    log: [
      logged(1, 'comments.added/v1', 'prompt-root', {
        commentId: 'c1',
        target: programTarget(1),
        text: 'more room',
      }),
    ],
  });
  await commenting(node);

  const pin = await untilPin(node, 'the logged thread never became a pin');
  const listed = host.calls.lists.length;

  // A resolve asks the comments to be read again: the log answers, so the
  // list is not.
  await click(pin);
  await click(q(node.element, 'papercraft-thread-resolve'));
  await until(
    () => host.calls.resolves.length,
    (length) => length === 1,
    'the resolve was never asked',
  );
  await flush();

  assert.equal(host.calls.lists.length, listed);
});

test('a thread whose prompt is unknown cannot be resolved', async () => {
  const { host, node } = await mountNode({
    comments: [sentOf('c1', 'more room')],
  });
  await commenting(node);

  await click(await untilPin(node, 'the sent comment never became a pin'));

  const resolve = q<HTMLButtonElement>(
    node.element,
    'papercraft-thread-resolve',
  );
  assert.equal(resolve?.disabled, true);
  assert.equal(host.calls.resolves.length, 0);
});

/* The conversation asking to see a thread (`doric:comment-thread-open`) ------ */

/** The conversation asking to see a thread, as chat dispatches it. */
const askThread = (detail: object) =>
  act(async () => {
    document.body.dispatchEvent(
      new CustomEvent('doric:comment-thread-open', {
        bubbles: true,
        composed: true,
        detail,
      }),
    );
    await delivered();
  });

test('the conversation opens a thread of this program, and only of its own revision', async () => {
  const { node } = await mountNode({
    comments: [
      sentOf('c1', 'more room'),
      sentOf('c2', 'done', { author: 'agent', inReplyTo: 'c1' }),
    ],
  });
  await untilPin(node, 'the sent comment never became a pin');

  // Another identity's thread, and another revision's, are not this node's.
  await askThread({
    commentId: 'c1',
    target: { kind: 'papercraft-program', id: 'other', revision: 1 },
  });
  await askThread({
    commentId: 'c1',
    target: { kind: 'papercraft-program', id: IDENTITY, revision: 2 },
  });
  assert.equal(threadOf(node), null);

  // A reply's id opens its root's thread.
  await askThread({
    commentId: 'c2',
    target: { kind: 'papercraft-program', id: IDENTITY, revision: 1 },
  });
  const thread = await until(
    () => threadOf(node),
    (found) => found !== null,
    'the asked thread never opened',
  );
  assert.equal(
    thread?.querySelectorAll('[data-testid="papercraft-thread-message"]')
      .length,
    2,
  );
  assert.equal(q(node.element, 'papercraft-pin')?.dataset.active, 'true');
});

test('the window opens the asked thread on the revision on screen', async () => {
  const { node } = await mountWindow({
    second: true,
    comments: [sentOf('c1', 'on revision one')],
  });

  await askThread({
    commentId: 'c1',
    target: { kind: 'papercraft-program', id: IDENTITY, revision: 1 },
  });

  const thread = await until(
    () => threadOf(node),
    (found) => found !== null,
    'the asked thread never opened',
  );
  assert.match(thread?.textContent ?? '', /on revision one/);
  // Every revision shows every thread: the newest stays on screen.
  assert.match(shownProgram(node) ?? '', /Second/);
});

test('a thread asked for without a revision opens on the node of the newest revision only', async () => {
  const host = await hostOf({ comments: [sentOf('c1', 'more room')] });
  setComposerAvailable(true);
  const fences = [firstFence, secondFence];
  const first = await rendered(
    await host.mountFence(viewOf(firstFence, fences)),
  );
  const second = await rendered(
    await host.mountFence(viewOf(secondFence, fences)),
  );
  for (const node of [first, second])
    await untilPin(node, 'the thread never became a pin');

  await askThread({
    commentId: 'c1',
    target: { kind: 'papercraft-program', id: IDENTITY },
  });

  await until(
    () => threadOf(second),
    (found) => found !== null,
    'the newest node never opened the thread',
  );
  assert.equal(threadOf(first), null);
});

/* Sending --------------------------------------------------------------------- */

/** Chat's send asking before it reads the stack, as `chat.send-prompt/v1` does. */
const askBeforeSend = async (threadId: string): Promise<Promise<unknown>[]> => {
  const pending: Promise<unknown>[] = [];

  await act(async () => {
    document.dispatchEvent(
      new CustomEvent('doric:prompt-send', {
        detail: {
          threadId,
          waitUntil: (promise: Promise<unknown>) => pending.push(promise),
        },
      }),
    );
  });

  return pending;
};

test('in the conversation the canvas never sends on Cmd+Enter: chat does, after the open note joins the stack', async () => {
  const { host, node } = await mountNode();
  await commenting(node);

  await clickIn(node, '#save');
  const field = inputOf(node);
  assert.ok(field !== null, 'the inline input never opened');
  await typeInto(field, 'send it now');

  // The chord reaches the field and the canvas, and neither sends: the
  // window's one send is chat's.
  await key(field, 'Enter', { metaKey: true });
  await key(canvasOf(node), 'Enter', { ctrlKey: true });
  await flush(2);
  assert.equal(host.calls.sends.length, 0);
  assert.equal(host.calls.drafts.length, 0);

  // Another Thread's send leaves the note where it is.
  assert.deepEqual(await askBeforeSend('t-other'), []);

  // This Thread's send waits for the note to join its stack.
  const pending = await askBeforeSend(THREAD);
  assert.equal(pending.length, 1);
  await act(async () => {
    await Promise.all(pending);
  });
  assert.equal(host.calls.drafts.length, 1);
  assert.equal(addedOf(host, 0)?.note, 'send it now');
  assert.equal(host.calls.sends.length, 0);
});

test('in the canvas window Cmd+Enter (`papercraft.send/v1`) confirms the open note and sends the stack through chat', async () => {
  const { host, node } = await mountWindow();
  const commands = host.services.use(CommandsV1);

  await act(async () => {
    await commands.execute('papercraft.comment/v1', {});
  });
  await flush(2);
  assert.equal(toolOf(node), 'comment');
  await clickIn(node, '#save');
  const field = inputOf(node);
  assert.ok(field !== null, 'the inline input never opened');
  await typeInto(field, 'send it now');

  await act(async () => {
    await commands.execute('papercraft.send/v1', {});
  });

  await until(
    () => host.calls.sends.length,
    (length) => length === 1,
    'the stack was never sent',
  );
  assert.equal(host.calls.drafts.length, 1);
  assert.equal(addedOf(host, 0)?.note, 'send it now');
  assert.deepEqual(host.calls.sends[0]?.input, {
    projectId: PROJECT,
    threadId: THREAD,
  });
});

test('the window sends its drafts from the header, having no prompt of its own', async () => {
  const { host, node } = await mountWindow({
    items: [draftOf('d1', 1, 'adjust the button')],
  });

  const send = await until(
    () => q(node.element, 'papercraft-send'),
    (found) => found !== null,
    'the send button never showed for the draft',
  );
  assert.match(send?.textContent ?? '', /Enviar ao agente \(1\)/);
  // The window has no Abrir: it is the window.
  assert.equal(q(node.element, 'papercraft-open'), null);

  await click(send);
  await until(
    () => host.calls.sends.length,
    (length) => length === 1,
    'the stack was never sent',
  );
  assert.deepEqual(host.calls.sends[0]?.input, {
    projectId: PROJECT,
    threadId: THREAD,
  });
});

/* The window's command bar and tree ------------------------------------------ */

const commandIn = (node: MountedElement, command: string) =>
  node.element.querySelector(
    `[role="toolbar"] [data-command="${command}"]`,
  ) as HTMLButtonElement | null;

test('the canvas window draws the toolbar groups and the tree; isolate and show-all act on the selection', async () => {
  const { node } = await mountWindow();
  const toolbar = node.element.querySelector('[role="toolbar"]') as HTMLElement;
  assert.ok(toolbar !== null, 'the window has no command bar');

  // One revision: the reading, not a menu.
  assert.match(toolbar.textContent ?? '', /rev 1\/1/);
  assert.match(
    node.element.querySelector('.papercraft-tree')?.textContent ?? '',
    /h1#title/,
  );

  // Four groups and three dividers.
  for (const command of [
    'papercraft.select/v1',
    'papercraft.comment/v1',
    'papercraft.pan/v1',
    'papercraft.isolate/v1',
    'papercraft.show-all/v1',
    'papercraft.zoom-out/v1',
    'papercraft.zoom-reset/v1',
    'papercraft.zoom-in/v1',
    'papercraft.zoom-fit/v1',
  ])
    assert.ok(commandIn(node, command) !== null, `missing ${command}`);
  assert.equal(toolbar.querySelectorAll('[data-slot="separator"]').length, 3);
  // No approval step any more (D25).
  assert.equal(toolbar.textContent?.includes('Autorizar'), false);

  // Disabled, not hidden: nothing is selected, nothing is hidden.
  assert.equal(commandIn(node, 'papercraft.isolate/v1')?.disabled, true);
  assert.equal(commandIn(node, 'papercraft.show-all/v1')?.disabled, true);

  // Selecting an element enables Isolar; isolating enables Mostrar tudo.
  const frame = frameOf(node);
  const hiddenNow = () =>
    frame.received.filter((message) => message.kind === 'hidden').at(-1);
  await clickIn(node, '#save');
  assert.ok(q(node.element, 'papercraft-selection') !== null);
  assert.equal(commandIn(node, 'papercraft.isolate/v1')?.disabled, false);

  await click(commandIn(node, 'papercraft.isolate/v1'));
  await flush(2);
  assert.equal(commandIn(node, 'papercraft.show-all/v1')?.disabled, false);
  // The frame is told to hide the layers around the selection.
  const hidden = hiddenNow();
  assert.ok(
    hidden?.kind === 'hidden' &&
      hidden.ids.includes(frame.nodeId('#title')) &&
      !hidden.ids.includes(frame.nodeId('#save')),
    'the layers around the selection were not hidden',
  );

  await click(commandIn(node, 'papercraft.show-all/v1'));
  await flush(2);
  assert.deepEqual(hiddenNow(), { kind: 'hidden', ids: [] });

  // The tree highlights the node selected from it.
  const row = node.element.querySelector(
    '.papercraft-tree [data-node-id]',
  ) as HTMLElement;
  assert.ok(row !== null, 'the tree has no rows');
  await click(row.querySelector('button'));
  assert.equal(row.dataset.selected, 'true');
});

test('the toolbar tools dispatch their commands on the canvas id, and the armed tool follows', async () => {
  const { host, node } = await mountWindow();

  await click(commandIn(node, 'papercraft.comment/v1'));
  await flush(2);
  assert.equal(toolOf(node), 'comment');
  await click(commandIn(node, 'papercraft.pan/v1'));
  await flush(2);
  assert.equal(toolOf(node), 'pan');
  await click(commandIn(node, 'papercraft.select/v1'));
  await flush(2);
  assert.equal(toolOf(node), 'select');

  const dispatched = host.calls.executes.map(
    (call) => call.input as { id: string; input: unknown },
  );
  assert.deepEqual(
    dispatched
      .filter((call) => /^papercraft\.(select|comment|pan)\/v1$/.test(call.id))
      .map((call) => [call.id, call.input]),
    [
      ['papercraft.comment/v1', { canvasId: CANVAS_ID }],
      ['papercraft.pan/v1', { canvasId: CANVAS_ID }],
      ['papercraft.select/v1', { canvasId: CANVAS_ID }],
    ],
  );
});

test('the zoom controls dispatch commands and the reading follows', async () => {
  const { host, node } = await mountWindow();
  const reading = () =>
    commandIn(node, 'papercraft.zoom-reset/v1')?.textContent ?? '';

  assert.match(reading(), /100%/);

  await click(commandIn(node, 'papercraft.zoom-in/v1'));
  await flush(2);
  const zoomIn = host.calls.executes
    .map((call) => call.input as { id: string; input: unknown })
    .find((call) => call.id === 'papercraft.zoom-in/v1');
  assert.deepEqual(zoomIn?.input, { canvasId: CANVAS_ID });
  assert.match(reading(), /120%/);

  await click(commandIn(node, 'papercraft.zoom-reset/v1'));
  await flush(2);
  assert.match(reading(), /100%/);
});

test('the revision reading switches the revision on screen', async () => {
  const { host, node } = await mountWindow({ second: true });
  const reading = () =>
    node.element.querySelector('[role="toolbar"] [aria-label="Revisão"]');

  // More than one revision: the reading is a menu, at the newest.
  assert.ok(reading() !== null, 'the revision reading is no menu');
  assert.match(reading()?.textContent ?? '', /rev 2\/2/);
  assert.match(shownProgram(node) ?? '', /Second/);

  await act(async () => {
    await host.services
      .use(CommandsV1)
      .execute('papercraft.select-revision/v1', {
        canvasId: CANVAS_ID,
        revision: 1,
      });
  });
  await flush();

  await until(
    () => reading()?.textContent ?? '',
    (text) => /rev 1\/2/.test(text),
    'the reading never switched to revision 1',
  );
  await until(
    () => shownProgram(node) ?? '',
    (text) => text.includes('First') && !text.includes('Second'),
    'the frame never drew revision 1',
  );
});

/* What the canvas tells the frame, and hears from it -------------------------- */

test('the frame swallows only the first press of an unfocused node, then all of its input', async () => {
  const { node } = await mountNode();

  // Unfocused, the press that focuses the node never reaches the program.
  assert.equal(captureOf(node), 'first');

  await focusNode(node);
  assert.equal(activeOf(node), 'true');
  // Focused, every tool inspects the program: its input is the canvas's.
  assert.equal(captureOf(node), 'all');
  assert.equal(q(node.element, 'papercraft-selection'), null);

  // The focus goes elsewhere in the app: the next press focuses it again.
  const other = elsewhere();
  await act(async () => {
    other.focus();
    await delivered();
  });
  await flush(2);
  assert.equal(captureOf(node), 'first');
});

test('the canvas window always takes all of the frame input', async () => {
  const { node } = await mountWindow();

  assert.equal(captureOf(node), 'all');
});

test('the frame shows the canvas tool cursor over the program', async () => {
  const { node } = await mountNode();
  await commenting(node);
  const canvas = canvasOf(node);
  const cursor = () => toldOf(node, 'cursor').at(-1);

  await flush(2);
  assert.deepEqual(cursor(), {
    kind: 'cursor',
    locked: true,
    cursor: 'crosshair',
  });

  // The space bar pans: the hand, whatever the program declares.
  await key(canvas, ' ');
  await flush(2);
  assert.deepEqual(cursor(), { kind: 'cursor', locked: true, cursor: 'grab' });

  await act(async () => {
    canvas.dispatchEvent(
      new KeyboardEvent('keyup', { key: ' ', bubbles: true }),
    );
    await delivered();
  });
  await key(canvas, 'Escape');
  await flush(2);
  assert.deepEqual(cursor(), { kind: 'cursor', locked: false });
});

test('the keys the frame reports while the program has the focus are the canvas keys', async () => {
  const { node } = await mountNode();
  await commenting(node);
  const typed = (name: string) =>
    act(async () => {
      frameOf(node).key('keydown', name);
      await delivered();
    });

  assert.equal(toolOf(node), 'comment');
  await typed('c');
  assert.equal(toolOf(node), 'select');
  await typed('C');
  assert.equal(toolOf(node), 'comment');
  await typed('Escape');
  assert.equal(toolOf(node), 'select');
});

test('the wheel over the program pans the focused node and zooms with the modifier', async () => {
  const { node } = await mountNode();
  const viewport = () =>
    (node.element.querySelector('.papercraft-viewport') as HTMLElement).style
      .transform;
  const wheel = (delta: { deltaY: number }, modifiers = {}) =>
    act(async () => {
      frameOf(node).wheel({ x: 10, y: 10 }, delta, modifiers);
      await delivered();
    });

  // Unfocused, the wheel is the conversation's.
  const still = viewport();
  await wheel({ deltaY: 40 });
  assert.equal(viewport(), still);

  await focusNode(node);
  await wheel({ deltaY: 40 });
  assert.match(viewport(), /translate\(0px, -40px\) scale\(1\)/);

  await wheel({ deltaY: -40 }, { ctrlKey: true });
  assert.match(
    q(node.element, 'papercraft-zoom-reset')?.textContent ?? '',
    /110%/,
  );
});

test('the node footer zooms, returns to 100% and centres; the window has none', async () => {
  const { node } = await mountNode();
  await focusNode(node);
  const footer = q(node.element, 'papercraft-footer') as HTMLElement;
  assert.ok(footer !== null, 'the focused node has no footer');
  const reading = () => q(footer, 'papercraft-zoom-reset')?.textContent ?? '';
  const pressControl = async (id: string) => {
    await click(q(footer, id));
    await flush(2);
  };

  assert.match(reading(), /100%/);
  assert.ok(footer.querySelector('[aria-label="Centralizar"]'));

  await pressControl('papercraft-zoom-in');
  assert.match(reading(), /120%/);

  await pressControl('papercraft-zoom-out');
  await pressControl('papercraft-zoom-out');
  assert.match(reading(), /83%/);

  await pressControl('papercraft-zoom-reset');
  assert.match(reading(), /100%/);

  // The window has its own command bar, not this footer.
  const { node: canvas } = await mountWindow();
  assert.equal(q(canvas.element, 'papercraft-footer'), null);
});

/* The redesign's look (ui-redesign §3.1 papercraft row) ---------------------- */

/** The classes of `element`, split. */
const classesOf = (element: Element): string[] =>
  (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

test("the node's preview is a card: radius 10, shadow-sm, no border; the window's canvas is neither", async () => {
  const { node } = await mountNode();
  const card = node.element.querySelector('.papercraft-container') as Element;
  const classes = classesOf(card);
  for (const name of ['rounded-xl', 'shadow-sm', 'bg-card'])
    assert.ok(classes.includes(name), `the node lacks ${name}: ${classes}`);
  for (const name of ['border', 'rounded-lg'])
    assert.ok(!classes.includes(name), `the node has ${name}: ${classes}`);

  const { node: canvas } = await mountWindow();
  const window = classesOf(
    canvas.element.querySelector('.papercraft-container') as Element,
  );
  for (const name of ['rounded-none', 'border-0'])
    assert.ok(window.includes(name), `the window lacks ${name}: ${window}`);
  assert.ok(
    !window.includes('shadow-sm'),
    `the window casts a shadow: ${window}`,
  );
});

test('the node footer draws no divider line: 8 px of space before Centralizar', async () => {
  const { node } = await mountNode();
  await focusNode(node);
  const footer = q(node.element, 'papercraft-footer') as HTMLElement;
  assert.ok(footer !== null, 'the focused node has no footer');
  assert.equal(footer.querySelectorAll('[data-slot="separator"]').length, 0);
  const center = footer.querySelector('[aria-label="Centralizar"]');
  const gap = center?.previousElementSibling;
  assert.ok(gap != null, 'nothing precedes Centralizar');
  assert.ok(
    classesOf(gap).includes('w-2'),
    `not an 8 px gap: ${classesOf(gap)}`,
  );
  assert.equal(gap.getAttribute('aria-hidden'), 'true');
});

test('the canvas tree floats without a rule: radius 6, --background at 80%, blur 4 px, no shadow', async () => {
  const { node } = await mountWindow();
  const tree = node.element.querySelector('.papercraft-tree') as Element;
  const classes = classesOf(tree);
  for (const name of ['rounded-lg', 'bg-background/80', 'backdrop-blur-[4px]'])
    assert.ok(classes.includes(name), `the tree lacks ${name}: ${classes}`);
  for (const name of ['border-r', 'border', 'backdrop-blur'])
    assert.ok(!classes.includes(name), `the tree has ${name}: ${classes}`);
  assert.ok(
    !classes.some((name) => name.startsWith('shadow')),
    `the tree casts a shadow: ${classes}`,
  );
});

test('a thread draws no rule under its header', async () => {
  const { node } = await mountNode({
    items: [draftOf('comment-d1', 1, 'first take')],
  });
  await commenting(node);
  await click(await untilPin(node, 'the draft never became a pin'));
  const thread = threadOf(node) as HTMLElement;
  assert.ok(thread !== null, 'the thread never opened');
  let header = q(thread, 'papercraft-thread-title') as Element | null;
  while (header !== null && header.parentElement !== thread)
    header = header.parentElement;
  assert.ok(header !== null, 'the thread has no header');
  const classes = classesOf(header);
  assert.ok(
    !classes.includes('border-b') && !classes.includes('border-border'),
    `the header draws a rule: ${classes}`,
  );
});
