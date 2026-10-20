// The identity a conversation block carries through its serialized form.
//
// The sync rewrites blocks in place and a replay — a reopened Thread, a history
// entry, a duplicated editor — rebuilds them from what `exportJSON` wrote. So
// the mark a turn wears, and who and when its footer names, have to survive that
// form. This lives beside `tests/conversation-nodes.test.ts` rather than in it
// because the blocks are client code: the DOM-free project compiles no `.tsx`
// with JSX.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createEditor } from 'lexical';

import {
  $createAgentTurnNode,
  AgentTurnNode,
} from '../../src/client/components/organisms/conversation/nodes/agent-turn-node.js';
import {
  $isCommentSeatNode,
  CommentSeatNode,
} from '../../src/client/components/organisms/conversation/nodes/comment-seat-node.js';
import type { AgentTurn } from '../../src/client/domain/projector.js';
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

const promptId = '33333333-3333-4333-8333-333333333333';
const at = '2026-03-12T14:55:00.000Z';

const editor = createEditor({
  namespace: 'test',
  nodes: [
    UserTurnNode,
    AgentTurnNode,
    UserPromptNode,
    TurnAuthorNode,
    CommentSeatNode,
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

  test('a comment seat stays after the block it belongs to when the turn is rebuilt', () => {
    const rebuilt = inEditor(() => {
      const turn = $createAgentTurnNode(
        'turn-2',
        promptId,
        'completed',
        'first\n\nsecond\n\nthird',
      );
      const seat = turn.openSeat(2, 'third');
      // One more block, which only the tail of the answer outgrows: the block
      // before it, and the seat after it, stay where they are.
      turn.setTurn({
        type: 'agent',
        promptId,
        status: 'completed',
        text: 'first\n\nsecond\n\nthird\n\nfourth',
        events: [],
      } as AgentTurn);

      return { turn, seat, kept: turn.seat(2), seats: turn.seats() };
    });

    assert.deepEqual(rebuilt.seats, [rebuilt.seat]);
    assert.equal(rebuilt.kept, rebuilt.seat);
    assert.equal($isCommentSeatNode(rebuilt.kept), true);
    assert.equal(rebuilt.kept?.isAttached(), true);
    assert.equal(rebuilt.kept?.getParent(), rebuilt.turn);
    // The seat still stands right after block 2, before the added block.
    assert.deepEqual(
      rebuilt.turn.getChildren().map((child) => child.getType()),
      [
        'paragraph',
        'paragraph',
        'paragraph',
        'chat-comment-seat-node',
        'paragraph',
      ],
    );
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
