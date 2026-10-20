// The composer's stack vocabulary, stated in terms of its arguments: the
// anchor label a line ends with, the fields of an item's data the chat reads,
// what a key does in a stack note, and the claim the built-in projection makes
// over the comment events.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  anchorLabel,
  caretAfterRemoval,
  itemAnchorLabel,
  itemData,
  itemTarget,
  type NoteCaretState,
  noteKeyAction,
  seatOf,
  stackHasWords,
} from '../src/client/domain/composer-stack.js';
import { builtInClaims } from '../src/client/domain/external-blocks.js';
import {
  COMMENTS_ADDED_EVENT,
  COMMENTS_RESOLVED_EVENT,
} from '../src/contracts/index.js';

const item = (data: unknown) => ({
  id: 'item-1',
  kind: 'preview',
  elementTag: 'papercraft-comment-line',
  data,
  author: 'jao.scheuermann',
  note: 'aumenta o respiro do botão',
});

describe('anchorLabel', () => {
  test("reads the stamped file by its name and line, after the element's label", () => {
    assert.equal(
      anchorLabel({
        kind: 'preview',
        id: 'checkout-1',
        revision: 3,
        anchor: {
          form: 'source',
          path: 'src/components/Checkout.tsx',
          line: 42,
        },
      }),
      'Checkout.tsx:42',
    );
    assert.equal(
      anchorLabel({
        kind: 'preview',
        id: 'checkout-1',
        anchor: {
          form: 'source',
          path: 'doric/scripts/fake-host/preview.html',
          line: 7,
          selector: 'main > button',
          label: 'button',
        },
      }),
      'button · preview.html:7',
    );
    assert.equal(
      anchorLabel({
        kind: 'preview',
        id: 'checkout-1',
        anchor: { form: 'source', path: 'src/Checkout.tsx' },
      }),
      'Checkout.tsx',
    );
  });

  test('reads the selector, the position and the selected text in that order', () => {
    assert.equal(
      anchorLabel({
        kind: 'preview',
        id: 'checkout-1',
        anchor: { form: 'selector', selector: '.summary > .row' },
      }),
      '.summary > .row',
    );
    assert.equal(
      anchorLabel({
        kind: 'preview',
        id: 'checkout-1',
        anchor: { form: 'point', x: 412, y: 180 },
      }),
      '412, 180',
    );
    assert.equal(
      anchorLabel({
        kind: 'preview',
        id: 'checkout-1',
        anchor: { form: 'point', x: 412, y: 180, label: 'espaço em' },
      }),
      'espaço em (412, 180)',
    );
    assert.equal(
      anchorLabel({
        kind: 'message',
        id: 'prompt-1',
        anchor: { form: 'range', text: '  falta espaço aqui ' },
      }),
      '“falta espaço aqui”',
    );
  });

  test('says nothing without an anchor it can read', () => {
    assert.equal(anchorLabel(undefined), undefined);
    assert.equal(anchorLabel({}), undefined);
    assert.equal(
      anchorLabel({ anchor: { form: 'source', path: '', line: 42 } }),
      undefined,
    );
  });

  test('reads the target a stack item carries', () => {
    const target = {
      kind: 'preview',
      id: 'checkout-1',
      anchor: { form: 'source', path: 'src/components/Checkout.tsx', line: 42 },
    };

    assert.deepEqual(itemTarget(item({ target })), target);
    assert.equal(itemAnchorLabel(item({ target })), 'Checkout.tsx:42');
    assert.equal(itemAnchorLabel(item({})), undefined);
  });
});

describe('itemData', () => {
  test('reads the stack convention: target, pin, the root a reply continues, refs', () => {
    const target = {
      kind: 'artifact',
      id: 'art_123',
      revision: 2,
      anchor: { form: 'point', x: 1, y: 2 },
    };

    assert.deepEqual(
      itemData(
        item({
          target,
          pin: 3,
          inReplyTo: 'comment-root',
          refs: { title: 'Checkout', source: 'src/Checkout.tsx' },
          artifactId: 'owner-field',
        }),
      ),
      {
        target,
        pin: 3,
        inReplyTo: 'comment-root',
        refs: { title: 'Checkout', source: 'src/Checkout.tsx' },
      },
    );
  });

  test('drops fields of the wrong type, and reads nothing from no data', () => {
    assert.deepEqual(
      itemData(item({ pin: '1', inReplyTo: '', refs: { title: 3 } })),
      {},
    );
    assert.deepEqual(itemData(item(null)), {});
  });
});

describe('seatOf', () => {
  test('reads the seat an item carries: the turn and the 0-based block', () => {
    const seat = { turn: 'agent:p:3', block: 2 };

    assert.deepEqual(seatOf(item({ seat })), seat);
  });

  test('refuses a seat that is not a turn and a 0-based block', () => {
    assert.equal(
      seatOf(item({ seat: { turn: 'agent:p:3', block: -1 } })),
      undefined,
    );
    assert.equal(seatOf(item({ seat: { turn: '', block: 2 } })), undefined);
    assert.equal(
      seatOf(item({ seat: { turn: 'agent:p:3', block: '2' } })),
      undefined,
    );
  });

  test('answers nothing for an item without a seat', () => {
    assert.equal(seatOf(item({})), undefined);
  });
});

