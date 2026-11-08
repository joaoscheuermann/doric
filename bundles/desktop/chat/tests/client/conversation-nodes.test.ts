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
//
// The fence node (openui.md D1: B4, B19, B1's `origin`; conversation-openui.md
// C15) and the UI-action caption (C4) are drawn in a real window, by a probe
// that registers a fence renderer (`support/fences.ts`).

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

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
import type { ChatFenceView } from '../../src/contracts/index.js';
import {
  answering,
  assertReady,
  conversationText,
  type FenceElement,
  fenceProbe,
  otherThreadId,
  push,
  snapshot,
  threadEvent,
  threadId,
  threadPath,
  threadRecord,
  threadUrl,
} from './support/fences.js';
import {
  type ChatWindow,
  openChatWindow,
  type Probe,
  settle,
} from './support/window.js';

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
const agent = {
  role: 'agent',
  name: 'agent',
  icon: { kind: 'fallback' },
} as const;

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

describe('a UI-action prompt keeps its program through its serialized form (C4)', () => {
  test('exportJSON and importJSON keep the user turn’s action', () => {
    const kept = inEditor(() => {
      const turn = $createUserTurnNode(
        'turn-ui',
        promptId,
        undefined,
        'Tag the release',
        true,
        null,
        { program: 'release' },
      );
      const serialized = turn.exportJSON();
      return {
        written: serialized.action,
        restored: UserTurnNode.importJSON(reread(serialized)).exportJSON()
          .action,
      };
    });

    assert.deepEqual(kept.written, { program: 'release' });
    assert.deepEqual(kept.restored, { program: 'release' });
  });
});

// The fence in the conversation (openui.md D1, D2), drawn in a real window by
// a probe that registers a fence renderer through `chat.views/v1`.

let opened: ChatWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

const fenceHost = {
  'runtime.threads/v1.thread': (input: unknown) =>
    threadRecord(typeof input === 'string' ? input : threadId),
  'runtime.threads/v1.queue': () => ({
    revision: 1,
    paused: false,
    stopping: false,
    items: [],
  }),
};

/** Opens the Thread with the probe, answering its watch with `events`. */
const openWith = async (
  probe: Probe,
  events: readonly unknown[],
): Promise<ChatWindow> => {
  opened = await openChatWindow({
    url: threadUrl(threadId),
    host: fenceHost,
    probe,
  });
  await settle(50);
  snapshot(opened, events);
  await settle(150);
  return opened;
};

const closedFence = '```probe-ui\nroot = Form()\n```';
const fenceAnswer = (fence = closedFence) =>
  answering(`Here is the form:\n\n${fence}\n\nFill it in.`);

const fences = (window: ChatWindow, tag = 'probe-fence') => [
  ...window.document.querySelectorAll(tag),
];

/** Keys typed where `target` is, as the reader would. */
const keydown = (target: Element, key: string, modifiers = {}) => {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  target.dispatchEvent(event);
  return event;
};

describe('a fence in the conversation (B4, B1)', () => {
  test('a streamed fence keeps one element across ten flushes, its view set before it connects', async () => {
    const { probe, state } = fenceProbe([['probe-ui', 'probe-fence']]);
    const window = await openWith(
      probe,
      answering('Here is the form:\n\n```probe-ui\nline 0'),
    );
    assertReady(state);

    const [first] = fences(window);
    assert.ok(first, 'the fence is drawn by the registered element');
    for (let flush = 1; flush < 10; flush += 1) {
      push(
        window,
        threadEvent(4 + flush, {
          type: 'text.delta',
          delta: `\nline ${flush}`,
        }),
      );
      await settle(100);
      assert.deepEqual(fences(window), [first], `flush ${flush}`);
    }
    assert.equal(state.created.length, 1);
    assert.equal(state.disposed.length, 0);

    const view = state.connected[0]?.view as ChatFenceView | undefined;
    assert.equal(view?.fence.key, `${promptId}/4/0`);
    assert.equal(view?.fence.state, 'streaming');
    // The Thread's record has no `origin`: it is the reader's.
    assert.equal(view?.origin, 'user');
    assert.deepEqual(
      view?.fences.map((fence) => fence.key),
      [`${promptId}/4/0`],
    );
    assert.ok(
      conversationText(state).includes(
        `\`\`\`probe-ui\n${Array.from({ length: 10 }, (_, line) => `line ${line}`).join('\n')}`,
      ),
      'the node reads as the fence source',
    );
  });

  test('Backspace and Ctrl+A on the selected fence reach neither the editor nor the turn', async () => {
    const { probe, state } = fenceProbe([['probe-ui', 'probe-fence']]);
    const window = await openWith(probe, fenceAnswer());
    assertReady(state);
    const [element] = fences(window);
    assert.ok(element);
    const root = state.editor?.getRootElement();
    assert.ok(root);
    const reached: string[] = [];
    root.addEventListener('keydown', (event) => reached.push(event.key));
    const before = conversationText(state);

    (element as HTMLElement).click();
    await settle();
    keydown(element, 'Backspace');
    keydown(element, 'a', { ctrlKey: true });
    await settle();

    assert.deepEqual(reached, []);
    assert.equal(element.isConnected, true);
    assert.equal(conversationText(state), before);
  });
});

