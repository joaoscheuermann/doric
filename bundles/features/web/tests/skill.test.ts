// The `web-research` skill `web` ships (moved from the kernel entry's
// `activate.test.ts` in S68a; the skill is not the kernel's).

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('ships the web-research skill at position 1200, allowing only the web tool', async () => {
  const body = await readFile(
    'bundles/features/web/src/skills/web-research/SKILL.md',
    'utf8',
  );
  const frontmatter = body.split('---')[1] ?? '';

  assert.match(frontmatter, /^name: web-research$/mu);

  assert.match(frontmatter, /^allowed-tools:\n {2}- web$/mu);

  assert.match(frontmatter, /^order: 1200$/mu);
});
