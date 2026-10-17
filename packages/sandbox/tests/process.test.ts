import assert from 'node:assert/strict';
import test from 'node:test';

import { captureProcessOutput } from '../src/index.js';

void test('preserves characters split across transport chunks and keeps output bounded', () => {
  const output: string[] = [];
  const capture = captureProcessOutput({
    cmd: ['test'],
    onOutput: ({ data }) => output.push(data),
  });
  const bytes = Buffer.from('olá');
  capture.append('stdout', bytes.subarray(0, 3));
  capture.append('stdout', bytes.subarray(3));
  assert.equal(output.join(''), 'olá');
  capture.append('stderr', Buffer.alloc(2_000_000, 120));
  const result = capture.finish(7);
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, 'olá');
  assert.equal(result.stderrBytes.length, 1_048_576);
  assert.match(result.stderr, /^\[earlier output truncated\]/u);
});