describe('the keys typed in a control a fence draws (C15)', () => {
  test('Backspace, Delete, the arrows and Enter reach the input, and the turn is unchanged', async () => {
    const { probe, state } = fenceProbe([['probe-ui', 'probe-fence']]);
    const window = await openWith(probe, fenceAnswer());
    assertReady(state);
    const input = fences(window)[0]?.querySelector('input');
    assert.ok(input, 'the element draws its control');
    const root = state.editor?.getRootElement();
    assert.ok(root);
    const atInput: string[] = [];
    const atEditor: string[] = [];
    input.addEventListener('keydown', (event) => atInput.push(event.key));
    root.addEventListener('keydown', (event) => atEditor.push(event.key));
    const before = conversationText(state);
    const keys = [
      'Backspace',
      'Delete',
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Enter',
    ];

    input.focus();
    const prevented = keys.filter(
      (key) => keydown(input, key).defaultPrevented,
    );
    await settle();

    assert.deepEqual(atInput, keys);
    assert.deepEqual(prevented, []);
    assert.deepEqual(atEditor, []);
    assert.equal(conversationText(state), before);
  });
});

describe('when a fence element is disposed (B19)', () => {
  test('a rewind that removes the fence disposes its element through ui/v1', async () => {
    const { probe, state } = fenceProbe([['probe-ui', 'probe-fence']]);
    const window = await openWith(probe, fenceAnswer());
    assertReady(state);
    const [element] = fences(window);
    assert.ok(element);

    push(
      window,
      threadEvent(5, { type: 'history.truncated', afterSequence: 0 }),
    );
    await settle(150);

    assert.deepEqual(fences(window), []);
    assert.deepEqual(state.disposed, [element]);
  });

  test('showing another Thread disposes every element of the first', async () => {
    const { probe, state } = fenceProbe([['probe-ui', 'probe-fence']]);
    const window = await openWith(
      probe,
      answering(`${closedFence}\n\n${closedFence}`),
    );
    assertReady(state);
    const shown = fences(window);
    assert.equal(shown.length, 2);

    window.window.history.pushState(null, '', threadPath(otherThreadId));
    window.window.dispatchEvent(new window.window.PopStateEvent('popstate'));
    await settle(150);

    assert.deepEqual(new Set(state.disposed), new Set(shown));
  });

  test('disposing the registration turns the fences into code blocks and disposes their elements', async () => {
    const { probe, state } = fenceProbe([['probe-ui', 'probe-fence']]);
    const window = await openWith(probe, fenceAnswer());
    assertReady(state);
    const [element] = fences(window);
    assert.ok(element);

    state.registrations.get('probe-ui')?.dispose();
    await settle(150);

    assert.deepEqual(fences(window), []);
    assert.deepEqual(state.disposed, [element]);
    assert.ok(
      [...window.document.querySelectorAll('code')].some((code) =>
        code.textContent?.includes('root = Form()'),
      ),
      'the fence is a code block again',
    );
  });

  test('registering a tag turns its code blocks into fences', async () => {
    const { probe, state } = fenceProbe([], ['probe-fence']);
    const window = await openWith(probe, fenceAnswer());
    assert.deepEqual(fences(window), []);

    state.register('probe-ui', 'probe-fence');
    await settle(150);

    assertReady(state);
    const [element] = fences(window) as FenceElement[];
    assert.ok(element, 'the code block became a fence');
    assert.equal(element.view?.fence.body, 'root = Form()');
    assert.equal(element.view?.fence.state, 'closed');
  });

  test('registering a second tag keeps the elements of the first, the same objects', async () => {
    const { probe, state } = fenceProbe(
      [['probe-ui', 'probe-fence']],
      ['probe-fence', 'probe-other-fence'],
    );
    const window = await openWith(
      probe,
      answering(`${closedFence}\n\n\`\`\`other-ui\nx = 1\n\`\`\``),
    );
    assertReady(state);
    const before = fences(window);
    assert.equal(before.length, 1);

    state.register('other-ui', 'probe-other-fence');
    await settle(150);

    assertReady(state);
    assert.equal(fences(window, 'probe-other-fence').length, 1);
    assert.deepEqual(fences(window), before);
    assert.deepEqual(state.disposed, []);
  });
});

describe('the caption of a UI-action prompt (C4)', () => {
  test('the user turn of a UI-action prompt carries its program on its block', async () => {
    const { probe } = fenceProbe([]);
    const window = await openWith(probe, [
      threadEvent(1, {
        type: 'prompt.accepted',
        text: '<ui-action program="release">\nTag the release\n</ui-action>',
        source: { kind: 'user' },
      }),
      threadEvent(2, { type: 'prompt.started' }),
    ]);

    const block = window.document.querySelector('[data-ui-action]');
    assert.equal(block?.getAttribute('data-ui-action'), 'release');
    assert.equal(block?.getAttribute('data-prompt-id'), promptId);
    assert.equal(block?.textContent?.trim(), 'Tag the release');
  });
});
