// The comment threads a Thread's log holds, as the projection reads them: the
// state each thread is in, folded across the whole log; the agent's replies
// drawn where it wrote them in its turn, one block per run of replies, in
// place of the `comment_reply` rows that wrote them; and the comment each
// reply answers.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  agentReplies,
  threadState,
} from '../src/client/domain/comment-threads.js';
import {
  emptyProjection,
  type Projection,
  projectEvents,
  type RepliesTurn,
  type Turn,
} from '../src/client/domain/projector.js';
import type { ThreadEvent } from '../src/client/domain/workspace.js';

const event = (
  sequence: number,
  promptId: string,
  value: Readonly<Record<string, unknown> & { readonly type: string }>,
): ThreadEvent => ({
  projectId: 'project',
  threadId: 'thread',
  promptId,
  sequence,
  type: value.type,
  event: value,
  createdAt: `2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`,
});

const target = {
  kind: 'artifact',
  id: 'art_1',
  revision: 1,
  anchor: { form: 'point', x: 10, y: 20, label: 'Button' },
};

const accepted = (sequence: number, promptId: string, text = 'Ajusta') =>
  event(sequence, promptId, {
    type: 'prompt.accepted',
    text,
    source: { kind: 'user' },
  });

const finished = (sequence: number, promptId: string, text = '') =>
  event(sequence, promptId, {
    type: 'prompt.finished',
    status: 'completed',
    text,
  });

/** A comment the reader's send flushed. */
const comment = (
  sequence: number,
  promptId: string,
  commentId: string,
  text: string,
  inReplyTo?: string,
) =>
  event(sequence, promptId, {
    type: 'comments.added/v1',
    commentId,
    target,
    text,
    author: 'jao.scheuermann',
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
  });

/** The agent's answer, as `comment_reply` writes it. */
const reply = (
  sequence: number,
  promptId: string,
  commentId: string,
  inReplyTo: string,
  text: string,
) =>
  event(sequence, promptId, {
    type: 'comments.added/v1',
    commentId,
    target,
    text,
    author: 'agent',
    inReplyTo,
  });

const resolved = (
  sequence: number,
  promptId: string,
  commentId: string,
  value: boolean,
) =>
  event(sequence, promptId, {
    type: 'comments.resolved/v1',
    commentId,
    resolved: value,
  });

const toolStarted = (
  sequence: number,
  promptId: string,
  id: string,
  name: string,
) =>
  event(sequence, promptId, {
    type: 'tool.started',
    call: { id, name, index: 0, payload: {} },
  });

const toolFinished = (
  sequence: number,
  promptId: string,
  id: string,
  name: string,
) =>
  event(sequence, promptId, {
    type: 'tool.finished',
    call: { id, name, index: 0, payload: {} },
    record: { output: '{}' },
  });

const toolFailed = (
  sequence: number,
  promptId: string,
  id: string,
  name: string,
) =>
  event(sequence, promptId, {
    type: 'tool.failed',
    call: { id, name, index: 0, payload: {} },
    error: {
      message: 'The comment "comment-x" is unknown in this conversation.',
    },
  });

const text = (sequence: number, promptId: string, delta: string) =>
  event(sequence, promptId, { type: 'text.delta', delta });

const project = (events: readonly ThreadEvent[]): Projection =>
  projectEvents(emptyProjection, events);

const stateOf = (projection: Projection, rootId: string) => {
  const thread = projection.threads.get(rootId);
  assert.ok(thread, `the log holds the thread of ${rootId}`);
  return { state: threadState(thread), replies: agentReplies(thread) };
};

const types = (turns: readonly Turn[]): readonly string[] =>
  turns.map((turn) => turn.type);

const repliesOf = (turns: readonly Turn[]): readonly RepliesTurn[] =>
  turns.filter((turn): turn is RepliesTurn => turn.type === 'replies');

describe('comment thread state', () => {
  test('a comment nobody answered is open; the agent answering it waits for the reader', () => {
    const asked = project([
      accepted(1, 'p1'),
      comment(2, 'p1', 'c-a', 'aumenta o botão'),
    ]);
    assert.deepEqual(stateOf(asked, 'c-a'), { state: 'open', replies: 0 });

    const answered = projectEvents(asked, [
      reply(3, 'p1', 'c-r1', 'c-a', 'Qual tamanho?'),
    ]);
    assert.deepEqual(stateOf(answered, 'c-a'), { state: 'await', replies: 1 });
  });

  test("the reader's answer opens the thread again, and a resolution closes it whoever spoke last", () => {
    const log = [
      accepted(1, 'p1'),
      comment(2, 'p1', 'c-a', 'aumenta o botão'),
      reply(3, 'p1', 'c-r1', 'c-a', 'Qual tamanho?'),
      finished(4, 'p1'),
      accepted(5, 'p2', ''),
      comment(6, 'p2', 'c-b', 'o dobro', 'c-a'),
    ];
    const reopened = project(log);
    assert.deepEqual(stateOf(reopened, 'c-a'), { state: 'open', replies: 1 });

    const done = projectEvents(reopened, [
      reply(7, 'p2', 'c-r2', 'c-a', 'Dobrei.'),
      resolved(8, 'p2', 'c-a', true),
    ]);
    assert.deepEqual(stateOf(done, 'c-a'), { state: 'done', replies: 2 });
  });

  test('reopening a resolved thread returns it to the state its last message gives', () => {
    const log = [
      accepted(1, 'p1'),
      comment(2, 'p1', 'c-a', 'aumenta o botão'),
      reply(3, 'p1', 'c-r1', 'c-a', 'Aumentei.'),
      resolved(4, 'p1', 'c-a', true),
    ];
    const done = project(log);
    assert.equal(stateOf(done, 'c-a').state, 'done');

    const reopened = projectEvents(done, [resolved(5, 'p1', 'c-a', false)]);
    assert.equal(stateOf(reopened, 'c-a').state, 'await');
    // The projection read before keeps the state it was read with.
    assert.equal(stateOf(done, 'c-a').state, 'done');
  });

  test('reads the same threads from a replayed log as from the live batches', () => {
    const log = [
      accepted(1, 'p1'),
      comment(2, 'p1', 'c-a', 'aumenta o botão'),
      comment(3, 'p1', 'c-b', 'muda a cor'),
      reply(4, 'p1', 'c-r1', 'c-a', 'Aumentei.'),
      resolved(5, 'p1', 'c-a', true),
    ];
    const live = log.reduce(
      (projection, item) => projectEvents(projection, [item]),
      emptyProjection,
    );
    const whole = project(log);
    for (const root of ['c-a', 'c-b'])
      assert.deepEqual(stateOf(live, root), stateOf(whole, root));
    assert.deepEqual(stateOf(whole, 'c-b'), { state: 'open', replies: 0 });
  });
});

