// The question block's pure part (DORIC-83): the projector that turns a
// `threads.asked/v1` row into one `threads.question/v1` block, the picks the
// reader makes and the answers they become, and which live rows make an
// open block read its ask's status again.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Thread } from 'runtime/contracts';

import { noticeThreadUpdate, watchAsk } from '../src/client/ask-changes.js';
import type {
  ChatThreadEvent,
  ThreadUpdateInput,
} from '../src/client/chat-contract.js';
import {
  ASK_BLOCK,
  askProjector,
  filled,
  fromAnswers,
  OTHER,
  type Picks,
  rereadsStatus,
  summary,
  toAnswers,
} from '../src/client/domain/ask.js';
import type { AskAnswer, AskQuestion } from '../src/contracts/index.js';

const ASKED = 'threads.asked/v1';
const ANSWERED = 'threads.answered/v1';

const projectId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1800';
const threadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1801';
const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1802';
const askId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1810';
const laterAskId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1811';

const who: AskQuestion = {
  id: 'who',
  question: 'Who may call the ask tool?',
  options: [
    {
      label: 'Only the main thread',
      description: 'Subagents hand the doubt to their coordinator.',
      recommended: true,
    },
    { label: 'Any thread' },
  ],
};

const scope: AskQuestion = {
  id: 'scope',
  question: 'What goes in the first version?',
  multiSelect: true,
  options: [
    { label: 'Single choice' },
    { label: 'Multiple choice' },
    { label: 'Free answer' },
  ],
};

const wait: AskQuestion = {
  id: 'wait',
  question: 'What does the agent do until the answer arrives?',
  options: [{ label: 'Stop and wait' }, { label: 'Keep working' }],
};

const questions: readonly AskQuestion[] = [who, scope, wait];
const context = 'Three points change the design before the spec.';

/** A Thread row as the conversation receives it: `event` carries its `type`. */
const row = (
  type: string,
  payload: Record<string, unknown>,
  sequence: number,
  thread = threadId,
): ChatThreadEvent => ({
  projectId,
  threadId: thread,
  promptId,
  sequence,
  type,
  event: { type, ...payload },
  createdAt: '2026-01-01T00:00:00.000Z',
});

const asked = (id: string, sequence: number, thread = threadId) =>
  row(ASKED, { askId: id, context, questions }, sequence, thread);

const answered = (id: string, sequence: number, thread = threadId) =>
  row(
    ANSWERED,
    { askId: id, answers: [{ id: 'who', options: ['Any thread'] }] },
    sequence,
    thread,
  );

/** Every block the projector draws over `events`, from its initial state. */
const project = (events: readonly ChatThreadEvent[]) => {
  let state = askProjector.initial();
  const blocks: unknown[] = [];
  for (const event of events) {
    const next = askProjector.reduce(state, event);
    state = next.state;
    blocks.push(...next.blocks);
  }
  return blocks;
};

describe('the ask projector', () => {
  test('an asked row becomes one question block with the row and the ask', () => {
    const { blocks } = askProjector.reduce(
      askProjector.initial(),
      asked(askId, 5),
    );

    assert.deepEqual(blocks, [
      {
        id: `ask:${askId}`,
        type: 'threads.question/v1',
        promptId,
        sequence: 5,
        data: { askId, projectId, threadId, context, questions },
      },
    ]);
    assert.equal(ASK_BLOCK, 'threads.question/v1');
  });

  test('claims the asked and the answered rows, and draws nothing for an answer', () => {
    assert.ok(askProjector.eventTypes.includes(ASKED));
    assert.ok(askProjector.eventTypes.includes(ANSWERED));

    const first = askProjector.reduce(askProjector.initial(), asked(askId, 2));
    const { blocks } = askProjector.reduce(first.state, answered(askId, 3));

    assert.deepEqual(blocks, []);
  });

  test('draws an ask once, and skips a malformed row without throwing', () => {
    assert.equal(project([asked(askId, 2), asked(askId, 3)]).length, 1);

    const malformed = [
      row(ASKED, { askId: 'not-a-uuid', questions }, 2),
      row(ASKED, { askId }, 3),
      row(ASKED, { askId, questions: 'none' }, 4),
      { ...asked(askId, 5), event: null },
      { ...asked(askId, 6), event: 'threads.asked/v1' },
    ];
    for (const event of malformed) {
      const state = askProjector.initial();
      const before = [...state];
      let result: ReturnType<typeof askProjector.reduce> | undefined;
      assert.doesNotThrow(() => {
        result = askProjector.reduce(state, event);
      });
      assert.deepEqual(result?.blocks, []);
      assert.deepEqual([...(result?.state ?? [])], before);
    }

    // A malformed row does not take the askId: the well-formed one still draws.
    assert.equal(
      project([row(ASKED, { askId }, 1), asked(askId, 2)]).length,
      1,
    );
  });

  test('is pure: the same rows give the same blocks, and the given state stays as it was', () => {
    const events = [
      asked(askId, 2),
      answered(askId, 3),
      asked(laterAskId, 4),
      asked(askId, 5),
    ];
    assert.deepEqual(project(events), project(events));
    assert.equal(project(events).length, 2);

    const initial = askProjector.initial();
    const first = askProjector.reduce(initial, asked(askId, 2));
    assert.deepEqual([...initial], []);
    assert.equal(
      askProjector.reduce(initial, asked(askId, 2)).blocks.length,
      1,
      'the initial state does not hold the ask a reduce saw',
    );

    const held = [...first.state];
    askProjector.reduce(first.state, asked(laterAskId, 4));
    assert.deepEqual([...first.state], held);
    assert.equal(
      askProjector.reduce(first.state, asked(laterAskId, 4)).blocks.length,
      1,
    );
  });
});

