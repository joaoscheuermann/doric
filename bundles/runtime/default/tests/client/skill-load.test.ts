// Reading a `load_skill` call (bundle isolation 5(b), change 2): the parsing
// moved from the chat's `tests/skill-load.test.ts` and the open rule from its
// `tests/collapsible.test.ts`, now the default bundle's, with the label rule
// of U15 (OD-5): a locator `<source>/<group>/<name>` reads
// `<source> · <group>`, as written; `cwd/<x>` stays `workspace`; anything
// else is `built-in`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { blockOpen } from 'desktop/ui/collapsible-block';

import {
  LOAD_SKILL_TOOL,
  parseSkillLoad,
  skillOpenness,
  skillSourceLabel,
} from '../../src/client/skill-load.js';

const args = (name: unknown): string => JSON.stringify({ name });

describe('the skill a load_skill call names', () => {
  test('the tool is load_skill', () => {
    assert.equal(LOAD_SKILL_TOOL, 'load_skill');
  });

  test('a bare name is a bundle skill, named as written', () => {
    assert.deepEqual(parseSkillLoad(args('git-cloning')), {
      name: 'git-cloning',
      source: { kind: 'bundle' },
    });
  });

  test('a cwd/ locator is a workspace skill, named without its prefix', () => {
    assert.deepEqual(parseSkillLoad(args('cwd/behavioral-testing')), {
      name: 'behavioral-testing',
      source: { kind: 'workspace' },
    });
  });

  test('a cwd/ locator stays a workspace skill when its name has a slash', () => {
    assert.deepEqual(parseSkillLoad(args('cwd/team/review')), {
      name: 'team/review',
      source: { kind: 'workspace' },
    });
  });

  test('an mcp/<group>/ locator is a skill of that source and group, keeping its duplicate suffix', () => {
    assert.deepEqual(parseSkillLoad(args('mcp/acme/refunds~2')), {
      name: 'refunds~2',
      source: { kind: 'group', source: 'mcp', group: 'acme' },
    });
  });

  test('any <source>/<group>/<name> locator is a skill of that source and group', () => {
    assert.deepEqual(parseSkillLoad(args('docs/guides/x')), {
      name: 'x',
      source: { kind: 'group', source: 'docs', group: 'guides' },
    });
  });

  test('args that are not JSON stand for the name, as a bundle skill', () => {
    assert.deepEqual(parseSkillLoad('not json'), {
      name: 'not json',
      source: { kind: 'bundle' },
    });
  });

  test('a name that is not a string leaves the raw args as the name, as a bundle skill', () => {
    const raw = '{"name":3}';
    assert.deepEqual(parseSkillLoad(raw), {
      name: raw,
      source: { kind: 'bundle' },
    });
  });
});

describe("the header's label for where a skill comes from", () => {
  test('names a bundle skill built-in and a workspace skill workspace', () => {
    assert.equal(skillSourceLabel({ kind: 'bundle' }), 'built-in');
    assert.equal(skillSourceLabel({ kind: 'workspace' }), 'workspace');
  });

  test('names a grouped skill by its source and group, as written (U15)', () => {
    assert.equal(
      skillSourceLabel({ kind: 'group', source: 'mcp', group: 'acme' }),
      'mcp · acme',
    );
    assert.equal(
      skillSourceLabel({ kind: 'group', source: 'docs', group: 'guides' }),
      'docs · guides',
    );
  });

  test('a parsed locator reads its label through the same rule', () => {
    assert.equal(
      skillSourceLabel(parseSkillLoad(args('mcp/acme/refunds~2')).source),
      'mcp · acme',
    );
    assert.equal(
      skillSourceLabel(parseSkillLoad(args('docs/guides/x')).source),
      'docs · guides',
    );
  });
});

describe('what opens a load_skill block on its own', () => {
  test('a load_skill block is folded while it loads and once loaded, and open when the load failed', () => {
    assert.equal(blockOpen(null, skillOpenness('running')), false);
    assert.equal(blockOpen(null, skillOpenness('finished')), false);
    assert.equal(blockOpen(null, skillOpenness('failed')), true);
  });

  test("the reader's choice on a load_skill block stands over its call", () => {
    assert.equal(blockOpen(true, skillOpenness('running')), true);
    assert.equal(blockOpen(true, skillOpenness('finished')), true);
    assert.equal(blockOpen(false, skillOpenness('failed')), false);
  });
});
