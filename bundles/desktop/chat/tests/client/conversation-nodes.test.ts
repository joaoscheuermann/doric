// The identity a conversation block carries through its serialized form, and
// the comments an agent turn holds through a rebuild.
//
// The sync rewrites blocks in place and a replay — a reopened Thread, a history
// entry, a duplicated editor — rebuilds them from what `exportJSON` wrote. So
// the mark a turn wears, and who and when its footer names, have to survive that
// form; and a turn rebuilt from a growing answer keeps its comments where they
// stand. This lives beside `tests/conversation-nodes.test.ts` rather than in it
// because the blocks are client code: the DOM-free project compiles no `.tsx`
// with JSX.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { $isListNode, ListItemNode, ListNode } from '@lexical/list';
import {
  $getRoot,
  $isElementNode,
  createEditor,
  type LexicalNode,
} from 'lexical';

import {
  $createAgentTurnNode,
  AgentTurnNode,
} from '../../src/client/components/organisms/conversation/nodes/agent-turn-node.js';
import {
  $isCommentSeatNode,
  CommentSeatNode,
} from '../../src/client/components/organisms/conversation/nodes/comment-seat-node.js';
import {
  $createTurnAuthorNode,
  TurnAuthorNode,
} from '../../src/client/components/organisms/conversation/nodes/turn-author-node.js';
import {
  $createUserPromptNode,
  UserPromptNode,
} from '../../src/client/components/organisms/conversation/nodes/user-prompt-node.js';
import {
  $createUserTurnNode,
  UserTurnNode,
} from '../../src/client/components/organisms/conversation/nodes/user-turn-node.js';
import type { AgentTurn } from '../../src/client/domain/projector.js';

const promptId = '33333333-3333-4333-8333-333333333333';
const at = '2026-03-12T14:55:00.000Z';

/** A turn's children in brief: its lists with their items' text and comments. */
const shape = (turn: LexicalNode): string[] =>
  ($isElementNode(turn) ? turn.getChildren() : []).map((child) => {
    if ($isCommentSeatNode(child)) return child.id;
    if (!$isListNode(child)) return child.getType();
    const items = child.getChildren().map((item) => {
      const children = $isElementNode(item) ? item.getChildren() : [];
      const text = children
        .filter((part) => !$isCommentSeatNode(part))
        .map((part) => part.getTextContent())
        .join('');
      const seats = children.filter($isCommentSeatNode).map((seat) => seat.id);
      return [text, ...seats].join(' + ');
    });
    return `list[${items.join(' | ')}]`;
  });

const editor = createEditor({
  namespace: 'test',
  nodes: [
    UserTurnNode,
    AgentTurnNode,
    UserPromptNode,
    TurnAuthorNode,
    CommentSeatNode,
    ListNode,
    ListItemNode,
  ],
});

/**
 * Runs `pass` inside the editor, as a replay would, and answers what it built.
 * Lexical reports an update's own errors and carries on, so a failure inside is
 * carried out and thrown here, where it fails the test instead of passing it.
 */
const inEditor = <T>(pass: () => T): T => {
  let built: { value: T } | undefined;
  let failed: { error: unknown } | undefined;
  editor.update(() => {
    try {
      built = { value: pass() };
    } catch (error) {
      failed = { error };
    }
  });
  if (failed !== undefined) throw failed.error;
  assert.ok(built !== undefined, 'the editor ran the pass');
  return built.value;
};

/** A serialized block, as a replay reads it back from disk or from history. */
const reread = (serialized: unknown) => JSON.parse(JSON.stringify(serialized));

/**
 * What a serialized block carries beyond the same block written without a mark:
 * the avatar, in whatever field the block writes it — the value, not the name of
 * the field, which is the block's own business. A block that wrote it twice, or
 * not at all, answers with as much, and the expected mark below then fails.
 */
const markOf = (marked: object, plain: object): unknown[] => {
  const withMark = marked as Record<string, unknown>;
  const without = plain as Record<string, unknown>;
  return Object.keys(withMark)
    .filter(
      (key) => JSON.stringify(withMark[key]) !== JSON.stringify(without[key]),
    )
    .map((key) => withMark[key]);
};

const reader = { role: 'user', name: 'jao.scheuermann' } as const;
const agent = { role: 'agent', name: 'agent' } as const;

