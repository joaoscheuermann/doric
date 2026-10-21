// The text a comment's note holds, read from its editing host with every line
// break the reader wrote: the browser writes a Shift+Enter as a `\n` where the
// host keeps white space, as a `<br>` or a new block elsewhere (a paste, an
// older engine), and each is one line of the note. The host's own last `<br>`
// only holds an empty last line open.
//
// The note needs no more than a document, so the test opens a happy-dom
// window of its own, as `turn-avatar.test.ts` does.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Window } from 'happy-dom';

import { noteText } from '../../src/client/components/molecules/stack-note.js';

const window = new Window();

/** A note's editing host holding `html`. */
const host = (html: string): HTMLElement => {
  const element = window.document.createElement('span');
  element.innerHTML = html;
  return element as unknown as HTMLElement;
};

describe('noteText', () => {
  test('reads a line break the host keeps as text', () => {
    assert.equal(noteText(host('one\ntwo')), 'one\ntwo');
  });

  test('reads a <br> as a line break', () => {
    assert.equal(noteText(host('one<br>two<br>three')), 'one\ntwo\nthree');
  });

  test('reads the lines a browser wraps in blocks, an empty one included', () => {
    assert.equal(
      noteText(host('one<div>two</div><div><br></div><div>four</div>')),
      'one\ntwo\n\nfour',
    );
  });

  test('leaves out the <br> that only holds an empty last line open', () => {
    assert.equal(noteText(host('one<br>')), 'one');
    assert.equal(noteText(host('one<br><br>')), 'one\n');
  });

  test('reads a note without breaks, and an empty one, as they are', () => {
    assert.equal(noteText(host('one line')), 'one line');
    assert.equal(noteText(host('')), '');
  });
});
