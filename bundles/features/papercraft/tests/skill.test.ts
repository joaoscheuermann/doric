// PC18, PC36 (D28): the `papercraft` skill's committed text. It is at most
// 8,000 characters and its first rule names `openui`. Its registration at
// activation (order 3410, `allowedTools: ['comment_reply']`) and a refused
// registration (PC33) are tested over the router (`router-activation.test.ts`
// A1, A2) since the kernel entry left (S68c).

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

/** The committed skill text, beside the sources; tests run from `dist-tests/tests`. */
const SKILL_FILE = new URL(
  '../../src/host/skills/papercraft.md',
  import.meta.url,
);

describe('PC18: the skill text', () => {
  test('is at most 8,000 characters and its first rule names openui', async () => {
    const text = await readFile(SKILL_FILE, 'utf8');

    assert.ok(text.length <= 8_000, String(text.length));
    const firstRule = text
      .split('\n')
      .find((line) => /^\s*(?:[-*]|\d+\.)\s+/u.test(line));
    assert.ok(firstRule, 'the text has rules');
    assert.match(firstRule, /`openui`/u);
  });
});

// PC36 (D28, U51, stage 5): after the patch example of "The papercraft
// fence" and before `## Export`, the skill says word for word that a fence
// with an earlier identity is a patch and a new program is written whole;
// the text stays within PC18's 8,000 characters.
describe('PC36: the patch rule', () => {
  const paragraph =
    'A fence with the same identity as an earlier fence is a patch: the app merges it into that program. A new program, under a new identity or without one, is always written whole and starts with its root statement, `root = …`. Never send a patch, or any fragment without `root`, as a new program: the app draws nothing for it.';

  test('the paragraph follows the patch example, before Export, within 8,000 characters', async () => {
    const text = await readFile(SKILL_FILE, 'utf8');

    const at = text.indexOf(`\n${paragraph}\n`);
    assert.ok(
      at >= 0,
      'the paragraph is present, word for word, on its own line',
    );
    const patchExample = text.indexOf('A later change to its form:');
    assert.ok(patchExample >= 0, 'the patch example is present');
    const patchEnd = text.indexOf(
      '\n```\n',
      text.indexOf('```papercraft', patchExample),
    );
    assert.ok(patchEnd >= 0 && at > patchEnd, 'after the patch example');
    const exportAt = text.indexOf('\n## Export\n');
    assert.ok(exportAt >= 0 && at < exportAt, 'before ## Export');
    assert.ok(text.length <= 8_000, String(text.length));
  });
});
