import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { PromptSegment, ToolSegment } from '../src/chat/projector';
import {
  activeCallId,
  isReasoning,
  lastTextIndex,
  NO_RESULT,
  prettyResult,
  RESULT_PREVIEW_LIMIT,
  resultText,
  toolStatus,
} from '../src/chat/tool-display';

const tool = (patch: Partial<ToolSegment> = {}): ToolSegment => ({
  kind: 'tool',
  callId: 'c1',
  name: 'terminal',
  args: '{}',
  status: 'running',
  ...patch,
});

describe('tool call status', () => {
  test('reports a running call as incomplete once the turn is terminal', () => {
    assert.equal(toolStatus(tool(), false), 'running');
    assert.equal(toolStatus(tool(), true), 'incomplete');
  });

  test('keeps finished and failed statuses regardless of turn state', () => {
    assert.equal(toolStatus(tool({ status: 'finished' }), true), 'finished');
    assert.equal(toolStatus(tool({ status: 'failed' }), true), 'failed');
  });
});

describe('tool result text', () => {
  test('shows a finished call output and a failed call error', () => {
    assert.equal(
      resultText(
        tool({ status: 'finished', result: 'list' }),
        'finished',
        false,
      ),
      'list',
    );
    assert.equal(
      resultText(tool({ status: 'failed', error: 'boom' }), 'failed', false),
      'boom',
    );
  });

  test('shows nothing for a call without a result yet', () => {
    assert.equal(resultText(tool(), 'running', false), '');
    assert.equal(resultText(tool(), 'incomplete', false), '');
    assert.equal(NO_RESULT, 'no result recorded');
  });

  test('pretty-prints JSON output with two spaces', () => {
    assert.equal(
      prettyResult('{"exit_code":0,"stdout":"hi"}'),
      '{\n  "exit_code": 0,\n  "stdout": "hi"\n}',
    );
  });

  test('leaves non-JSON output untouched', () => {
    assert.equal(prettyResult('/workspace'), '/workspace');
    assert.equal(prettyResult('plain text'), 'plain text');
  });

  test('clamps a long result by default and shows all on request', () => {
    const output = 'x'.repeat(RESULT_PREVIEW_LIMIT + 500);
    const segment = tool({ status: 'finished', result: output });

    const preview = resultText(segment, 'finished', false);
    assert.equal(preview.length, RESULT_PREVIEW_LIMIT);
    assert.equal(resultText(segment, 'finished', true), output);
  });
});

describe('active tool call', () => {
  test('marks the most recent running call', () => {
    const segments: readonly PromptSegment[] = [
      tool({ callId: 'a', status: 'finished' }),
      tool({ callId: 'b' }),
    ];
    assert.equal(activeCallId(segments, false), 'b');
  });

  test('marks nothing once the turn is terminal', () => {
    assert.equal(activeCallId([tool()], true), undefined);
  });

  test('marks nothing when no call is running', () => {
    assert.equal(
      activeCallId([tool({ status: 'finished' })], false),
      undefined,
    );
  });
});

describe('thinking and text segments', () => {
  test('is reasoning while a live turn trails with thinking', () => {
    const segments: readonly PromptSegment[] = [
      { kind: 'thinking', text: 'hmm' },
    ];
    assert.equal(isReasoning(segments, false), true);
    assert.equal(isReasoning(segments, true), false);
  });

  test('is not reasoning once text or a tool trails the turn', () => {
    assert.equal(isReasoning([{ kind: 'text', text: 'hi' }], false), false);
    assert.equal(isReasoning([tool()], false), false);
  });

  test('finds the last text segment', () => {
    const segments: readonly PromptSegment[] = [
      { kind: 'text', text: 'first' },
      tool(),
      { kind: 'text', text: 'second' },
    ];
    assert.equal(lastTextIndex(segments), 2);
    assert.equal(lastTextIndex([tool()]), -1);
  });
});
