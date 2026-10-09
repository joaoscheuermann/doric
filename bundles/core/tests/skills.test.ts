import assert from 'node:assert/strict';
import test from 'node:test';

import { SkillsV1, ToolsV1 } from 'bundle/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

import { boot, core, probe, reasonCodes, states } from './support/host.js';

const uses = ['tools/v1@^1.0.0', 'skills/v1@^1.0.0'];

const echo = (name: string) =>
  defineTool({
    name,
    input: z.object({}).strict(),
    output: z.string(),
    execute: () => name,
  });

interface Declared {
  readonly tools?: readonly string[];
  readonly skills?: readonly {
    readonly name: string;
    readonly allowedTools?: readonly string[];
    readonly alwaysAvailable?: boolean;
  }[];
}

const bundle = (id: string, declared: Declared) =>
  probe(id, {
    requires: uses,
    activate: ({ services }) => {
      for (const name of declared.tools ?? []) {
        services.use(ToolsV1).register(echo(name), { alwaysAvailable: true });
      }

      for (const skill of declared.skills ?? []) {
        services.use(SkillsV1).register(
          {
            name: `  ${skill.name}  `,
            description: `${skill.name} description`,
            body: `Follow ${skill.name}.`,
            allowedTools: [...(skill.allowedTools ?? [])],
          },
          skill.alwaysAvailable === undefined
            ? undefined
            : { alwaysAvailable: skill.alwaysAvailable },
        );
      }
    },
  });

void test('lists canonical skills in bundle order with their availability flag', async () => {
  const host = await boot([
    await core(),
    bundle('beta', {
      tools: ['b-tool'],
      skills: [
        { name: 'b-first', allowedTools: ['b-tool', 'b-tool'] },
        { name: 'b-second', alwaysAvailable: true },
      ],
    }),
    bundle('alpha', { skills: [{ name: 'a-only' }] }),
  ]);

  try {
    const listed = await host.platform.services.use(SkillsV1).list();

    assert.deepEqual(
      listed.map(({ bundleId, alwaysAvailable, skill }) => [
        bundleId,
        skill.name,
        alwaysAvailable,
      ]),
      [
        ['alpha', 'a-only', false],
        ['beta', 'b-first', false],
        ['beta', 'b-second', true],
      ],
    );
    // The record is SkillSchema's canonical form: trimmed, unique tools and
    // the recomputed index text.
    assert.deepEqual(listed[1]?.skill, {
      name: 'b-first',
      description: 'b-first description',
      body: 'Follow b-first.',
      allowedTools: ['b-tool'],
      indexText: 'b-first | b-first description | b-tool | Follow b-first.',
    });
  } finally {
    await host.close();
  }
});

void test('allowed-tools resolve only against tools the same bundle registered', async () => {
  const host = await boot([
    await core(),
    bundle('alpha', { tools: ['a-tool'] }),
    bundle('beta', { skills: [{ name: 'borrows', allowedTools: ['a-tool'] }] }),
  ]);

  try {
    assert.equal(states(host.platform).alpha, 'active');
    assert.equal(states(host.platform).beta, 'quarantined');
    assert.deepEqual(reasonCodes(host.platform, 'beta'), [
      'registration_failed',
    ]);
    assert.deepEqual(await host.platform.services.use(SkillsV1).list(), []);
  } finally {
    await host.close();
  }
});

void test('a duplicate skill name quarantines the second bundle; the first keeps it', async () => {
  const host = await boot([
    await core(),
    bundle('alpha', { skills: [{ name: 'shared' }] }),
    bundle('beta', { skills: [{ name: 'beta-only' }, { name: 'shared' }] }),
  ]);

  try {
    assert.equal(states(host.platform).beta, 'quarantined');
    assert.deepEqual(
      (await host.platform.services.use(SkillsV1).list()).map(
        ({ bundleId, skill }) => `${bundleId}:${skill.name}`,
      ),
      ['alpha:shared'],
    );
  } finally {
    await host.close();
  }
});
