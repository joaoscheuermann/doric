import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('documents failure-preserving compound shell commands', async () => {
  const body = await readFile(
    'bundles/core/skills/shell-command-execution/SKILL.md',
    'utf8',
  );

  assert.match(body, /compound command/u);

  assert.match(body, /`set -e`/u);

  assert.match(body, /`&&`/u);

  assert.match(body, /later successful step can hide an earlier failure/u);
});
