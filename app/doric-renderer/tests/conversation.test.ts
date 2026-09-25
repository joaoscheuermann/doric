import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  agentParts,
  type ConversationTurn,
  conversationTurns,
  documentSignature,
  DRAFT_KEY,
  emptyConversationState,
  foldKey,
  partSignature,
  partsSignature,
  statusCue,
} from '../src/domain/conversation';
import type { PromptStatus, PromptTurn } from '../src/domain/projector';

const turn = (
  promptId: string,
  sequence: number,
  overrides: Partial<PromptTurn> = {},
): PromptTurn => ({
  promptId,
  sequence,
  inputRole: 'user',
  accepted: true,
  userMarkdown: `prompt ${promptId}`,
  segments: [],
  status: 'completed',
  ...overrides,
});

const text = (value: string) => ({ kind: 'text' as const, text: value });
const thinking = (value: string) => ({
  kind: 'thinking' as const,
  text: value,
});
const tool = (callId: string, overrides: Record<string, unknown> = {}) => ({
  kind: 'tool' as const,
  callId,
  name: 'write',
  args: '{"path":"a"}',
  status: 'finished' as const,
  ...overrides,
});

const keys = (turns: readonly ConversationTurn[]): readonly string[] =>
  turns.map((entry) => entry.key);

const agentOf = (turns: readonly ConversationTurn[]): ConversationTurn => {
  const agent = turns.find((entry) => entry.role === 'agent');
  assert.ok(agent !== undefined, 'expected an agent turn');
  return agent;
};

const comment = (id: string, body: string) => ({
  id,
  quote: `quote ${id}`,
  body,
});

const carryComment = (quote: string, body: string): string =>
  [
    '# User comments',
    `1. "${quote}": ${body}`,
    '',
    '# User request',
    'next',
  ].join('\n');

describe('the turns a log renders', () => {
  test('pairs each accepted prompt with its answer, and ends with the composer', () => {
    const turns = conversationTurns(
      [turn('a', 1), turn('b', 2)],
      emptyConversationState,
    );
    assert.deepEqual(keys(turns), [
      'user:a',
      'agent:a',
      'user:b',
      'agent:b',
      DRAFT_KEY,
    ]);
    assert.equal(turns.at(-1)?.draft, true);
  });

  test('only the composer may be written in', () => {
    const turns = conversationTurns([turn('a', 1)], emptyConversationState);
    assert.deepEqual(
      turns.map((entry) => [entry.key, entry.writable]),
      [
        ['user:a', false],
        ['agent:a', false],
        [DRAFT_KEY, true],
      ],
    );
  });

  test('leaves out a prompt the log never accepted', () => {
    const turns = conversationTurns(
      [turn('a', 1, { accepted: false }), turn('b', 2)],
      emptyConversationState,
    );
    assert.deepEqual(keys(turns), ['user:b', 'agent:b', DRAFT_KEY]);
  });

  test('names the Thread that wrote a delegated input, never the person', () => {
    const turns = conversationTurns(
      [
        turn('a', 1, {
          inputRole: 'agent',
          userMarkdown: '',
          delegated: {
            kind: 'parent',
            threadId: 'abcdefgh1234',
            text: 'do it',
          },
        }),
        turn('b', 2, {
          inputRole: 'agent',
          userMarkdown: '',
          delegated: {
            kind: 'result',
            threadId: 'abcdefgh1234',
            status: 'completed',
            text: 'done',
          },
        }),
      ],
      emptyConversationState,
    );
    const [first, , second] = turns;
    assert.equal(first?.markdown, 'do it');
    assert.equal(first?.label, 'Input from thread abcdefgh');
    assert.equal(second?.markdown, 'done');
    assert.equal(second?.label, 'Result from thread abcdefgh · completed');
  });

  test('carries the agent segments untouched, so the document can render them', () => {
    const turns = conversationTurns(
      [turn('a', 1, { segments: [thinking('why'), text('answer')] })],
      emptyConversationState,
    );
    assert.deepEqual(agentOf(turns).segments, [
      thinking('why'),
      text('answer'),
    ]);
    assert.deepEqual(turns[0]?.segments, []);
  });
});