describe('the picks', () => {
  test('a question is filled by an option, or a free answer that is not blank', () => {
    assert.equal(filled(undefined), false);
    assert.equal(filled({ picked: [] }), false);
    assert.equal(filled({ picked: ['Any thread'] }), true);
    assert.equal(filled({ picked: [OTHER], other: '  ' }), false);
    assert.equal(filled({ picked: [OTHER], other: 'x' }), true);
  });

  test('the summary names the picked labels, then the free answer', () => {
    assert.equal(summary(undefined), '—');
    assert.equal(summary({ picked: [] }), '—');
    assert.equal(summary({ picked: ['Single choice'] }), 'Single choice');
    assert.equal(
      summary({ picked: ['Single choice', 'Free answer'] }),
      'Single choice, Free answer',
    );
    assert.equal(
      summary({ picked: ['Single choice', OTHER], other: 'Ranking' }),
      'Single choice, Ranking',
    );
    assert.equal(summary({ picked: [OTHER], other: 'Ranking' }), 'Ranking');
    assert.equal(summary({ picked: [OTHER], other: '' }), '—');
  });

  test('the picks become one answer per question, in order', () => {
    const picks: Picks = {
      who: { picked: ['Only the main thread'] },
      scope: { picked: ['Single choice', 'Multiple choice'] },
      wait: { picked: [OTHER], other: 'Wait for me' },
    };
    const answers = toAnswers(questions, picks);

    assert.deepEqual(answers, [
      { id: 'who', options: ['Only the main thread'] },
      { id: 'scope', options: ['Single choice', 'Multiple choice'] },
      { id: 'wait', options: [], other: 'Wait for me' },
    ]);
    assert.equal('other' in (answers[0] as object), false);
    assert.equal('other' in (answers[1] as object), false);
  });

  test('a free answer goes only when its row is picked and not blank', () => {
    assert.deepEqual(toAnswers([who, scope, wait], {}), [
      { id: 'who', options: [] },
      { id: 'scope', options: [] },
      { id: 'wait', options: [] },
    ]);
    assert.deepEqual(
      toAnswers([who, wait], {
        // Text typed, then an option picked instead on a single-select question.
        who: { picked: ['Any thread'], other: 'Only me' },
        wait: { picked: [OTHER], other: '   ' },
      }),
      [
        { id: 'who', options: ['Any thread'] },
        { id: 'wait', options: [] },
      ],
    );
  });

  test('sent answers read back as the picks they were sent from', () => {
    const picks: Picks = {
      who: { picked: ['Any thread'] },
      scope: { picked: ['Free answer', OTHER], other: 'Ranking' },
      wait: { picked: [OTHER], other: 'Wait for me' },
    };
    const back = fromAnswers(toAnswers(questions, picks));

    for (const question of questions) {
      assert.equal(summary(back[question.id]), summary(picks[question.id]));
    }

    const sent: readonly AskAnswer[] = [
      { id: 'who', options: ['Only the main thread'] },
      { id: 'wait', options: [], other: 'Keep going' },
    ];
    const read = fromAnswers(sent);
    assert.equal(summary(read.who), 'Only the main thread');
    assert.equal(summary(read.wait), 'Keep going');
    assert.equal(read.wait?.picked.includes(OTHER), true);
    assert.equal(read.who?.picked.includes(OTHER), false);
  });
});