describe('the mark a conversation block carries through its serialized form', () => {
  test('a reader turn keeps its avatar', () => {
    const written = inEditor(() => {
      const turn = $createUserTurnNode(
        'turn-1',
        promptId,
        undefined,
        'Where is the parser?',
        true,
      );
      const plain = $createUserTurnNode(
        'turn-1',
        promptId,
        undefined,
        'Where is the parser?',
        true,
      );
      turn.setAvatar(reader);
      const serialized = turn.exportJSON();

      return {
        serialized: markOf(serialized, plain.exportJSON()),
        // `importJSON` restores the text through the sync, not through the
        // serialized form, so the block it reads back is the one to compare.
        restored: markOf(
          UserTurnNode.importJSON(reread(serialized)).exportJSON(),
          $createUserTurnNode(
            'turn-1',
            promptId,
            undefined,
            '',
            true,
          ).exportJSON(),
        ),
      };
    });

    assert.deepEqual(written.serialized, [reader]);
    assert.deepEqual(written.restored, [reader]);
  });

  test('an agent turn keeps its avatar', () => {
    const written = inEditor(() => {
      const turn = $createAgentTurnNode(
        'turn-2',
        promptId,
        'completed',
        'It lives in src/parser.ts.',
      );
      const plain = $createAgentTurnNode(
        'turn-2',
        promptId,
        'completed',
        'It lives in src/parser.ts.',
      );
      turn.setAvatar(agent);
      const serialized = turn.exportJSON();

      return {
        serialized: markOf(serialized, plain.exportJSON()),
        restored: markOf(
          AgentTurnNode.importJSON(reread(serialized)).exportJSON(),
          $createAgentTurnNode(
            'turn-2',
            promptId,
            'completed',
            '',
          ).exportJSON(),
        ),
      };
    });

    assert.deepEqual(written.serialized, [agent]);
    assert.deepEqual(written.restored, [agent]);
  });

  test('the prompt keeps its avatar', () => {
    const written = inEditor(() => {
      const prompt = $createUserPromptNode();
      const plain = $createUserPromptNode();
      prompt.setAvatar(reader);
      const serialized = prompt.exportJSON();

      return {
        serialized: markOf(serialized, plain.exportJSON()),
        restored: markOf(
          UserPromptNode.importJSON(reread(serialized)).exportJSON(),
          plain.exportJSON(),
        ),
      };
    });

    assert.deepEqual(written.serialized, [reader]);
    assert.deepEqual(written.restored, [reader]);
  });

  test('a comment on an item of a loose list stays in that item through a streamed delta and a redraw', () => {
    const kept = inEditor(() => {
      const turn = $createAgentTurnNode(
        'turn-4',
        promptId,
        'completed',
        '1. a\n\n2. b\n\npara',
      );
      turn.openSeat({
        id: 'comment-loose',
        block: 0,
        quote: 'b',
        at: 1,
        after: 0,
        item: 1,
      });
      // A comment after the paragraph that follows the list.
      turn.openSeat({
        id: 'comment-after',
        block: 1,
        quote: 'para',
        at: 0,
        after: 1,
      });
      turn.setTurn({
        type: 'agent',
        promptId,
        status: 'completed',
        text: '1. a\n\n2. b\n\npara more',
        events: [],
      } as AgentTurn);
      const afterDelta = shape(turn);
      turn.restore();
      return { afterDelta, afterRestore: shape(turn) };
    });

    const expected = [
      'list[a | b + comment-loose]',
      'paragraph',
      'comment-after',
    ];
    assert.deepEqual(kept.afterDelta, expected);
    assert.deepEqual(kept.afterRestore, expected);
  });

  test('the footer keeps who wrote the turn and when', () => {
    const footer = inEditor(() =>
      TurnAuthorNode.importJSON(
        reread(
          $createTurnAuthorNode('user', 'jao.scheuermann', at).exportJSON(),
        ),
      ),
    ).exportJSON();

    assert.equal(footer.role, 'user');
    assert.equal(footer.name, 'jao.scheuermann');
    assert.equal(footer.at, at);
  });
});

describe('the comments an agent turn holds when it is rebuilt', () => {
  test('the comments after a block stay there, in passage order, when the turn is rebuilt', () => {
    const rebuilt = inEditor(() => {
      const turn = $createAgentTurnNode(
        'turn-2',
        promptId,
        'completed',
        'first\n\nsecond\n\nthird and more',
      );
      $getRoot().clear().append(turn);
      // Two comments on block 2, the later passage's written first.
      const later = turn.openSeat({
        id: 'comment-later',
        block: 2,
        quote: 'more',
        at: 8,
      });
      const earlier = turn.openSeat({
        id: 'comment-earlier',
        block: 2,
        quote: 'third',
        at: 0,
      });
      // One more block, which only the tail of the answer outgrows: the block
      // before it, and the comments after it, stay where they are.
      turn.setTurn({
        type: 'agent',
        promptId,
        status: 'completed',
        text: 'first\n\nsecond\n\nthird and more\n\nfourth',
        events: [],
      } as AgentTurn);

      return {
        seats: turn.seats().map((seat) => seat.getKey()),
        expected: [earlier.getKey(), later.getKey()],
        attached: later.isAttached(),
        inTurn: later.getParent()?.is(turn) === true,
        children: turn.getChildren().map((child) => child.getType()),
      };
    });

    assert.deepEqual(rebuilt.seats, rebuilt.expected);
    assert.equal(rebuilt.attached, true);
    assert.equal(rebuilt.inTurn, true);
    // Both still stand right after block 2, before the added block.
    assert.deepEqual(rebuilt.children, [
      'paragraph',
      'paragraph',
      'paragraph',
      'chat-comment-seat-node',
      'chat-comment-seat-node',
      'paragraph',
    ]);
  });

  test('a comment that closes a list item stays at its end when the turn is rebuilt', () => {
    const rebuilt = inEditor(() => {
      const turn = $createAgentTurnNode(
        'turn-3',
        promptId,
        'completed',
        'intro\n\n- one\n- two',
      );
      const seat = turn.openSeat({
        id: 'comment-item',
        block: 1,
        quote: 'one',
        at: 0,
        after: 1,
        item: 0,
      });
      turn.setTurn({
        type: 'agent',
        promptId,
        status: 'completed',
        text: 'intro\n\n- one\n- two\n\nmore',
        events: [],
      } as AgentTurn);

      const list = turn.getChildren()[1];
      const items = $isElementNode(list) ? list.getChildren() : [];
      const first = items[0];
      return {
        seats: turn.seats().map((standing) => standing.getKey()),
        seat: seat.getKey(),
        holder: $isElementNode(first)
          ? first.getChildren().map((child) => child.getType())
          : [],
      };
    });

    assert.deepEqual(rebuilt.seats, [rebuilt.seat]);
    assert.equal(rebuilt.holder.at(-1), 'chat-comment-seat-node');
  });
});