describe('what the person is doing decides what they can write and what a resubmit drops', () => {
  test('lets only the composer be written in until an edit names a turn', () => {
    const log = [turn('a', 1), turn('b', 2)];
    assert.deepEqual(
      conversationTurns(log, emptyConversationState).map((entry) => [
        entry.key,
        entry.writable,
      ]),
      [
        ['user:a', false],
        ['agent:a', false],
        ['user:b', false],
        ['agent:b', false],
        [DRAFT_KEY, true],
      ],
    );
    assert.deepEqual(
      conversationTurns(log, {
        ...emptyConversationState,
        editing: 'b',
      }).map((entry) => [entry.key, entry.writable]),
      [
        ['user:a', false],
        ['agent:a', false],
        ['user:b', true],
        ['agent:b', false],
        [DRAFT_KEY, true],
      ],
    );
  });

  test('dims exactly the turns a resubmit would discard, and the composer', () => {
    const log = [turn('a', 1), turn('b', 2)];
    assert.deepEqual(
      conversationTurns(log, emptyConversationState).map(
        (entry) => entry.dimmed,
      ),
      [false, false, false, false, false],
    );
    assert.deepEqual(
      conversationTurns(log, { ...emptyConversationState, editing: 'a' }).map(
        (entry) => [entry.key, entry.dimmed],
      ),
      [
        ['user:a', false],
        ['agent:a', true],
        ['user:b', true],
        ['agent:b', true],
        [DRAFT_KEY, true],
      ],
    );
  });
});

describe('the comments a prompt carries', () => {
  test('renders the request alone, with the comments its markdown carried as cards', () => {
    const composed = [
      '# User comments',
      '1. "atirei o pau no gato": batata doce e frango, birl!',
      '',
      '# User request',
      'Explique o diff.',
    ].join('\n');
    const [user] = conversationTurns(
      [turn('a', 1, { userMarkdown: composed })],
      emptyConversationState,
    );
    assert.equal(user?.markdown, 'Explique o diff.');
    assert.deepEqual(user?.comments, [
      {
        id: 'parsed:1',
        quote: 'atirei o pau no gato',
        body: 'batata doce e frango, birl!',
      },
    ]);
  });

  test('names an answer with the comments that travel on the prompt after it', () => {
    const turns = conversationTurns(
      [
        turn('a', 1),
        turn('b', 2, { userMarkdown: carryComment('q', 'about b') }),
      ],
      {
        ...emptyConversationState,
        comments: [comment('pending', 'follow-up')],
      },
    );
    const agents = turns.filter((entry) => entry.role === 'agent');
    assert.deepEqual(agents[0]?.marks, [
      { id: 'parsed:1', quote: 'q', body: 'about b' },
    ]);
    assert.deepEqual(agents[1]?.marks, [comment('pending', 'follow-up')]);
  });

  test('gives the last answer the comments not yet sent, which the composer holds', () => {
    const turns = conversationTurns([turn('a', 1)], {
      ...emptyConversationState,
      comments: [comment('pending', 'follow-up')],
    });
    assert.deepEqual(agentOf(turns).marks, [comment('pending', 'follow-up')]);
    assert.deepEqual(turns.at(-1)?.comments, [comment('pending', 'follow-up')]);
  });
});

