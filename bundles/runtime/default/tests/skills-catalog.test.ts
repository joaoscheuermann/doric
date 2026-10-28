import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestServices } from 'bundle/testing';

import { systemPromptWith } from '../src/host/executor.js';
import {
  addedSkillsPrompt,
  alwaysAvailableSkillsPrompt,
  builtInSkillsPrompt,
  changedWorkspaceSkillsPrompt,
  removedSkillsPrompt,
  serverSkillsPrompt,
  skillsChangedPrompt,
  skillsPrompt,
  skillsToLoadPrompt,
  workspaceSkillsPrompt,
} from '../src/host/prompts/skills.js';
import { systemPrompt } from '../src/host/prompts/system.js';
import {
  type CatalogState,
  skillCatalog,
  skillCatalogChange,
} from '../src/host/skills/catalog.js';
import {
  type CatalogSkill,
  type RunSkills,
  readRunSkills,
} from '../src/host/skills/sources.js';
import {
  leaseService,
  mcpServer,
  mcpService,
  projectId,
  promptId,
  skill,
  skillsService,
  threadId,
} from './support/harness.js';

/*
 * The `# Skills` section of the default agent's system prompt, rendered once
 * per prompt run from the skills of that run: always-available bundle skills
 * keep their body, every other skill becomes one row of a list the model loads
 * from with `load_skill`, under the locator the row names.
 */

const none: RunSkills = {
  alwaysAvailable: [],
  builtIn: [],
  workspace: [],
  server: [],
};

const bundle = (
  name: string,
  description: string,
  body = `${name} body.`,
): CatalogSkill => ({ name, description, origin: { kind: 'bundle', body } });

const workspace = (directory: string, description: string): CatalogSkill => ({
  name: directory,
  description,
  origin: {
    kind: 'workspace',
    path: `/workspace/.agents/skills/${directory}/SKILL.md`,
  },
});

const served = (
  serverSlug: string,
  name: string,
  description: string,
  uri = `skill://${serverSlug}/${name}/SKILL.md`,
): CatalogSkill => ({
  name,
  description,
  origin: {
    kind: 'mcp',
    serverId: `${serverSlug}-id`,
    serverName: serverSlug,
    serverSlug,
    uri,
  },
});

const table = (...rows: readonly string[]): string =>
  ['| Skill | Description |', '| --- | --- |', ...rows].join('\n');

/** The rows of the table that follows `heading` in `section`. */
const rowsAfter = (section: string, heading: string): readonly string[] => {
  const start = section.indexOf(heading);
  assert.ok(start >= 0, `${heading} is rendered`);
  const lines = section.slice(start).split('\n');
  const header = lines.indexOf('| --- | --- |');
  const rows: string[] = [];
  for (const line of lines.slice(header + 1)) {
    if (!line.startsWith('| ')) break;
    rows.push(line);
  }
  return rows;
};

void test('S1 renders nothing when every list is empty, and the system prompt stays the base instruction', () => {
  const catalog = skillCatalog(none);

  assert.equal(catalog.section, '');
  assert.equal(catalog.listed.size, 0);
  assert.equal(systemPromptWith(''), systemPrompt);
});

void test('S2 renders only the always-available part, keeping each body verbatim, when no skill is to load', () => {
  const catalog = skillCatalog({
    ...none,
    alwaysAvailable: [
      { name: 'a', description: 'A description.', body: '\n  A body.\n' },
    ],
  });

  assert.equal(
    catalog.section,
    [
      skillsPrompt,
      alwaysAvailableSkillsPrompt,
      '### Skill: a\n\n\n  A body.\n',
    ].join('\n\n'),
  );
  assert.ok(!catalog.section.includes('## Skills to load'));
  assert.equal(catalog.listed.size, 0);
});

void test('S3 lays out the always-available skills, then the built-in, workspace and MCP lists to load, and drops only an empty list', () => {
  const always = {
    name: 'always',
    description: 'Always description.',
    body: 'Always body.',
  };
  const skills: RunSkills = {
    alwaysAvailable: [always],
    builtIn: [bundle('built', 'Built description.')],
    workspace: [workspace('local', 'Local description.')],
    server: [served('docs', 'guide', 'Guide description.')],
  };
  const head = [
    skillsPrompt,
    alwaysAvailableSkillsPrompt,
    '### Skill: always\n\nAlways body.',
    skillsToLoadPrompt,
    `${builtInSkillsPrompt}\n\n${table('| built | Built description. |')}`,
  ];
  const workspacePart = `${workspaceSkillsPrompt}\n\n${table('| cwd/local | Local description. |')}`;
  const serverPart = `${serverSkillsPrompt}\n\n${table('| mcp/docs/guide | Guide description. |')}`;

  const catalog = skillCatalog(skills);

  assert.equal(
    catalog.section,
    [...head, workspacePart, serverPart].join('\n\n'),
  );
  assert.deepEqual(
    [...catalog.listed.keys()],
    ['built', 'cwd/local', 'mcp/docs/guide'],
  );
  assert.equal(
    skillCatalog({ ...skills, workspace: [] }).section,
    [...head, serverPart].join('\n\n'),
  );
});

