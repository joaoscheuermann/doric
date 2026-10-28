import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestServices } from 'bundle/testing';

import {
  frontmatterSummary,
  readRunSkills,
  skillBody,
} from '../src/host/skills/sources.js';
import {
  type FakeLease,
  type FakeMcp,
  type HarnessSkill,
  leaseService,
  mcpServer,
  mcpService,
  projectId,
  promptId,
  type RecordedCall,
  skill,
  skillsService,
  threadId,
} from './support/harness.js';

/*
 * Where the skills of one prompt run come from: `skills/v1` (bundle skills,
 * split by `alwaysAvailable`), the `.agents/skills/*\/SKILL.md` files of the
 * Thread's working directory, read with one `runtime.lease/v1` exec, and the
 * skills the Project's connected MCP servers list. Only the bundle source can
 * fail the read; the other two answer no skill instead.
 */

const scope = { projectId, threadId, promptId };

/** `readRunSkills` over the given fake providers; absent ones are unprovided. */
const read = async (
  cwd: string,
  {
    skills = [],
    lease,
    mcp,
  }: {
    readonly skills?: readonly HarnessSkill[];
    readonly lease?: FakeLease;
    readonly mcp?: FakeMcp;
  },
) => {
  const calls = { lease: [] as RecordedCall[], mcp: [] as RecordedCall[] };
  const services = createTestServices({
    bundle: { id: 'default' },
    provide: [
      skillsService(skills),
      ...(lease === undefined ? [] : [leaseService(lease, calls.lease)]),
      ...(mcp === undefined ? [] : [mcpService(mcp, calls.mcp)]),
    ],
  });
  const result = await readRunSkills(
    cwd,
    services.call(scope),
    services.services,
  );
  return { result, calls };
};

/** One record of the workspace scan: the directory name, then its SKILL.md head. */
const record = (directory: string, head: string) => `${directory}\0${head}\0`;

const scanning = (stdout: string, exitCode: number | null = 0): FakeLease => ({
  exec: () => ({ exitCode, stdout, stderr: '' }),
});

void test('W1 reads a plain, quoted, folded or literal description from the frontmatter, ignoring the other keys', () => {
  assert.equal(
    frontmatterSummary(
      '---\nname: plain\ndescription: Does one thing.\nlicense: MIT\n---\nBody.',
    ),
    'Does one thing.',
  );
  assert.equal(
    frontmatterSummary(
      '---\ndescription: Starts here\n  and goes on\n  to the end.\nname: x\n---\n',
    ),
    'Starts here and goes on to the end.',
  );
  assert.equal(
    frontmatterSummary("---\ndescription: 'It''s quoted.'\n---\n"),
    "It's quoted.",
  );
  assert.equal(
    frontmatterSummary('---\ndescription: "Say \\"hi\\" to C:\\\\x."\n---\n'),
    'Say "hi" to C:\\x.',
  );
  assert.equal(
    frontmatterSummary(
      '---\ndescription: >\n  Folded one\n  folded two.\nname: x\n---\n',
    ),
    'Folded one folded two.',
  );
  assert.equal(
    frontmatterSummary('---\ndescription: |\n  Line one.\n  Line two.\n---\n'),
    'Line one.\nLine two.',
  );
  assert.equal(
    frontmatterSummary(
      [
        '---',
        'name: extra',
        'license: Apache-2.0',
        'metadata:',
        '  description: Not the skill description.',
        'allowed-tools: Bash Read',
        'description: The top-level one.',
        '---',
        'Body.',
      ].join('\n'),
    ),
    'The top-level one.',
  );
  assert.equal(
    frontmatterSummary('---\ndescription: Open ended'),
    'Open ended',
  );
  assert.equal(frontmatterSummary('---\nname: none\n---\nBody.'), undefined);
  assert.equal(frontmatterSummary('---\ndescription: "  "\n---\n'), undefined);
  assert.equal(frontmatterSummary('# No frontmatter\n\nBody.'), undefined);
});

void test('W1 skips a workspace skill whose SKILL.md has no description', async () => {
  const { result } = await read('/repo', {
    lease: scanning(
      [
        record('described', '---\ndescription: Described.\n---\nBody.'),
        record('bare', '---\nname: bare\n---\nBody.'),
        record('plain', '# Plain\n\nNo frontmatter.'),
      ].join(''),
    ),
  });

  assert.deepEqual(
    result.workspace.map(({ name }) => name),
    ['described'],
  );
});