describe('the parts of an agent turn', () => {
  test('keeps one part per run, in order, named by its place in the log', () => {
    const [agent] = conversationTurns(
      [
        turn('a', 1, {
          segments: [text('one'), thinking('why'), tool('call-1'), text('two')],
        }),
      ],
      emptyConversationState,
    ).filter((entry) => entry.role === 'agent');

    assert.deepEqual(
      agentParts(agent!, emptyConversationState.open).map((part) => [
        part.kind,
        part.key,
      ]),
      [
        ['text', 'seg:0'],
        ['thinking', 'seg:1'],
        ['tool', 'seg:2'],
        ['text', 'seg:3'],
      ],
    );
  });

  test('leaves out a run that holds nothing, so no empty block is rendered', () => {
    const [agent] = conversationTurns(
      [turn('a', 1, { segments: [text(''), thinking('why')] })],
      emptyConversationState,
    ).filter((entry) => entry.role === 'agent');
    assert.deepEqual(
      agentParts(agent!, emptyConversationState.open).map((part) => part.key),
      ['seg:1'],
    );
  });

  test('gives a turn the log says nothing about one line to rest the caret in', () => {
    const [agent] = conversationTurns(
      [turn('a', 1)],
      emptyConversationState,
    ).filter((entry) => entry.role === 'agent');
    assert.deepEqual(agentParts(agent!, emptyConversationState.open), [
      { kind: 'text', key: 'empty', markdown: '' },
    ]);
  });

  test('shows a call as markdown it cannot escape from', () => {
    const [agent] = conversationTurns(
      [turn('a', 1, { segments: [tool('call-1', { result: 'ok' })] })],
      emptyConversationState,
    ).filter((entry) => entry.role === 'agent');
    const part = agentParts(agent!, emptyConversationState.open)[0];
    assert.ok(part?.kind === 'tool');
    assert.match(
      part.markdown,
      /^```json\n\{"path":"a"\}\n```\n\n```\nok\n```$/,
    );
  });

  test("says a call failed in the call's own words", () => {
    const [agent] = conversationTurns(
      [
        turn('a', 1, {
          segments: [
            tool('call-1', { status: 'failed', error: 'no such file' }),
          ],
        }),
      ],
      emptyConversationState,
    ).filter((entry) => entry.role === 'agent');
    const part = agentParts(agent!, emptyConversationState.open)[0];
    assert.ok(part?.kind === 'tool');
    assert.match(part.markdown, /> no such file$/);
  });

  test('tells two parts apart by everything they render', () => {
    const [agent] = conversationTurns(
      [turn('a', 1, { segments: [text('one')] })],
      emptyConversationState,
    ).filter((entry) => entry.role === 'agent');
    const [growing] = agentParts(agent!, emptyConversationState.open);
    const [grown] = agentParts(
      { ...agent!, segments: [text('one more')] },
      emptyConversationState.open,
    );
    assert.notEqual(partSignature(growing!), partSignature(grown!));
    assert.equal(
      partSignature(growing!),
      partSignature(agentParts(agent!, emptyConversationState.open)[0]!),
    );
  });
});

describe('folding reasoning and tool calls', () => {
  test('keeps a closed reasoning part whole, and opens it by its fold key', () => {
    const [agent] = conversationTurns(
      [turn('a', 1, { segments: [thinking('why')] })],
      emptyConversationState,
    ).filter((entry) => entry.role === 'agent');
    assert.deepEqual(agentParts(agent!, emptyConversationState.open)[0], {
      kind: 'thinking',
      key: 'seg:0',
      markdown: 'why',
      open: false,
    });
    const open = new Set([foldKey(agent!.key, 'seg:0')]);
    assert.deepEqual(agentParts(agent!, open)[0], {
      kind: 'thinking',
      key: 'seg:0',
      markdown: 'why',
      open: true,
    });
  });

  test('folds a tool call the same way, keeping its payload while closed', () => {
    const [agent] = conversationTurns(
      [turn('a', 1, { segments: [tool('call-1', { result: 'ok' })] })],
      emptyConversationState,
    ).filter((entry) => entry.role === 'agent');
    const closed = agentParts(agent!, emptyConversationState.open)[0];
    assert.ok(closed?.kind === 'tool');
    assert.equal(closed.open, false);
    assert.match(
      closed.markdown,
      /^```json\n\{"path":"a"\}\n```\n\n```\nok\n```$/,
    );
    const open = new Set([foldKey(agent!.key, 'seg:0')]);
    const opened = agentParts(agent!, open)[0];
    assert.ok(opened?.kind === 'tool');
    assert.equal(opened.open, true);
  });

  test('leaves a text part outside every fold', () => {
    const [agent] = conversationTurns(
      [turn('a', 1, { segments: [text('answer')] })],
      emptyConversationState,
    ).filter((entry) => entry.role === 'agent');
    assert.deepEqual(agentParts(agent!, emptyConversationState.open)[0], {
      kind: 'text',
      key: 'seg:0',
      markdown: 'answer',
    });
  });
});