void test('S4 renders each cell on one line, with single spaces and escaped pipes, so the table stays intact', () => {
  const catalog = skillCatalog({
    ...none,
    builtIn: [bundle('p', '  Use | pipes\nacross\tlines   and \t tabs\n')],
    workspace: [workspace('a|b', 'Plain.')],
  });

  assert.ok(
    catalog.section.includes(
      `${builtInSkillsPrompt}\n\n${table('| p | Use \\| pipes across lines and tabs |')}\n\n`,
    ),
  );
  assert.ok(
    catalog.section.endsWith(
      `${workspaceSkillsPrompt}\n\n${table('| cwd/a\\|b | Plain. |')}`,
    ),
  );
  assert.ok(catalog.listed.has('cwd/a|b'));
});

void test('S5 caps a long description at 500 characters even when its list is under budget', () => {
  const catalog = skillCatalog({
    ...none,
    builtIn: [bundle('long', 'b'.repeat(600))],
  });

  assert.deepEqual(rowsAfter(catalog.section, builtInSkillsPrompt), [
    `| long | ${'b'.repeat(500)}... |`,
  ]);
});

void test('S6 caps every description of a list at 120 characters when it is over budget at 500, keeping every row', () => {
  const names = Array.from(
    { length: 20 },
    (_, index) => `s${String(index + 1).padStart(2, '0')}`,
  );
  const catalog = skillCatalog({
    ...none,
    builtIn: names.map((name) => bundle(name, 'a'.repeat(600))),
    workspace: [workspace('kept', 'c'.repeat(600))],
  });

  assert.deepEqual(
    rowsAfter(catalog.section, builtInSkillsPrompt),
    names.map((name) => `| ${name} | ${'a'.repeat(120)}... |`),
  );
  // The budget is per list: the workspace list still fits at 500.
  assert.deepEqual(rowsAfter(catalog.section, workspaceSkillsPrompt), [
    `| cwd/kept | ${'c'.repeat(500)}... |`,
  ]);
  assert.ok(!catalog.section.includes('did not fit'));
  assert.equal(catalog.listed.size, 21);
});

void test('S7 drops the trailing rows of a list still over budget at 120 characters and says how many did not fit', () => {
  const skills = (count: number): readonly CatalogSkill[] =>
    Array.from({ length: count }, (_, index) =>
      workspace(`w${String(index + 1).padStart(3, '0')}`, 'd'.repeat(600)),
    );
  // Each row is 138 characters at 120: 28 rows joined by '\n' are 3891 long,
  // 29 are 4030, over the 4000 of the workspace list.
  const row = (index: number) =>
    `| cwd/w${String(index).padStart(3, '0')} | ${'d'.repeat(120)}... |`;
  const kept = Array.from({ length: 28 }, (_, index) => row(index + 1));

  const plural = skillCatalog({ ...none, workspace: skills(30) });
  const singular = skillCatalog({ ...none, workspace: skills(29) });

  assert.ok(
    plural.section.endsWith(
      `${workspaceSkillsPrompt}\n\n${table(...kept)}\n\n2 more skills did not fit in this list.`,
    ),
  );
  assert.ok(
    singular.section.endsWith(
      `${table(...kept)}\n\n1 more skill did not fit in this list.`,
    ),
  );
  assert.equal(plural.listed.size, 28);
  assert.ok(plural.listed.has('cwd/w028'));
  assert.ok(!plural.listed.has('cwd/w029'));
  assert.ok(!plural.listed.has('cwd/w030'));
});

