import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  delegatedInput,
  envelopeStatus,
  shortId,
  threadLabel,
  withoutEnvelope,
} from '../src/domain/delegated';

/** The envelope the host writes for a child result, taken from a real Thread. */
const envelope = [
  '# Delegated task result',
  '',
  'Child thread: 2a9ba487-632d-4397-abd9-3987354aefd1',
  'Child prompt: 92f6930f-2f1a-4e52-8215-395ab1246193',
  'Originating prompt: 4ac62e86-27dd-4ffe-88f9-f53922ccadf4',
  'Status: completed',
  '',
  '## Result',
  '',
  '## Resultado',
  '',
  'El workspace del sandbox está completamente vacío.',
].join('\n');

const childText = '## Resultado\n\nEl workspace está vacío.';

describe('delegated input', () => {
  test('shows the child words and the status from the host envelope', () => {
    assert.equal(
      withoutEnvelope(envelope),
      `## Resultado\n\n${'El workspace del sandbox está completamente vacío.'}`,
    );
    assert.equal(envelopeStatus(envelope), 'completed');
  });

  test('leaves text untouched when the envelope header is absent', () => {
    assert.equal(withoutEnvelope(childText), childText);
    assert.equal(envelopeStatus(childText), undefined);
  });

  test('reads a result source as a delegated result', () => {
    const delegated = delegatedInput(
      { kind: 'result', threadId: '2a9ba487-632d-4397-abd9-3987354aefd1' },
      envelope,
    );

    assert.deepEqual(delegated, {
      kind: 'result',
      threadId: '2a9ba487-632d-4397-abd9-3987354aefd1',
      status: 'completed',
      text: '## Resultado\n\nEl workspace del sandbox está completamente vacío.',
    });
  });

  test('reads a parent instruction as plain text with no status', () => {
    assert.deepEqual(
      delegatedInput({ kind: 'parent', threadId: '4ac62e86-1' }, childText),
      { kind: 'parent', threadId: '4ac62e86-1', text: childText },
    );
  });

  test('treats the human prompt and malformed sources as not delegated', () => {
    assert.equal(delegatedInput({ kind: 'user' }, 'hi'), undefined);
    assert.equal(delegatedInput({ kind: 'result' }, envelope), undefined);
    assert.equal(delegatedInput(undefined, envelope), undefined);
  });

  test('refers to a Thread with a short id', () => {
    assert.equal(shortId('2a9ba487-632d-4397-abd9-3987354aefd1'), '2a9ba487');
  });

  test('names the writing Thread and falls back to its short id', () => {
    const id = '2a9ba487-632d-4397-abd9-3987354aefd1';

    assert.deepEqual(threadLabel(id, 'Liste todos os arquivos'), {
      value: 'Liste todos os arquivos',
      mono: false,
    });
    assert.deepEqual(threadLabel(id, undefined), {
      value: '2a9ba487',
      mono: true,
    });
    assert.deepEqual(threadLabel(id, '   '), { value: '2a9ba487', mono: true });
  });
});
