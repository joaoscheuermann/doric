// The comment pins' pure parts (`surface/pins-layer.tsx`,
// `surface/thread-popover.tsx`, `surface/threads-view.ts`): where the input
// and the thread open beside their pin, and which pins a revision shows.

// PC15 (papercraft-openui.md D19) adds a program's comments: their target,
// their selector or point anchor from the protocol-2 scene, their pins per
// identity and revision, their stack kind and its flush — next to the
// artifact's, which keep their kind. Those cases mount a papercraft fence
// (`support/fence-host.ts`) whose fake frame renders statement wrappers.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import type { PreviewDraft } from '../../src/client/comment.js';
import { setComposerAvailable } from '../../src/client/comment.js';
import { targetKeyOf } from '../../src/client/surface/canvas-source.js';
import {
  ARTIFACT_TARGET_KIND,
  PAPERCRAFT_COMMENT_KIND,
  PROGRAM_COMMENT_KIND,
  PROGRAM_TARGET_KIND,
} from '../../src/contracts/index.js';
import {
  papercraftFlush,
  programFlush,
} from '../../src/desktop/comment-flush.js';
import { closeWindow } from './support/dom.js';
import {
  commentOn,
  flush,
  type Host,
  type MountedElement,
  programFence,
  startHost,
  until,
  viewOf,
} from './support/fence-host.js';

after(closeWindow);

import { threadsOf } from '../../src/client/domain/preview-state.js';
import {
  INPUT_HEIGHT,
  inputPlacement,
} from '../../src/client/surface/pins-layer.js';
import { popoverPlacement } from '../../src/client/surface/thread-popover.js';
import {
  nextPinOf,
  openCountOf,
  pinsOf,
} from '../../src/client/surface/threads-view.js';

const area = { width: 800, height: 600 };

test('the input opens to the right of the pin, level with it', () => {
  const at = { x: 100, y: 200 };
  const placed = inputPlacement(at, area);

  // Right of the 32px pin, never over it.
  assert.ok(placed.left >= at.x + 32);
  assert.ok(placed.top < at.y && placed.top > at.y - 60);
});

test('without room on the right the input opens to the left, still clear of the pin', () => {
  const at = { x: 700, y: 200 };
  const placed = inputPlacement(at, area);

  assert.ok(placed.left + 280 <= at.x);
  assert.ok(placed.left >= 4);
});

test('the input stays inside the canvas at its edges', () => {
  const top = inputPlacement({ x: 100, y: 10 }, area);
  const bottom = inputPlacement({ x: 100, y: 600 }, area);

  assert.ok(top.top >= 4);
  // The popover of a one-line field stays whole inside the canvas.
  assert.ok(bottom.top + INPUT_HEIGHT <= area.height - 4);
});

test('the thread opens below its pin, or above it near the bottom, inside the canvas', () => {
  const below = popoverPlacement({ x: 100, y: 100 }, area);
  assert.ok('top' in below && below.top > 100);

  const above = popoverPlacement({ x: 100, y: 560 }, area);
  assert.ok('bottom' in above && area.height - above.bottom < 560);

  const right = popoverPlacement({ x: 790, y: 100 }, area);
  assert.ok(right.left + 320 <= area.width);
});

const anchor = { form: 'point' as const, x: 10, y: 20 };
const target = { kind: 'artifact', id: 'a', revision: 1, anchor };
const sent = (
  commentId: string,
  extra: { inReplyTo?: string; resolved?: boolean; author?: string } = {},
) => ({
  commentId,
  text: commentId,
  revision: 1,
  anchor,
  resolved: false,
  ...extra,
});
const draft = (
  id: string,
  extra: Partial<PreviewDraft> = {},
): PreviewDraft => ({
  id,
  note: id,
  target,
  ...extra,
});
const place = () => ({ x: 0, y: 0 });

test('a draft root is a pin until its sent comment takes its place; replies never are', () => {
  const threads = threadsOf([sent('c1'), sent('c2')]);
  const drafts = [
    draft('d1', { pin: 3 }),
    draft('reply', { inReplyTo: 'c1' }),
    // Sent already: the durable thread is its pin now.
    draft('c2', { pin: 2 }),
  ];

  const pins = pinsOf(threads, drafts, true, place);

  assert.deepEqual(
    pins.map((pin) => [pin.key, pin.pin, pin.state]),
    [
      ['c1', 1, 'open'],
      ['c2', 2, 'open'],
      ['d1', 3, 'draft'],
    ],
  );
  assert.equal(nextPinOf(threads, drafts), 4);
  assert.equal(openCountOf(threads, drafts), 3);
});