void test('S8 moves the always-available skill that would pass 16000 characters, and every one after it, to the front of the built-in list', () => {
  const always = (name: string, body: string) => ({
    name,
    description: `${name} description`,
    body,
  });
  const first = '1'.repeat(7000);
  const second = '2'.repeat(7000);
  const third = '3'.repeat(7000);
  // Two blocks join to 14032 characters; the third would make 21049.
  const catalog = skillCatalog({
    ...none,
    alwaysAvailable: [
      always('a1', first),
      always('a2', second),
      always('a3', third),
      always('a4', 'Small body.'),
    ],
    builtIn: [bundle('b1', 'b1 description')],
  });

  assert.equal(
    catalog.section,
    [
      skillsPrompt,
      alwaysAvailableSkillsPrompt,
      `### Skill: a1\n\n${first}`,
      `### Skill: a2\n\n${second}`,
      skillsToLoadPrompt,
      `${builtInSkillsPrompt}\n\n${table(
        '| a3 | a3 description |',
        '| a4 | a4 description |',
        '| b1 | b1 description |',
      )}`,
    ].join('\n\n'),
  );
  assert.deepEqual([...catalog.listed.keys()], ['a3', 'a4', 'b1']);
  assert.deepEqual(catalog.listed.get('a3')?.origin, {
    kind: 'bundle',
    body: third,
  });
  assert.deepEqual(catalog.listed.get('a4')?.origin, {
    kind: 'bundle',
    body: 'Small body.',
  });
});

void test('L1 names a bundle skill by its name, a workspace skill cwd/<directory> and an MCP skill mcp/<server slug>/<name>', async () => {
  const lease: Parameters<typeof leaseService>[0] = {
    exec: () => ({
      exitCode: 0,
      stdout: 'local\0---\ndescription: Local steps.\n---\n\0',
      stderr: '',
    }),
  };
  const mcp: Parameters<typeof mcpService>[0] = {
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
    ],
  };
  const services = createTestServices({
    bundle: { id: 'default' },
    provide: [
      skillsService([
        skill('bundled', 'Bundled body.', { alwaysAvailable: false }),
      ]),
      leaseService(lease, []),
      mcpService(mcp, []),
    ],
  });
  const call = services.call({ projectId, threadId, promptId });

  const catalog = skillCatalog(
    await readRunSkills('/workspace', call, services.services),
  );

  assert.deepEqual(
    [...catalog.listed.keys()],
    ['bundled', 'cwd/local', 'mcp/acme_billing/refunds'],
  );
  assert.ok(
    catalog.section.includes('| mcp/acme_billing/refunds | Refund a charge. |'),
  );
});

void test('L2 suffixes a locator another skill already took, and a workspace skill named like a bundle skill needs none', () => {
  const catalog = skillCatalog({
    ...none,
    builtIn: [bundle('x', 'Bundle x.')],
    workspace: [workspace('x', 'Workspace x.')],
    server: [
      served('s', 'x', 'First x.', 'skill://s/one/SKILL.md'),
      served('s', 'x', 'Second x.', 'skill://s/two/SKILL.md'),
      served('t', 'x', 'Third x.'),
    ],
  });

  assert.deepEqual(
    [...catalog.listed.keys()],
    ['x', 'cwd/x', 'mcp/s/x', 'mcp/s/x~2', 'mcp/t/x'],
  );
  assert.deepEqual(
    catalog.listed.get('mcp/s/x~2'),
    served('s', 'x', 'Second x.', 'skill://s/two/SKILL.md'),
  );
  assert.deepEqual(rowsAfter(catalog.section, serverSkillsPrompt), [
    '| mcp/s/x | First x. |',
    '| mcp/s/x~2 | Second x. |',
    '| mcp/t/x | Third x. |',
  ]);
});

/*
 * The catalog's change across a run: the workspace and MCP lists read again
 * before a later model request, compared with what the model was told, give
 * the body of one "Skills changed" message and the state the next check
 * compares with. Identities: `bundle:<name>`, `workspace:<SKILL.md path>`,
 * `mcp:<serverId>\n<uri>`.
 */

/** A workspace skill of the directory `root`, under `.agents/skills`. */
const workspaceAt = (
  root: string,
  directory: string,
  description: string,
): CatalogSkill => ({
  name: directory,
  description,
  origin: {
    kind: 'workspace',
    path: `${root}/.agents/skills/${directory}/SKILL.md`,
  },
});

const workspaceIdentity = (root: string, directory: string): string =>
  `workspace:${root}/.agents/skills/${directory}/SKILL.md`;

/** The part of the state a later check reads. */
const stateOf = ({ locators, available, listed }: CatalogState) => ({
  locators,
  available,
  listed,
});