describe('which rows make a block read its status again', () => {
  const target = { askId, sequence: 4 };

  test('its own answer, or a later ask', () => {
    assert.equal(rereadsStatus(answered(askId, 6), target), true);
    assert.equal(rereadsStatus(answered(laterAskId, 6), target), false);
    assert.equal(rereadsStatus(asked(laterAskId, 5), target), true);
    assert.equal(rereadsStatus(asked(laterAskId, 4), target), false);
    assert.equal(rereadsStatus(asked(laterAskId, 3), target), false);
    assert.equal(rereadsStatus(row('prompt.finished', {}, 7), target), false);
  });

  test('never throws on a row it cannot read', () => {
    for (const event of [
      { ...answered(askId, 6), event: null },
      { ...answered(askId, 6), event: 'threads.answered/v1' },
      row(ANSWERED, { askId: 42 }, 6),
      { ...asked(laterAskId, 6), sequence: Number.NaN },
    ]) {
      let result: boolean | undefined;
      assert.doesNotThrow(() => {
        result = rereadsStatus(event, target);
      });
      assert.equal(result, false);
    }
  });
});

describe('the live changes of an ask', () => {
  const otherThreadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1803';

  const thread: Thread = {
    id: threadId,
    projectId,
    name: 'Main',
    state: 'ready',
    lastSequence: 6,
    cwd: '/workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const update = (
    event: ChatThreadEvent,
    thread = threadId,
  ): ThreadUpdateInput => ({
    projectId,
    threadId: thread,
    threadName: 'Main',
    update: { kind: 'event', event },
  });

  const target = (thread = threadId) => ({
    projectId,
    threadId: thread,
    askId,
    sequence: 4,
  });

  test('a row that concerns the ask calls its listener once', () => {
    let calls = 0;
    const release = watchAsk(target(), () => {
      calls += 1;
    });
    try {
      noticeThreadUpdate(update(answered(askId, 6)));
      assert.equal(calls, 1);
      noticeThreadUpdate(update(asked(laterAskId, 7)));
      assert.equal(calls, 2);
    } finally {
      release();
    }
  });

  test('an updated record, another Thread, or an unrelated row calls nothing', () => {
    let calls = 0;
    const release = watchAsk(target(), () => {
      calls += 1;
    });
    try {
      noticeThreadUpdate({
        projectId,
        threadId,
        threadName: 'Main',
        update: { kind: 'updated', thread },
      });
      noticeThreadUpdate(
        update(answered(askId, 6, otherThreadId), otherThreadId),
      );
      noticeThreadUpdate(update(answered(laterAskId, 6)));
      noticeThreadUpdate(update(asked(laterAskId, 3)));
      noticeThreadUpdate(update(row('prompt.finished', {}, 8)));
      assert.equal(calls, 0);
    } finally {
      release();
    }
  });

  test('a released listener is called no more, and releasing twice is harmless', () => {
    let calls = 0;
    const release = watchAsk(target(), () => {
      calls += 1;
    });
    release();
    assert.doesNotThrow(release);
    noticeThreadUpdate(update(answered(askId, 6)));
    assert.equal(calls, 0);
  });

  test('a throwing listener does not stop another', () => {
    let calls = 0;
    const failing = watchAsk(target(), () => {
      throw new Error('a block that failed');
    });
    const counting = watchAsk(target(), () => {
      calls += 1;
    });
    try {
      assert.doesNotThrow(() => noticeThreadUpdate(update(answered(askId, 6))));
      assert.equal(calls, 1);
    } finally {
      failing();
      counting();
    }
  });

  test('only the listeners of the updated Thread are called', () => {
    let here = 0;
    let there = 0;
    const releaseHere = watchAsk(target(), () => {
      here += 1;
    });
    const releaseThere = watchAsk(target(otherThreadId), () => {
      there += 1;
    });
    try {
      noticeThreadUpdate(
        update(answered(askId, 6, otherThreadId), otherThreadId),
      );
      assert.equal(here, 0);
      assert.equal(there, 1);
    } finally {
      releaseHere();
      releaseThere();
    }
  });
});