void test('W2 answers no workspace skill when the scan rejects, exits non-zero or no lease is provided', async () => {
  const records = record('kept', '---\ndescription: Kept.\n---\n');
  const skills = [
    skill('bundled', 'Bundled body.', { alwaysAvailable: false }),
  ];

  const rejected = await read('/repo', {
    skills,
    lease: {
      exec: () => Promise.reject(new Error('sandbox unavailable')),
    },
  });
  const failed = await read('/repo', { skills, lease: scanning(records, 2) });
  const killed = await read('/repo', {
    skills,
    lease: scanning(records, null),
  });
  const unprovided = await read('/repo', { skills });

  for (const { result } of [rejected, failed, killed, unprovided]) {
    assert.deepEqual(result.workspace, []);
    assert.deepEqual(
      result.builtIn.map(({ name }) => name),
      ['bundled'],
    );
  }
});

void test('W3 scans the working directory with one sh exec and parses its NUL-separated records in order', async () => {
  const { result, calls } = await read('/repo/app', {
    lease: scanning(
      [
        record('alpha', '---\nname: alpha\ndescription: Alpha does A.\n---\n'),
        record('beta', '---\ndescription: >\n  Beta does\n  B.\n---\nBody'),
      ].join(''),
    ),
  });

  const execs = calls.lease.filter(({ method }) => method === 'exec');
  assert.equal(execs.length, 1);
  const input = execs[0]?.input as {
    readonly cmd: readonly string[];
    readonly timeoutMs?: number;
  };
  assert.deepEqual(input.cmd.slice(0, 2), ['sh', '-c']);
  assert.ok(input.cmd.slice(3).includes('/repo/app/.agents/skills'));
  assert.equal(input.timeoutMs, 5000);
  assert.deepEqual(execs[0]?.scope, scope);
  assert.deepEqual(result.workspace, [
    {
      name: 'alpha',
      description: 'Alpha does A.',
      origin: {
        kind: 'workspace',
        path: '/repo/app/.agents/skills/alpha/SKILL.md',
      },
    },
    {
      name: 'beta',
      description: 'Beta does B.',
      origin: {
        kind: 'workspace',
        path: '/repo/app/.agents/skills/beta/SKILL.md',
      },
    },
  ]);
});

void test('M1 lists the skills of connected servers only, without reading any of them', async () => {
  const { result, calls } = await read('/repo', {
    mcp: {
      list: () => [
        mcpServer({
          id: 'server-1',
          name: 'Acme Billing',
          skills: [
            {
              uri: 'skill://acme/refunds/SKILL.md',
              name: 'refunds',
              description: 'Refund a charge.',
            },
          ],
        }),
        mcpServer({
          id: 'server-2',
          name: 'Docs',
          state: 'needs-sign-in',
          skills: [
            {
              uri: 'skill://docs/guide/SKILL.md',
              name: 'guide',
              description: 'Read the guide.',
            },
          ],
        }),
      ],
      readSkill: () => ({ text: 'never read' }),
    },
  });

  assert.deepEqual(result.server, [
    {
      name: 'refunds',
      description: 'Refund a charge.',
      origin: {
        kind: 'mcp',
        serverId: 'server-1',
        serverName: 'Acme Billing',
        serverSlug: 'acme_billing',
        uri: 'skill://acme/refunds/SKILL.md',
      },
    },
  ]);
  assert.equal(
    calls.mcp.filter(({ method }) => method === 'readSkill').length,
    0,
  );
});

void test('M2 answers no server skill when mcp/v1 is not provided or its list rejects', async () => {
  const unprovided = await read('/repo', {});
  const rejected = await read('/repo', {
    mcp: { list: () => Promise.reject(new Error('mcp down')) },
  });

  assert.deepEqual(unprovided.result.server, []);
  assert.deepEqual(rejected.result.server, []);
});

void test('B1 splits the bundle skills by alwaysAvailable, each part in skills/v1 order', async () => {
  const { result } = await read('/repo', {
    skills: [
      skill('first', 'First body.'),
      skill('listed', 'Listed body.', { alwaysAvailable: false }),
      skill('second', 'Second body.'),
    ],
  });

  assert.deepEqual(
    result.alwaysAvailable.map(({ name, description, body }) => ({
      name,
      description,
      body,
    })),
    [
      { name: 'first', description: 'first description', body: 'First body.' },
      {
        name: 'second',
        description: 'second description',
        body: 'Second body.',
      },
    ],
  );
  assert.deepEqual(result.builtIn, [
    {
      name: 'listed',
      description: 'listed description',
      origin: { kind: 'bundle', body: 'Listed body.' },
    },
  ]);
});

void test('skillBody strips the frontmatter and trims, or trims the whole text without one', () => {
  assert.equal(
    skillBody('---\nname: a\ndescription: A.\n---\n\n  # A\n\nDo A.\n\n'),
    '# A\n\nDo A.',
  );
  assert.equal(skillBody('\n  # Whole\n\nText.\n'), '# Whole\n\nText.');
});