void test('C1 gives every rendered or dropped row a locator and keeps it available, but lists only the shown rows', () => {
  const many = Array.from({ length: 30 }, (_, index) =>
    workspace(`w${String(index + 1).padStart(3, '0')}`, 'd'.repeat(600)),
  );
  const catalog = skillCatalog({
    ...none,
    alwaysAvailable: [
      { name: 'always', description: 'Always.', body: 'Always body.' },
    ],
    builtIn: [bundle('x', 'Bundle x.')],
    workspace: many,
    server: [served('s', 'y', 'Served y.')],
  });

  const workspaceEntries = many.map(
    ({ name }) =>
      [workspaceIdentity('/workspace', name), `cwd/${name}`] as const,
  );
  assert.deepEqual(
    catalog.locators,
    new Map([
      ['bundle:x', 'x'],
      ...workspaceEntries,
      ['mcp:s-id\nskill://s/y/SKILL.md', 'mcp/s/y'],
    ]),
  );
  assert.deepEqual(
    catalog.available,
    new Set([
      'bundle:x',
      ...workspaceEntries.map(([identity]) => identity),
      'mcp:s-id\nskill://s/y/SKILL.md',
    ]),
  );
  // S7: 28 workspace rows fit the list, the last two are dropped.
  assert.deepEqual(
    [...catalog.listed.keys()],
    [
      'x',
      ...workspaceEntries.slice(0, 28).map(([, locator]) => locator),
      'mcp/s/y',
    ],
  );
});

void test('C2 reports nothing and keeps the state when the lists did not change', () => {
  const current = {
    workspace: [workspace('local', 'Local.')],
    server: [served('s', 'y', 'Served y.')],
  };
  const catalog = skillCatalog({
    ...none,
    builtIn: [bundle('x', 'Bundle x.')],
    ...current,
  });

  const change = skillCatalogChange(catalog, current);

  assert.equal(change.message, undefined);
  assert.deepEqual(stateOf(change.state), stateOf(catalog));
  assert.deepEqual(
    [...change.state.listed.keys()],
    ['x', 'cwd/local', 'mcp/s/y'],
  );
});

void test('C3 announces an added workspace skill as a table row under its own heading and lists it after the others', () => {
  const catalog = skillCatalog({
    ...none,
    builtIn: [bundle('x', 'Bundle x.')],
    workspace: [workspace('local', 'Local.')],
  });

  const change = skillCatalogChange(catalog, {
    workspace: [
      workspace('fresh', 'Fresh steps.'),
      workspace('local', 'Local.'),
    ],
    server: [],
  });

  assert.equal(
    change.message,
    [
      skillsChangedPrompt,
      addedSkillsPrompt,
      `${changedWorkspaceSkillsPrompt}\n\n${table('| cwd/fresh | Fresh steps. |')}`,
    ].join('\n\n'),
  );
  assert.deepEqual(
    [...change.state.listed.keys()],
    ['x', 'cwd/local', 'cwd/fresh'],
  );
  assert.equal(change.state.locators.get('bundle:x'), 'x');
  assert.equal(
    change.state.locators.get(workspaceIdentity('/workspace', 'local')),
    'cwd/local',
  );
  assert.equal(
    change.state.locators.get(workspaceIdentity('/workspace', 'fresh')),
    'cwd/fresh',
  );
});

void test('C3 announces an added MCP skill under the MCP server heading', () => {
  const catalog = skillCatalog({
    ...none,
    builtIn: [bundle('x', 'Bundle x.')],
  });

  const change = skillCatalogChange(catalog, {
    workspace: [],
    server: [served('docs', 'guide', 'Guide steps.')],
  });

  assert.equal(
    change.message,
    [
      skillsChangedPrompt,
      addedSkillsPrompt,
      `${serverSkillsPrompt}\n\n${table('| mcp/docs/guide | Guide steps. |')}`,
    ].join('\n\n'),
  );
  assert.deepEqual([...change.state.listed.keys()], ['x', 'mcp/docs/guide']);
});

