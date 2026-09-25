import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  agentParts,
  type ConversationTurn,
  conversationTurns,
  documentSignature,
  DRAFT_KEY,
  partSignature,
  statusCue,
} from '../src/domain/conversation';
import { fenced } from '../src/domain/markdown';
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

describe('the turns a log renders', () => {
  test('pairs each accepted prompt with its answer, and ends with the composer', () => {
    const turns = conversationTurns([turn('a', 1), turn('b', 2)]);
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
    const turns = conversationTurns([turn('a', 1)]);
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
    const turns = conversationTurns([
      turn('a', 1, { accepted: false }),
      turn('b', 2),
    ]);
    assert.deepEqual(keys(turns), ['user:b', 'agent:b', DRAFT_KEY]);
  });

  test('names the Thread that wrote a delegated input, never the person', () => {
    const turns = conversationTurns([
      turn('a', 1, {
        inputRole: 'agent',
        userMarkdown: '',
        delegated: { kind: 'parent', threadId: 'abcdefgh1234', text: 'do it' },
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
    ]);
    const [first, , second] = turns;
    assert.equal(first?.markdown, 'do it');
    assert.equal(first?.label, 'Input from thread abcdefgh');
    assert.equal(second?.markdown, 'done');
    assert.equal(second?.label, 'Result from thread abcdefgh · completed');
  });

  test('carries the agent segments untouched, so the document can render them', () => {
    const turns = conversationTurns([
      turn('a', 1, { segments: [thinking('why'), text('answer')] }),
    ]);
    assert.deepEqual(agentOf(turns).segments, [
      thinking('why'),
      text('answer'),
    ]);
    assert.deepEqual(turns[0]?.segments, []);
  });
});

describe('the parts of an agent turn', () => {
  test('keeps one part per run, in order, named by its place in the log', () => {
    const [agent] = conversationTurns([
      turn('a', 1, {
        segments: [text('one'), thinking('why'), tool('call-1'), text('two')],
      }),
    ]).filter((entry) => entry.role === 'agent');

    assert.deepEqual(
      agentParts(agent!).map((part) => [part.kind, part.key]),
      [
        ['text', 'seg:0'],
        ['thinking', 'seg:1'],
        ['tool', 'seg:2'],
        ['text', 'seg:3'],
      ],
    );
  });

  test('leaves out a run that holds nothing, so no empty block is rendered', () => {
    const [agent] = conversationTurns([
      turn('a', 1, { segments: [text(''), thinking('why')] }),
    ]).filter((entry) => entry.role === 'agent');
    assert.deepEqual(
      agentParts(agent!).map((part) => part.key),
      ['seg:1'],
    );
  });

  test('gives a turn the log says nothing about one line to rest the caret in', () => {
    const [agent] = conversationTurns([turn('a', 1)]).filter(
      (entry) => entry.role === 'agent',
    );
    assert.deepEqual(agentParts(agent!), [
      { kind: 'text', key: 'empty', markdown: '' },
    ]);
  });

  test('shows a call as markdown it cannot escape from', () => {
    const [agent] = conversationTurns([
      turn('a', 1, { segments: [tool('call-1', { result: 'ok' })] }),
    ]).filter((entry) => entry.role === 'agent');
    const part = agentParts(agent!)[0];
    assert.ok(part?.kind === 'tool');
    assert.match(
      part.markdown,
      /^```json\n\{"path":"a"}\n```\n\n```\nok\n```$/,
    );
  });

  test("says a call failed in the call's own words", () => {
    const [agent] = conversationTurns([
      turn('a', 1, {
        segments: [tool('call-1', { status: 'failed', error: 'no such file' })],
      }),
    ]).filter((entry) => entry.role === 'agent');
    const part = agentParts(agent!)[0];
    assert.ok(part?.kind === 'tool');
    assert.match(part.markdown, /> no such file$/);
  });

  test('tells two parts apart by everything they render', () => {
    const [agent] = conversationTurns([
      turn('a', 1, { segments: [text('one')] }),
    ]).filter((entry) => entry.role === 'agent');
    const [growing] = agentParts(agent!);
    const [grown] = agentParts({ ...agent!, segments: [text('one more')] });
    assert.notEqual(partSignature(growing!), partSignature(grown!));
    assert.equal(
      partSignature(growing!),
      partSignature(agentParts(agent!)[0]!),
    );
  });
});

describe('the shape of the document', () => {
  test('names every block in order, so a mutation that lost one is visible', () => {
    const turns = conversationTurns([turn('a', 1)]);
    const signature = documentSignature(turns);
    assert.equal(
      signature,
      'user:user:a:log\u0000agent:agent:a:log\u0000user:draft:draft',
    );
    assert.notEqual(signature, documentSignature(conversationTurns([])));
  });
});

describe('how a turn reads beside its avatar', () => {
  test("reports a state for an agent turn, and never for a person's own prompt", () => {
    const [user, agent] = conversationTurns([
      turn('a', 1, { status: 'streaming' }),
    ]);
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

describe('markdown that will not be escaped by its own value', () => {
  test('fences a value in three backticks, and names its language', () => {
    assert.equal(fenced('{}', 'json'), '```json\n{}\n```');
  });

  test('uses a longer fence than any the value itself holds', () => {
    assert.equal(fenced('a ``` b'), '````\na ``` b\n````');
  });

  test('keeps a value that holds nothing readable', () => {
    assert.equal(fenced(''), '```\n\n```');
  });
});
