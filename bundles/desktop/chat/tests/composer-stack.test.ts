// The composer's stack vocabulary, stated in terms of its arguments: the
// anchor label a line ends with, the words a comment-only send carries, and
// the claim the built-in projection makes over `comments.added/v1`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  anchorLabel,
  itemAnchorLabel,
  itemTarget,
  stackHasWords,
  stackPromptText,
} from '../src/client/domain/composer-stack.js';
import { builtInClaims } from '../src/client/domain/external-blocks.js';
import { COMMENTS_ADDED_EVENT } from '../src/contracts/index.js';

const item = (data: unknown) => ({
  id: 'item-1',
  kind: 'preview',
  elementTag: 'papercraft-comment-line',
  data,
  author: 'jao.scheuermann',
  note: 'aumenta o respiro do botão',
});

describe('anchorLabel', () => {
  test('reads the stamped file and line', () => {
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
      'src/components/Checkout.tsx:42',
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
    assert.equal(
      itemAnchorLabel(item({ target })),
      'src/components/Checkout.tsx:42',
    );
    assert.equal(itemAnchorLabel(item({})), undefined);
  });
});

describe('stackPromptText', () => {
  test('carries one Markdown line per item, anchored to what it comments', () => {
    assert.equal(
      stackPromptText([
        item({
          target: {
            kind: 'preview',
            id: 'checkout-1',
            anchor: {
              form: 'source',
              path: 'src/components/Checkout.tsx',
              line: 42,
            },
          },
        }),
        {
          id: 'item-2',
          kind: 'message',
          elementTag: 'chat-comment-line',
          data: {
            target: {
              kind: 'message',
              id: 'prompt-2',
              anchor: { form: 'range', text: 'essa resposta' },
            },
          },
          note: 'essa resposta está desatualizada',
        },
      ]),
      [
        '- aumenta o respiro do botão — src/components/Checkout.tsx:42',
        '- essa resposta está desatualizada — “essa resposta”',
      ].join('\n'),
    );
  });

  test('leaves the items without a note out, and says so', () => {
    const empty = { ...item({}), note: '' };

    assert.equal(stackPromptText([empty]), '');
    assert.equal(stackHasWords([empty]), false);
    assert.equal(stackHasWords([item({})]), true);
    assert.equal(stackPromptText([item({})]), '- aumenta o respiro do botão');
  });
});

describe('builtInClaims', () => {
  test('claims the comments of a send for the user turn they belong to', () => {
    assert.equal(builtInClaims(COMMENTS_ADDED_EVENT, []), true);
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