test('resolved threads leave the count, and their pins show only while shown', () => {
  const threads = threadsOf([sent('c1', { resolved: true }), sent('c2')]);

  assert.equal(openCountOf(threads, []), 1);
  assert.deepEqual(
    pinsOf(threads, [], false, place).map((pin) => pin.key),
    ['c2'],
  );
  assert.deepEqual(
    pinsOf(threads, [], true, place).map((pin) => pin.key),
    ['c1', 'c2'],
  );
  // A resolved pin keeps its number: the next one never reuses it.
  assert.equal(nextPinOf(threads, []), 3);
});

test('a pin whose anchor no longer resolves is detached by the edge, never dropped', () => {
  const gone = { form: 'source' as const, path: 'src/Gone.tsx', line: 7 };
  const threads = threadsOf([
    sent('c1'),
    { ...sent('c2'), revision: 1, anchor: gone },
    { ...sent('c3'), anchor: gone },
  ]);
  const drafts = [
    // A draft whose element is gone and that recorded no point of its own.
    draft('d1', { pin: 4, target: { ...target, anchor: gone } }),
  ];
  // Only the free point resolves on this revision.
  const resolveOnly = (at: { form: string }) =>
    at.form === 'point' ? { x: 50, y: 60 } : undefined;

  const pins = pinsOf(threads, drafts, true, resolveOnly, 30);

  assert.deepEqual(
    pins.map((pin) => [pin.key, pin.pin, pin.detached === true]),
    [
      ['c1', 1, false],
      ['c2', 2, true],
      ['c3', 3, true],
      ['d1', 4, true],
    ],
  );
  // Detached pins sit apart from one another, down the content's left edge.
  const detached = pins.filter((pin) => pin.detached === true);
  assert.equal(new Set(detached.map((pin) => pin.point.y)).size, 3);
  for (const pin of detached) assert.equal(pin.point.x, 0);
  // They still count.
  assert.equal(openCountOf(threads, drafts), 4);
});

// ---------------------------------------------------------------------------
// PC15: a program's comments.

test('PC15: a program canvas lists the papercraft-program target of its identity; an artifact keeps artifact', () => {
  assert.equal(PROGRAM_TARGET_KIND, 'papercraft-program');
  assert.notEqual(PROGRAM_TARGET_KIND, ARTIFACT_TARGET_KIND);
  assert.deepEqual(
    targetKeyOf({ kind: 'program', threadId: 't1', identity: 'settings' }),
    { kind: 'papercraft-program', id: 'settings' },
  );
  assert.deepEqual(targetKeyOf({ kind: 'artifact', artifactId: 'a-1' }), {
    kind: 'artifact',
    id: 'a-1',
  });
});

const flushContext = { threadId: 't1', promptId: 'p-1' };
const stackItem = (id: string, kind: string, data: unknown, note: string) => ({
  id,
  kind,
  elementTag: 'chat-comment-line',
  data,
  note,
});

test('PC15: programFlush writes the program target; papercraftFlush still writes artifact targets', async () => {
  const program = {
    kind: 'papercraft-program',
    id: 'settings',
    revision: 2,
    anchor: { form: 'selector', selector: 'save', label: 'Button' },
  };
  const artifact = {
    kind: 'artifact',
    id: 'checkout-7f3a',
    revision: 1,
    anchor: { form: 'selector', selector: 'button#pay' },
  };

  assert.deepEqual(
    await programFlush(
      stackItem(
        'c-1',
        PROGRAM_COMMENT_KIND,
        { target: program, pin: 1 },
        '  more room  ',
      ),
      flushContext,
    ),
    [{ target: program, text: 'more room', commentId: 'c-1' }],
  );
  assert.deepEqual(
    await programFlush(
      stackItem(
        'c-2',
        PROGRAM_COMMENT_KIND,
        { target: program, pin: 1, inReplyTo: 'c-1' },
        'and here',
      ),
      flushContext,
    ),
    [{ target: program, text: 'and here', commentId: 'c-2', inReplyTo: 'c-1' }],
  );
  // No note, or no target: nothing is written yet.
  assert.deepEqual(
    await programFlush(
      stackItem('c-3', PROGRAM_COMMENT_KIND, { target: program }, '   '),
      flushContext,
    ),
    [],
  );
  assert.deepEqual(
    await programFlush(
      stackItem('c-4', PROGRAM_COMMENT_KIND, { other: true }, 'note'),
      flushContext,
    ),
    [],
  );

  assert.deepEqual(
    await papercraftFlush(
      stackItem('c-5', PAPERCRAFT_COMMENT_KIND, { target: artifact }, 'pay'),
      flushContext,
    ),
    [{ target: artifact, text: 'pay', commentId: 'c-5' }],
  );
});

/**
 * What the fake program frame renders: statement wrappers as the real frame
 * writes them, an inline component inside `card`, and a portal outside every
 * wrapper.
 */