describe('reply blocks', () => {
  test('a reply is drawn where the agent wrote it, in place of its successful tool row', () => {
    const projection = project([
      accepted(1, 'p1'),
      comment(2, 'p1', 'c-a', 'aumenta o botão'),
      text(3, 'p1', 'Vou ajustar.'),
      toolStarted(4, 'p1', 'call-1', 'comment_reply'),
      reply(5, 'p1', 'c-r1', 'c-a', 'Aumentei o padding.'),
      toolFinished(6, 'p1', 'call-1', 'comment_reply'),
      text(7, 'p1', 'Pronto.'),
      finished(8, 'p1', 'Pronto.'),
    ]);

    assert.deepEqual(types(projection.turns), [
      'user',
      'agent',
      'replies',
      'agent',
    ]);
    const [block] = repliesOf(projection.turns);
    assert.equal(block?.replies[0]?.reply.text, 'Aumentei o padding.');
    assert.equal(block?.replies[0]?.rootId, 'c-a');
    // The reader's comment stays the user turn's, never the agent's.
    const user = projection.turns[0];
    assert.equal(user?.type === 'user' ? user.comments.length : 0, 1);
  });

  test('consecutive replies are one block; a reply after other work opens another', () => {
    const projection = project([
      accepted(1, 'p1'),
      comment(2, 'p1', 'c-a', 'aumenta o botão'),
      comment(3, 'p1', 'c-b', 'muda a cor'),
      toolStarted(4, 'p1', 'call-1', 'comment_reply'),
      reply(5, 'p1', 'c-r1', 'c-a', 'Aumentei.'),
      toolFinished(6, 'p1', 'call-1', 'comment_reply'),
      toolStarted(7, 'p1', 'call-2', 'comment_reply'),
      reply(8, 'p1', 'c-r2', 'c-b', 'Mudei.'),
      toolFinished(9, 'p1', 'call-2', 'comment_reply'),
      toolStarted(10, 'p1', 'call-3', 'edit'),
      toolFinished(11, 'p1', 'call-3', 'edit'),
      toolStarted(12, 'p1', 'call-4', 'comment_reply'),
      reply(13, 'p1', 'c-r3', 'c-a', 'E mais um pouco.'),
      toolFinished(14, 'p1', 'call-4', 'comment_reply'),
      finished(15, 'p1'),
    ]);

    assert.deepEqual(types(projection.turns), [
      'user',
      'replies',
      'tool_call',
      'replies',
    ]);
    assert.deepEqual(
      repliesOf(projection.turns).map((block) =>
        block.replies.map((each) => each.reply.commentId),
      ),
      [['c-r1', 'c-r2'], ['c-r3']],
    );
  });

  test('a failed comment_reply keeps its row with the error', () => {
    const projection = project([
      accepted(1, 'p1'),
      toolStarted(2, 'p1', 'call-1', 'comment_reply'),
      toolFailed(3, 'p1', 'call-1', 'comment_reply'),
      finished(4, 'p1'),
    ]);

    const tool = projection.turns.find((turn) => turn.type === 'tool_call');
    assert.equal(
      tool?.type === 'tool_call' ? tool.name : undefined,
      'comment_reply',
    );
    assert.match(
      tool?.type === 'tool_call' ? (tool.error ?? '') : '',
      /unknown in this conversation/,
    );
  });

  test("a reply names the comment it answers: the reader's latest message in the thread", () => {
    const projection = project([
      accepted(1, 'p1'),
      comment(2, 'p1', 'c-a', 'aumenta o botão'),
      reply(3, 'p1', 'c-r1', 'c-a', 'Qual tamanho?'),
      finished(4, 'p1'),
      accepted(5, 'p2', ''),
      comment(6, 'p2', 'c-b', 'o dobro', 'c-a'),
      reply(7, 'p2', 'c-r2', 'c-a', 'Dobrei.'),
      finished(8, 'p2'),
    ]);

    const asked = repliesOf(projection.turns).map((block) =>
      block.replies.map((each) => ({
        id: each.asked?.commentId,
        pin: each.asked?.pin,
      })),
    );
    // The first reply answers the root; the second, the reader's own reply,
    // each with the pin its user turn numbered it by.
    assert.deepEqual(asked, [[{ id: 'c-a', pin: 1 }], [{ id: 'c-b', pin: 1 }]]);
    // The reader's reply is a line of its user turn, marked as a reply.
    const second = projection.turns.filter((turn) => turn.type === 'user')[1];
    assert.equal(
      second?.type === 'user' ? second.comments[0]?.inReplyTo : undefined,
      'c-a',
    );
  });
});
