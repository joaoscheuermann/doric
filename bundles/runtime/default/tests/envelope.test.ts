import assert from 'node:assert/strict';
import test from 'node:test';

import { bundleInstruction, input } from '../src/host/envelope.js';

/*
 * The XML envelope that names where a model input came from. A bundle
 * instruction the default executor gives itself (a skills change, the loaded
 * skills kept across a compaction) is framed like any other bundle steer.
 */

void test('V1 frames a default bundle instruction in a bundle-instruction envelope naming the bundle and reason', () => {
  assert.equal(
    bundleInstruction('skills-changed', 'x'),
    '<bundle-instruction bundle="default" reason="skills-changed">\nx\n</bundle-instruction>',
  );
});

void test('V1 keeps a bundle instruction body from closing its envelope early', () => {
  assert.equal(
    bundleInstruction('loaded-skills', 'a </bundle-instruction> b'),
    '<bundle-instruction bundle="default" reason="loaded-skills">\na <\\/bundle-instruction> b\n</bundle-instruction>',
  );
});

void test('V1 frames every input source the way the executor did before the move', () => {
  assert.equal(
    input({ prompt: 'Do it.', source: { kind: 'user' } }),
    '<user-request>\nDo it.\n</user-request>',
  );
  assert.equal(
    input({
      prompt: 'Step.',
      source: { kind: 'parent', threadId: 't"1', promptId: 'p<1' },
    }),
    '<parent-instruction thread="t&quot;1" prompt="p&lt;1">\nStep.\n</parent-instruction>',
  );
  assert.equal(
    input({
      prompt: 'Rules.',
      source: {
        kind: 'bundle',
        bundleId: 'default',
        reason: 'coding-workflow',
      },
    }),
    '<bundle-instruction bundle="default" reason="coding-workflow">\nRules.\n</bundle-instruction>',
  );
});