const PROGRAM_MARKUP = [
  '<span data-papercraft-statement="root" data-papercraft-component="Stack" style="display: contents">',
  '<div class="stack">',
  '<span data-papercraft-statement="save" data-papercraft-component="Button" style="display: contents">',
  '<button id="save">Save</button>',
  '</span>',
  '<span data-papercraft-statement="card" data-papercraft-component="Card" style="display: contents">',
  '<section id="card"><p id="inline">Inline text</p></section>',
  '</span>',
  '</div>',
  '</span>',
  '<div id="portal"><button id="in-portal">Menu item</button></div>',
].join('');

const PROGRAM = [
  'root = Stack([save, card])',
  'save = Button("Save")',
  'card = Card([TextContent("Inline text")])',
].join('\n');

const mountProgram = async (
  options: { readonly comments?: readonly unknown[] } = {},
): Promise<{ host: Host; node: MountedElement }> => {
  setComposerAvailable(true);
  const host = await startHost({
    frame: { program: () => PROGRAM_MARKUP },
    ...(options.comments === undefined ? {} : { comments: options.comments }),
  });
  const node = await host.mountFence(
    viewOf(programFence(PROGRAM, { identity: 'settings' })),
  );
  await until(
    () => node.frame()?.rendered === true,
    (rendered) => rendered,
    'the program frame never rendered',
  );
  await flush();

  return { host, node };
};

interface DraftData {
  readonly target: {
    readonly kind: string;
    readonly id: string;
    readonly revision: number;
    readonly anchor: {
      readonly form: string;
      readonly selector?: string;
      readonly label?: string;
      readonly x?: number;
      readonly y?: number;
    };
  };
  readonly pin?: number;
  readonly refs?: unknown;
}

test('PC15: a click on a wrapped statement drafts a program comment anchored by selector, labelled by its component', async () => {
  const { host, node } = await mountProgram();

  const draft = await commentOn(host, node, '#save', 'more room');
  const data = draft.data as DraftData;

  assert.equal(draft.kind, PROGRAM_COMMENT_KIND);
  assert.equal(data.target.kind, 'papercraft-program');
  assert.equal(data.target.id, 'settings');
  assert.equal(data.target.revision, 1);
  assert.equal(data.target.anchor.form, 'selector');
  assert.equal(data.target.anchor.selector, 'save');
  assert.equal(data.target.anchor.label, 'Button');
  assert.equal(data.pin, 1);
  assert.deepEqual(data.refs, { title: 'settings' });

  // The next pin of the same identity and revision is the next number.
  const second = await commentOn(host, node, '#save', 'and a border', false);
  assert.equal((second.data as DraftData).pin, 2);

  await host.dispose();
  setComposerAvailable(false);
});

test("PC15: a click on an inline component anchors to its nearest named ancestor's statement", async () => {
  const { host, node } = await mountProgram();

  const draft = await commentOn(host, node, '#inline', 'smaller text');
  const anchor = (draft.data as DraftData).target.anchor;

  assert.equal(anchor.form, 'selector');
  assert.equal(anchor.selector, 'card');
  assert.equal(anchor.label, 'Card');

  await host.dispose();
  setComposerAvailable(false);
});

test('PC15: a click inside a portal, with no named statement above it, anchors by point', async () => {
  const { host, node } = await mountProgram();

  const draft = await commentOn(host, node, '#in-portal', 'menu');
  const anchor = (draft.data as DraftData).target.anchor;

  assert.equal(anchor.form, 'point');
  assert.equal(typeof anchor.x, 'number');
  assert.equal(typeof anchor.y, 'number');
  assert.equal(anchor.selector, undefined);

  await host.dispose();
  setComposerAvailable(false);
});

test('PC15: a pin sits on the statement its selector names, and is detached when the revision lacks it', async () => {
  const sent = (commentId: string, selector: string) => ({
    commentId,
    target: {
      kind: 'papercraft-program',
      id: 'settings',
      revision: 1,
      anchor: { form: 'selector', selector, label: 'Button' },
    },
    text: commentId,
    resolved: false,
    createdAt: '2026-11-06T12:00:00Z',
  });
  const { host, node } = await mountProgram({
    comments: [sent('c-here', 'save'), sent('c-gone', 'gone')],
  });

  const pins = await until(
    () => [...node.element.querySelectorAll('[data-testid="papercraft-pin"]')],
    (found) => found.length === 2,
    'the two sent comments are not both pins',
  );
  const detached = pins.map(
    (pin) => (pin as HTMLElement).getAttribute('data-detached') === 'true',
  );
  assert.deepEqual(detached.sort(), [false, true]);

  await host.dispose();
});