describe('stackHasWords', () => {
  test('counts only the items with a note', () => {
    assert.equal(stackHasWords([{ ...item({}), note: ' ' }]), false);
    assert.equal(stackHasWords([item({})]), true);
  });
});

describe('noteKeyAction', () => {
  /** A caret in the middle note of three, on a one-line note with words. */
  const middle: NoteCaretState = {
    index: 1,
    count: 3,
    empty: false,
    firstLine: true,
    lastLine: true,
  };
  const key = (name: string, mod = false, shift = false) => ({
    key: name,
    mod,
    shift,
  });

  test('walks the arrows between notes by visual line', () => {
    assert.deepEqual(noteKeyAction(key('ArrowUp'), middle), {
      kind: 'move',
      to: 'note',
      index: 0,
      atEnd: true,
    });
    assert.deepEqual(noteKeyAction(key('ArrowDown'), middle), {
      kind: 'move',
      to: 'note',
      index: 2,
      atEnd: false,
    });
    // Inside a wrapped note the arrow is the browser's own line move.
    assert.deepEqual(
      noteKeyAction(key('ArrowUp'), { ...middle, firstLine: false }),
      { kind: 'default' },
    );
    assert.deepEqual(
      noteKeyAction(key('ArrowDown'), { ...middle, lastLine: false }),
      { kind: 'default' },
    );
  });

  test('leaves the last note down into the start of the prompt, and stays in the first going up', () => {
    assert.deepEqual(noteKeyAction(key('ArrowDown'), { ...middle, index: 2 }), {
      kind: 'move',
      to: 'prompt',
      atEnd: false,
    });
    assert.deepEqual(noteKeyAction(key('ArrowUp'), { ...middle, index: 0 }), {
      kind: 'default',
    });
  });

  test('moves on with Enter, to the next note or the end of the prompt, and back to the prompt with Escape', () => {
    assert.deepEqual(noteKeyAction(key('Enter'), middle), {
      kind: 'move',
      to: 'note',
      index: 2,
      atEnd: true,
    });
    assert.deepEqual(noteKeyAction(key('Enter'), { ...middle, index: 2 }), {
      kind: 'move',
      to: 'prompt',
      atEnd: true,
    });
    assert.deepEqual(noteKeyAction(key('Escape'), middle), {
      kind: 'move',
      to: 'prompt',
      atEnd: true,
    });
  });

  test('sends with Cmd/Ctrl+Enter', () => {
    assert.deepEqual(noteKeyAction(key('Enter', true), middle), {
      kind: 'send',
    });
  });

  test('removes with Cmd/Ctrl+Backspace, and with Backspace or Delete only in an empty note', () => {
    assert.deepEqual(noteKeyAction(key('Backspace', true), middle), {
      kind: 'remove',
    });
    assert.deepEqual(noteKeyAction(key('Backspace'), middle), {
      kind: 'default',
    });
    assert.deepEqual(noteKeyAction(key('Delete'), middle), {
      kind: 'default',
    });
    const empty = { ...middle, empty: true };
    assert.deepEqual(noteKeyAction(key('Backspace'), empty), {
      kind: 'remove',
    });
    assert.deepEqual(noteKeyAction(key('Delete'), empty), { kind: 'remove' });
  });

  test('leaves typing and selection keys to the note', () => {
    assert.deepEqual(noteKeyAction(key('a'), middle), { kind: 'default' });
    assert.deepEqual(noteKeyAction(key('ArrowUp', false, true), middle), {
      kind: 'default',
    });
  });
});

describe('caretAfterRemoval', () => {
  test('goes to the end of the note before, else the start of the one after, else the prompt', () => {
    assert.deepEqual(caretAfterRemoval(1, 3), {
      to: 'note',
      index: 0,
      atEnd: true,
    });
    assert.deepEqual(caretAfterRemoval(0, 3), {
      to: 'note',
      index: 1,
      atEnd: false,
    });
    assert.deepEqual(caretAfterRemoval(0, 1), { to: 'prompt', atEnd: false });
  });
});

describe('builtInClaims', () => {
  test('claims the comment events: the turns draw them and their markers read them', () => {
    assert.equal(builtInClaims(COMMENTS_ADDED_EVENT, []), true);
    assert.equal(builtInClaims(COMMENTS_RESOLVED_EVENT, []), true);
    // A generic versioned type nobody claims stays generic.
    assert.equal(builtInClaims('unrelated.event/v1', []), false);
    // The qualified aliases of the durable runtime types stay claimed.
    assert.equal(
      builtInClaims('runtime.prompt-finished/v1', [
        'runtime.prompt-finished/v1',
      ]),
      true,
    );
    // A type a projector could claim is not the built-in's.
    assert.equal(builtInClaims('artifacts.created/v1', []), false);
  });
});
