// S57 D5, D28: the `papercraft` skill as a value and its read beside the
// module. `papercraftSkillOf(text)` is today's skill (name, description,
// `allowedTools ['comment_reply']`) with the text trimmed as its body;
// `readSkillBesideModule()` reads `./skills/papercraft.md` beside
// `skill.js`, the file `PAPERCRAFT_SKILL_PATH` names from the bundle root.
//
// The tests run the compiled host under `dist-tests/src/host`, beside which
// the test target copies `skills/papercraft.md`.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PAPERCRAFT_SKILL_PATH,
  papercraftSkillOf,
  readSkillBesideModule,
} from '../src/host/skill.js';

/** The bundle's folder: tests run from `dist-tests/tests`. */
const bundleRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Today's description of the skill (D28). */
const DESCRIPTION =
  'Previews repository components and exports live in the conversation: OpenUI Lang programs in papercraft fences, with the repository library, Export and pinned comments. Load it before writing a papercraft fence.';

describe('papercraftSkillOf', () => {
  test('answers the papercraft skill with the text trimmed as its body', () => {
    const skill = papercraftSkillOf('\n  # Papercraft\n\nRules.\n\n');

    assert.deepEqual(skill, {
      name: 'papercraft',
      description: DESCRIPTION,
      allowedTools: ['comment_reply'],
      body: '# Papercraft\n\nRules.',
    });
  });
});

describe('readSkillBesideModule', () => {
  test('answers the committed skill text that PAPERCRAFT_SKILL_PATH names', async () => {
    const committed = await readFile(
      join(bundleRoot, PAPERCRAFT_SKILL_PATH),
      'utf8',
    );

    assert.equal(readSkillBesideModule(), committed);
  });
});
