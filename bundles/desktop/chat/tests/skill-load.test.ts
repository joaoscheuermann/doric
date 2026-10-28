import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  parseSkillLoad,
  skillSourceLabel,
} from '../src/client/domain/skill-load.js';

const args = (name: unknown): string => JSON.stringify({ name });

describe('the skill a load_skill call names', () => {
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

  test('an mcp/<slug>/ locator is a skill of that server, keeping its duplicate suffix', () => {
    assert.deepEqual(parseSkillLoad(args('mcp/acme/refunds~2')), {
      name: 'refunds~2',
      source: { kind: 'mcp', server: 'acme' },
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
  test('names a bundle skill built-in, a workspace skill workspace, and an MCP skill by its server', () => {
    assert.equal(skillSourceLabel({ kind: 'bundle' }), 'built-in');
    assert.equal(skillSourceLabel({ kind: 'workspace' }), 'workspace');
    assert.equal(
      skillSourceLabel({ kind: 'mcp', server: 'acme' }),
      'MCP · acme',
    );
  });
});