describe('which comments an answer is still writing', () => {
  const held = (id: string, body: string) => ({ body, id, quote: 'say it' });
  const carried = (promptId: string, text: string) =>
    turn(promptId, 1, { userMarkdown: text });
  const composed = (body: string) =>
    `# User comments\n1. "say it": ${body}\n\n# User request\nask`;

  test('gives fields to the last answer only, from the comments not yet sent', () => {
    const turns = conversationTurns([carried('a', 'ask')], {
      ...emptyConversationState,
      comments: [held('c1', 'mine')],
    });
    assert.deepEqual(agentOf(turns).fields, [held('c1', 'mine')]);
  });

  test('gives no fields to an answer whose comments already travelled', () => {
    const turns = conversationTurns(
      [carried('a', 'ask'), carried('b', composed('sent'))],
      emptyConversationState,
    );
    assert.deepEqual(agentOf(turns).marks, [held('parsed:1', 'sent')]);
    assert.deepEqual(agentOf(turns).fields, []);
  });

  test('gives fields only to the answer the edit is about, not to every answer numbered the same', () => {
    // Three prompts whose parsed comments are all numbered from one, so three
    // answers carry a `parsed:1`. Editing the second prompt brings its comment
    // back as a field on the answer before it — and on no other answer.
    const turns = conversationTurns(
      [
        carried('a', 'ask'),
        carried('b', composed('second')),
        carried('c', composed('third')),
      ],
      {
        ...emptyConversationState,
        editing: 'b',
        editComments: [held('parsed:1', 'second')],
      },
    );
    const [, first, , second, , third] = turns;
    assert.deepEqual(first?.fields, [held('parsed:1', 'second')]);
    assert.deepEqual(second?.fields, []);
    assert.deepEqual(third?.fields, []);
    // Every answer still shows the mark of the comment that names it.
    assert.deepEqual(second?.marks, [held('parsed:1', 'third')]);
  });
});

describe("the shape of a turn's parts", () => {
  test('names each part in order, so a part that lost its place is visible', () => {
    const turns = conversationTurns(
      [turn('a', 1, { segments: [thinking('why'), tool('call-1')] })],
      emptyConversationState,
    );
    assert.equal(
      partsSignature(agentOf(turns), new Set()),
      'thinking:seg:0\u0000tool:seg:1',
    );
  });

  test('keeps a closed fold in the shape, because its head is still a control', () => {
    const turns = conversationTurns(
      [turn('a', 1, { segments: [thinking('why')] })],
      emptyConversationState,
    );
    const agent = agentOf(turns);
    assert.equal(partsSignature(agent, new Set()), 'thinking:seg:0');
    assert.equal(
      partsSignature(agent, new Set(['agent:a:seg:0'])),
      'thinking:seg:0',
    );
  });
});

describe('the shape of the document', () => {
  test('names every block in order, so a mutation that lost one is visible', () => {
    const turns = conversationTurns([turn('a', 1)], emptyConversationState);
    const signature = documentSignature(turns);
    assert.equal(
      signature,
      'user:user:a:log\u0000agent:agent:a:log\u0000user:draft:draft',
    );
    assert.notEqual(
      signature,
      documentSignature(conversationTurns([], emptyConversationState)),
    );
  });
});

describe('how a turn reads beside its avatar', () => {
  test("reports a state for an agent turn, and never for a person's own prompt", () => {
    const [user, agent] = conversationTurns(
      [turn('a', 1, { status: 'streaming' })],
      emptyConversationState,
    );
    assert.deepEqual(statusCue(agent!.role, agent!.status), {
      label: 'Working',
      tone: 'active',
    });
    assert.equal(statusCue(user!.role, user!.status), undefined);
  });

  test('says nothing about a turn that finished, failed or was cancelled in words a state can read', () => {
    const statuses: readonly PromptStatus[] = [
      'completed',
      'queued',
      'streaming',
      'failed',
      'cancelled',
    ];
    assert.deepEqual(
      statuses.map((status) => statusCue('agent', status)?.tone ?? 'quiet'),
      ['quiet', 'idle', 'active', 'failed', 'idle'],
    );
  });
});
