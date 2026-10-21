// The context a comment's card shows above its note: the quoted words read in
// the paragraph they were selected from, the quote alone when that paragraph
// is unknown or no longer holds them, and an anchor's label when it quotes
// nothing.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  anchorBlock,
  commentExcerpt,
  EXCERPT_LEAD,
} from '../src/client/domain/comment-excerpt.js';

const message = (anchor: Record<string, unknown>) => ({
  kind: 'message',
  id: 'prompt-1',
  anchor: { form: 'range', ...anchor },
});

const PARAGRAPH = 'I see the placeholder text and a photo of an orange kitten.';

describe('commentExcerpt', () => {
  test('reads the quote in its paragraph, with the words before and after it', () => {
    assert.deepEqual(
      commentExcerpt(message({ text: 'of an orange' }), PARAGRAPH),
      {
        before: 'I see the placeholder text and a photo ',
        quote: 'of an orange',
        after: ' kitten.',
      },
    );
  });

  test('finds a quote whose line breaks the paragraph draws as spaces', () => {
    const excerpt = commentExcerpt(
      message({ text: 'a photo\nof an' }),
      PARAGRAPH,
    );
    assert.equal(excerpt?.quote, 'a photo of an');
  });

  test('picks the occurrence nearest where the selection started', () => {
    const paragraph = 'one cat, two cats, three cats';
    const first = commentExcerpt(message({ text: 'cat' }), paragraph, 0);
    const last = commentExcerpt(message({ text: 'cat' }), paragraph, 21);
    assert.equal(first?.before, 'one ');
    assert.equal(last?.before, 'one cat, two cats, three ');
  });

  test('picks the occurrence the anchor records when no place is given, else the first', () => {
    const paragraph = 'one cat, two cats, three cats';
    const recorded = commentExcerpt(
      message({ text: 'cat', at: 21 }),
      paragraph,
    );
    const old = commentExcerpt(message({ text: 'cat' }), paragraph);
    assert.equal(recorded?.before, 'one cat, two cats, three ');
    assert.equal(old?.before, 'one ');
    // A place the owner gives wins over the anchor's.
    assert.equal(
      commentExcerpt(message({ text: 'cat', at: 21 }), paragraph, 3)?.before,
      'one ',
    );
  });

  test('cuts a long lead short at a word, so the quote still shows', () => {
    const lead = 'word '.repeat(40);
    const excerpt = commentExcerpt(
      message({ text: 'the end' }),
      `${lead}the end`,
    );
    assert.ok(excerpt);
    assert.ok(excerpt.before.startsWith('…'));
    assert.ok(excerpt.before.length <= EXCERPT_LEAD + 1);
    assert.match(excerpt.before, /^…word /);
    assert.equal(excerpt.quote, 'the end');
  });

  test('shows the quote alone when the paragraph is unknown or no longer holds it', () => {
    const alone = { before: '', quote: 'of an orange', after: '' };
    assert.deepEqual(commentExcerpt(message({ text: 'of an orange' })), alone);
    assert.deepEqual(
      commentExcerpt(message({ text: ' of  an\norange ' }), 'Another text.'),
      alone,
    );
  });

  test("shows an anchor's label, nothing highlighted, when it quotes no words", () => {
    const element = {
      kind: 'artifact',
      id: 'art_1',
      anchor: { form: 'point', x: 10, y: 20, label: 'Button' },
    };
    assert.deepEqual(commentExcerpt(element, PARAGRAPH), {
      before: 'Button (10, 20)',
      quote: '',
      after: '',
    });
    assert.equal(commentExcerpt({ kind: 'artifact', id: 'art_1' }), undefined);
  });
});

describe('anchorBlock', () => {
  test('names the turn and block an anchor records, and only both together', () => {
    assert.deepEqual(anchorBlock(message({ turn: 'agent:p:2', block: 0 })), {
      turn: 'agent:p:2',
      block: 0,
    });
    assert.equal(anchorBlock(message({ turn: 'agent:p:2' })), undefined);
    assert.equal(anchorBlock(message({ block: 1 })), undefined);
    assert.equal(
      anchorBlock(message({ turn: 'agent:p:2', block: -1 })),
      undefined,
    );
  });
});
