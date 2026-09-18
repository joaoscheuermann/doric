import assert from 'node:assert/strict';
import test from 'node:test';

import { eventJson } from '../src/lib/event-json.js';

test('preserves reasoning replay and tool IO while redacting credentials', () => {
  const event = {
    type: 'response.finished',
    finish: {
      reasoning: { text: 'private token-value reasoning' },
      replay: [{ type: 'reasoning', encrypted_content: 'opaque' }],
      toolCalls: [{ id: 'call-1', name: 'terminal', arguments: '{}' }],
      output: { stdout: 'token-value', exitCode: 0 },
    },
  };

  assert.deepEqual(eventJson(event, ['token-value']), {
    type: 'response.finished',
    finish: {
      reasoning: { text: 'private [REDACTED] reasoning' },
      replay: [{ type: 'reasoning', encrypted_content: 'opaque' }],
      toolCalls: [{ id: 'call-1', name: 'terminal', arguments: '{}' }],
      output: { stdout: '[REDACTED]', exitCode: 0 },
    },
  });
});

test('omits undefined object properties while marking array entries', () => {
  assert.deepEqual(eventJson({ absent: undefined, values: [undefined] }, []), {
    values: ['[Undefined]'],
  });
});

test('serializes Error fields own properties cycles and non-JSON values', () => {
  const cause = new Error('root secret');

  const error = new Error('failed secret', { cause }) as Error & {
    code: bigint;
    context: unknown;
  };

  error.code = 7n;

  error.context = { value: Number.NaN };

  const cyclic: Record<string, unknown> = { error };

  cyclic.self = cyclic;

  const serialized = eventJson(cyclic, ['secret']) as Record<string, unknown>;

  assert.equal(serialized.self, '[Circular: $]');

  const storedError = serialized.error as Record<string, unknown>;

  assert.equal(storedError.name, 'Error');

  assert.equal(storedError.message, 'failed [REDACTED]');

  assert.equal(storedError.code, '[BigInt: 7]');

  const output = JSON.stringify(serialized);

  assert.match(output, /failed \[REDACTED\]/u);

  assert.match(output, /root \[REDACTED\]/u);

  assert.match(output, /\[BigInt: 7\]/u);

  assert.match(output, /\[NaN\]/u);
});
