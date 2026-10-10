import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import {
  discoverSkills,
  parseSkillDocument,
  SkillSchema,
} from '../src/index.js';
import { skillSource, withRoot, writeBundle } from './support/fixtures.js';

void test('exports a JSON-Schema-compatible skill schema', () => {
  const value = {
    name: 'example',
    description: 'Example skill.',
    body: 'Follow the procedure.',
    allowedTools: ['read'],
  };

  assert.deepEqual(SkillSchema.parse(value), {
    ...value,
    indexText: 'example | Example skill. | read | Follow the procedure.',
  });
  assert.deepEqual(z.toJSONSchema(SkillSchema, { io: 'input' }).required, [
    'name',
    'description',
    'body',
    'allowedTools',
  ]);
});

void test('normalizes canonical skill records and ignores supplied index text', () => {
  assert.deepEqual(
    SkillSchema.parse({
      name: '  example  ',
      description: '  Example skill.  ',
      body: '  Follow the procedure.  ',
      allowedTools: [' read ', 'write', 'read'],
      indexText: 'untrusted',
    }),
    {
      name: 'example',
      description: 'Example skill.',
      body: 'Follow the procedure.',
      allowedTools: ['read', 'write'],
      indexText:
        'example | Example skill. | read,write | Follow the procedure.',
    },
  );

  assert.throws(() =>
    SkillSchema.parse({
      name: 'example',
      description: 'Example skill.',
      body: 'Follow the procedure.',
      allowedTools: [],
      extra: true,
    }),
  );
});

void test('parses frontmatter, trims values and defaults allowed-tools to empty', () => {
  const { skill } = parseSkillDocument(
    `---
name: "  example  "
description: "  Example description  "
---

  Follow this procedure.${'  '}
`,
    'skill',
  );

  assert.deepEqual(SkillSchema.parse(skill), {
    name: 'example',
    description: 'Example description',
    body: 'Follow this procedure.',
    allowedTools: [],
    indexText: 'example | Example description |  | Follow this procedure.',
  });

  assert.deepEqual(
    parseSkillDocument(
      skillSource('spaced', { allowedTools: [] }).replace('[]', 'read write'),
      'skill',
    ).skill.allowedTools,
    ['read', 'write'],
  );
});

void test('rejects documents without frontmatter or with unknown keys', () => {
  assert.throws(
    () => parseSkillDocument('# no frontmatter', 'skill "x"'),
    /frontmatter/,
  );
  assert.throws(
    () =>
      parseSkillDocument(
        `---\nname: x\ndescription: y\nextra: true\n---\n\nbody\n`,
        'skill "x"',
      ),
    /Invalid skill "x"/,
  );
});

void test('accepts alwaysAvailable in frontmatter only for v1 bundles', () => {
  const source = skillSource('flagged', { alwaysAvailable: true });

  assert.equal(
    parseSkillDocument(source, 'skill', { frontmatterAvailability: true })
      .alwaysAvailable,
    true,
  );
  assert.throws(() => parseSkillDocument(source, 'skill'));
});

void test('accepts a positive integer order in frontmatter only for v1 bundles, outside the skill record', () => {
  const v1 = { frontmatterAvailability: true };
  const parsed = parseSkillDocument(
    skillSource('ordered', { order: 1200 }),
    'skill',
    v1,
  );

  assert.equal(parsed.order, 1200);
  assert.deepEqual(
    SkillSchema.parse(parsed.skill),
    SkillSchema.parse(
      parseSkillDocument(skillSource('ordered'), 'skill', v1).skill,
    ),
  );
  assert.equal(
    parseSkillDocument(skillSource('plain'), 'skill', v1).order,
    undefined,
  );
  assert.throws(() =>
    parseSkillDocument(skillSource('ordered', { order: 1200 }), 'skill'),
  );

  for (const order of [0, -1, 1.5]) {
    assert.throws(
      () => parseSkillDocument(skillSource('bad', { order }), 'skill', v1),
      /Invalid skill/,
    );
  }
});

void test('discovers skills in lexical directory order, skipping folders without SKILL.md', async () => {
  await withRoot(async (root) => {
    const dir = await writeBundle(root, 'b', {
      manifest: {},
      files: {
        'skills/10-last/SKILL.md': skillSource('last'),
        'skills/02-middle/SKILL.md': skillSource('middle'),
        'skills/01-first/SKILL.md': skillSource('first'),
        'skills/assets/notes.md': 'x',
      },
    });

    assert.deepEqual(await discoverSkills(dir), [
      'skills/01-first/SKILL.md',
      'skills/02-middle/SKILL.md',
      'skills/10-last/SKILL.md',
    ]);
    assert.deepEqual(await discoverSkills(`${root}/missing`), []);
  });
});