void test('C4 reports a listed skill that went away, gives a new skill of the same base the next suffix, and a returning skill its old locator', () => {
  const start = skillCatalog({
    ...none,
    builtIn: [bundle('x', 'Bundle x.')],
    workspace: [workspaceAt('/workspace', 'local', 'Local.')],
  });

  // The working directory moved to one without skills.
  const gone = skillCatalogChange(start, { workspace: [], server: [] });
  assert.equal(
    gone.message,
    [skillsChangedPrompt, `${removedSkillsPrompt}\n\n- \`cwd/local\``].join(
      '\n\n',
    ),
  );
  assert.deepEqual([...gone.state.listed.keys()], ['x']);
  assert.ok(
    !gone.state.available.has(workspaceIdentity('/workspace', 'local')),
  );

  // Then to another directory with a skill of the same name: another skill.
  const other = skillCatalogChange(gone.state, {
    workspace: [workspaceAt('/workspace/repo', 'local', 'Repo local.')],
    server: [],
  });
  assert.equal(
    other.message,
    [
      skillsChangedPrompt,
      addedSkillsPrompt,
      `${changedWorkspaceSkillsPrompt}\n\n${table('| cwd/local~2 | Repo local. |')}`,
    ].join('\n\n'),
  );
  assert.deepEqual([...other.state.listed.keys()], ['x', 'cwd/local~2']);

  // Back to the first directory: the first skill returns under its locator.
  const back = skillCatalogChange(other.state, {
    workspace: [workspaceAt('/workspace', 'local', 'Local.')],
    server: [],
  });
  assert.equal(
    back.message,
    [
      skillsChangedPrompt,
      addedSkillsPrompt,
      `${changedWorkspaceSkillsPrompt}\n\n${table('| cwd/local | Local. |')}`,
      `${removedSkillsPrompt}\n\n- \`cwd/local~2\``,
    ].join('\n\n'),
  );
  assert.deepEqual([...back.state.listed.keys()], ['x', 'cwd/local']);
  assert.equal(back.state.listed.get('cwd/local')?.description, 'Local.');
});

void test('C4 lists every removed row in list order after the additions', () => {
  const start = skillCatalog({
    ...none,
    workspace: [
      workspaceAt('/workspace', 'local', 'Local.'),
      workspaceAt('/workspace', 'shared', 'Shared.'),
    ],
    server: [served('docs', 'guide', 'Guide steps.')],
  });

  const change = skillCatalogChange(start, {
    workspace: [
      workspaceAt('/workspace/repo', 'fresh', 'Fresh.'),
      workspaceAt('/workspace/repo', 'shared', 'Shared.'),
    ],
    server: [],
  });

  assert.equal(
    change.message,
    [
      skillsChangedPrompt,
      addedSkillsPrompt,
      `${changedWorkspaceSkillsPrompt}\n\n${table(
        '| cwd/fresh | Fresh. |',
        '| cwd/shared~2 | Shared. |',
      )}`,
      `${removedSkillsPrompt}\n\n${[
        '- `cwd/local`',
        '- `cwd/shared`',
        '- `mcp/docs/guide`',
      ].join('\n')}`,
    ].join('\n\n'),
  );
  assert.deepEqual(
    [...change.state.listed.keys()],
    ['cwd/fresh', 'cwd/shared~2'],
  );
});

void test('C5 caps the added rows like a system prompt list, and never lists, re-announces or reports a dropped one', () => {
  const names = Array.from(
    { length: 30 },
    (_, index) => `w${String(index + 1).padStart(3, '0')}`,
  );
  const skills = names.map((name) => workspace(name, 'd'.repeat(600)));
  // Each row is 138 characters at 120: 28 rows fit the 4000 of the list.
  const kept = names
    .slice(0, 28)
    .map((name) => `| cwd/${name} | ${'d'.repeat(120)}... |`);
  const start = skillCatalog(none);

  const added = skillCatalogChange(start, { workspace: skills, server: [] });
  assert.equal(
    added.message,
    [
      skillsChangedPrompt,
      addedSkillsPrompt,
      `${changedWorkspaceSkillsPrompt}\n\n${table(...kept)}\n\n2 more skills did not fit in this list.`,
    ].join('\n\n'),
  );
  assert.equal(added.state.listed.size, 28);
  assert.ok(!added.state.listed.has('cwd/w029'));
  assert.ok(!added.state.listed.has('cwd/w030'));

  // The same lists again: the dropped rows are not announced a second time.
  const again = skillCatalogChange(added.state, {
    workspace: skills,
    server: [],
  });
  assert.equal(again.message, undefined);
  assert.equal(again.state.listed.size, 28);

  // The dropped skills go away: the model never saw them, so nothing to say.
  const dropped = skillCatalogChange(again.state, {
    workspace: skills.slice(0, 28),
    server: [],
  });
  assert.equal(dropped.message, undefined);

  // A shown one goes away: only it is reported.
  const shown = skillCatalogChange(dropped.state, {
    workspace: skills.slice(0, 27),
    server: [],
  });
  assert.equal(
    shown.message,
    [skillsChangedPrompt, `${removedSkillsPrompt}\n\n- \`cwd/w028\``].join(
      '\n\n',
    ),
  );
});
