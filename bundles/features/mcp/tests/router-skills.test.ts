// Skills a connected server serves through the MCP Skills extension
// (`io.modelcontextprotocol/skills`), over the router (S68c, X3): what
// `skills.test.ts` tested on the kernel entry and the router suites M10, SK1
// and SK2 do not already cover. The host declares the extension, lists the
// skills of a server that declares it and publishes them on the server's view;
// a skill's text is read only on demand, through `mcp/v1.ReadSkill` or
// `default.skill-sources/v1`, and only for a uri the connected server lists now.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';

import {
  type FakeSkill,
  fakeSkill,
  SKILLS_EXTENSION,
  textTool,
  unreachableUrl,
} from './support/mcp-server.js';
import {
  activated,
  failureOf,
  inState,
  listUntil,
  P1,
  P2,
  serverOf,
  type View,
} from './support/router.js';
import { served } from './support/setup.js';
import { eventually, sleep } from './support/wait.js';
import { httpServer } from './support/world.js';

/** Whether the server is connected and lists that many skills. */
const connectedWith =
  (id: string, count: number) =>
  (servers: readonly View[]): boolean => {
    const view = serverOf(servers, id);

    return view?.status.state === 'connected' && view.skills.length === count;
  };

/** The whole SKILL.md the `refunds` skill serves, frontmatter included. */
const REFUNDS_TEXT = [
  '---',
  'name: refunds',
  'description: Issue a refund.',
  '---',
  '',
  '# Refunds',
  '',
  'Look the order up, then refund it through the payments tool.',
  '',
].join('\n');

const REFUNDS_URI = 'skill://refunds/SKILL.md';

/** The `refunds` skill, whose read answers REFUNDS_TEXT. */
const refunds = (): FakeSkill => ({
  ...fakeSkill('refunds', 'Issue a refund.'),
  text: REFUNDS_TEXT,
});

/** The code `call` failed with. */
const codeOfFailure = async (call: () => Promise<unknown>): Promise<string> =>
  (await failureOf(call)).code;

/** The origin line `mcp` gives the `refunds` skill of a server named `name`. */
const refundsOrigin = (name: string): string =>
  `From the MCP server "${name}" (\`${REFUNDS_URI}\`). Its other files are not available.`;

/** A connected "Acme Billing" server of P1 serving `refunds`, and its id. */
const acmeBilling = async (t: TestContext) => {
  const world = await activated(t);
  const server = await served(t, {
    tools: [textTool('alpha')],
    skills: [[refunds()]],
  });
  const created = await world.create(
    P1,
    httpServer('Acme Billing', server.url),
  );
  await world.watchUntil(
    P1,
    connectedWith(created.id, 1),
    'connected with one skill',
  );

  return { world, server, id: created.id };
};

void test('SK1 a server declaring the Skills extension publishes its skills by uri, name and description', async (t) => {
  const world = await activated(t);
  const server = await served(t, {
    tools: [textTool('alpha')],
    skills: [
      [
        fakeSkill('git-workflow', 'Branch, commit and open a pull request.'),
        fakeSkill('refunds', 'Issue a refund.', { license: 'MIT' }),
      ],
    ],
  });
  const created = await world.create(P1, httpServer('docs', server.url));

  const servers = await world.watchUntil(
    P1,
    connectedWith(created.id, 2),
    'connected with two skills',
  );

  assert.deepEqual(serverOf(servers, created.id)?.skills, [
    {
      uri: 'skill://git-workflow/SKILL.md',
      name: 'git-workflow',
      description: 'Branch, commit and open a pull request.',
    },
    {
      uri: 'skill://refunds/SKILL.md',
      name: 'refunds',
      description: 'Issue a refund.',
    },
  ]);
  assert.equal(
    Object.hasOwn(
      server.tools.clientCapabilities()?.extensions ?? {},
      SKILLS_EXTENSION,
    ),
    true,
  );
});

void test('SK2 a server without the Skills extension is never asked for skills and lists none', async (t) => {
  const world = await activated(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const created = await world.create(P1, httpServer('docs', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
  await sleep(200);

  const servers = await world.watchUntil(
    P1,
    inState(created.id, 'connected'),
    'still connected',
  );

  assert.deepEqual(world.liveNames(P1), ['mcp__docs__alpha']);
  assert.deepEqual(serverOf(servers, created.id)?.skills, []);
  assert.deepEqual(server.tools.skillCursors, []);
});

void test('SK3 a failing skills listing keeps the server connected with its tools, lists no skills and warns once', async (t) => {
  const world = await activated(t);
  const server = await served(t, {
    tools: [textTool('alpha')],
    skills: 'fails',
  });
  const warnings = () => world.logs.filter(({ level }) => level === 'warn');
  const created = await world.create(P1, httpServer('docs', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
  await eventually(() => warnings().length > 0, 'a warning', warnings);
  await sleep(200);

  const servers = await world.watchUntil(
    P1,
    inState(created.id, 'connected'),
    'still connected',
  );

  assert.deepEqual(world.liveNames(P1), ['mcp__docs__alpha']);
  assert.deepEqual(serverOf(servers, created.id)?.skills, []);
  assert.equal(warnings().length, 1);
  assert.equal(
    JSON.stringify(warnings()[0]?.fields ?? {}).includes(created.id),
    true,
  );
});

void test('SK4 the skills of every page are listed in order, following nextCursor', async (t) => {
  const world = await activated(t);
  const server = await served(t, {
    tools: [textTool('alpha')],
    skills: [
      [fakeSkill('triage', 'Sort new issues by team.')],
      [
        fakeSkill('release-notes', 'Draft release notes from closed issues.'),
        fakeSkill('refunds', 'Issue a refund.'),
      ],
    ],
  });
  const created = await world.create(P1, httpServer('docs', server.url));

  const servers = await world.watchUntil(
    P1,
    connectedWith(created.id, 3),
    'connected with three skills',
  );

  assert.deepEqual(
    serverOf(servers, created.id)?.skills.map((skill) => skill.name),
    ['triage', 'release-notes', 'refunds'],
  );
  assert.deepEqual(server.tools.skillCursors, [undefined, 'page-1']);
});

void test('SK5 readSkill answers the whole text of a listed skill, read from the server once per call and never before', async (t) => {
  const { world, server, id } = await acmeBilling(t);
  await world.list(P1);
  await sleep(200);

  assert.deepEqual(server.tools.resourceReads, []);

  const read = await world.mcp(P1).readSkill({ id, uri: REFUNDS_URI });

  assert.equal(read.text, REFUNDS_TEXT);
  assert.deepEqual(server.tools.resourceReads, [REFUNDS_URI]);

  const again = await world.mcp(P1).readSkill({ id, uri: REFUNDS_URI });

  assert.equal(again.text, REFUNDS_TEXT);
  assert.deepEqual(server.tools.resourceReads, [REFUNDS_URI, REFUNDS_URI]);
});

void test('SK6 readSkill refuses a uri the server does not list as unavailable, without reading it', async (t) => {
  const { world, server, id } = await acmeBilling(t);

  assert.equal(
    await codeOfFailure(() =>
      world.mcp(P1).readSkill({ id, uri: 'skill://triage/SKILL.md' }),
    ),
    'mcp_skill_unavailable',
  );
  assert.deepEqual(server.tools.resourceReads, []);
});

void test('SK7 readSkill refuses a disabled server or one in error as unavailable', async (t) => {
  const world = await activated(t);
  const server = await served(t, {
    tools: [textTool('alpha')],
    skills: [[refunds()]],
  });
  const disabled = await world.create(
    P1,
    httpServer('docs', server.url, [], false),
  );
  const failing = await world.create(
    P1,
    httpServer('gone', await unreachableUrl()),
  );
  await world.watchUntil(
    P1,
    (servers) =>
      inState(disabled.id, 'disabled')(servers) &&
      inState(failing.id, 'error')(servers),
    'one disabled, one in error',
  );

  for (const id of [disabled.id, failing.id]) {
    assert.equal(
      await codeOfFailure(() =>
        world.mcp(P1).readSkill({ id, uri: REFUNDS_URI }),
      ),
      'mcp_skill_unavailable',
    );
  }
  assert.deepEqual(server.tools.resourceReads, []);
});

void test('SK8 readSkill refuses a server that is idle again, once its Project closed, as unavailable', async (t) => {
  const { world, server, id } = await acmeBilling(t);
  await world.projectClosing(P1);
  await listUntil(world, P1, inState(id, 'idle'), 'idle');

  assert.equal(
    await codeOfFailure(() =>
      world.mcp(P1).readSkill({ id, uri: REFUNDS_URI }),
    ),
    'mcp_skill_unavailable',
  );
  assert.deepEqual(server.tools.resourceReads, []);
});

void test('SK9 readSkill refuses an unknown server and a server of another Project as missing', async (t) => {
  const world = await activated(t);
  const server = await served(t, {
    tools: [textTool('alpha')],
    skills: [[refunds()]],
  });
  const other = await world.create(P2, httpServer('docs', server.url));
  await world.watchUntil(
    P2,
    connectedWith(other.id, 1),
    'connected with one skill',
  );

  for (const id of [randomUUID(), other.id]) {
    assert.equal(
      await codeOfFailure(() =>
        world.mcp(P1).readSkill({ id, uri: REFUNDS_URI }),
      ),
      'mcp_server_missing',
    );
  }
  assert.deepEqual(server.tools.resourceReads, []);
});

void test('SK10 a read answering no text, or failing, is unavailable and its message masks the server secrets', async (t) => {
  const world = await activated(t);
  const secret = 'secret-sk10-value';
  const credentialId = world.addCredential('docs-key', secret);
  const blobOnly = {
    ...fakeSkill('blob-only', 'Answers a blob.'),
    read: 'blob',
  } satisfies FakeSkill;
  const failing = {
    ...fakeSkill('failing', 'Fails to read.'),
    read: { fails: `The key ${secret} may not read this skill.` },
  } satisfies FakeSkill;
  const server = await served(t, {
    tools: [textTool('alpha')],
    skills: [[blobOnly, failing]],
  });
  const created = await world.create(
    P1,
    httpServer('docs', server.url, [{ name: 'X-Key', credentialId }]),
  );
  await world.watchUntil(
    P1,
    connectedWith(created.id, 2),
    'connected with two skills',
  );

  for (const skill of [blobOnly, failing]) {
    const failure = await failureOf(() =>
      world.mcp(P1).readSkill({ id: created.id, uri: skill.uri }),
    );

    assert.equal(failure.code, 'mcp_skill_unavailable', skill.uri);
    assert.equal(failure.message.includes(secret), false, skill.uri);
  }
  assert.deepEqual(server.tools.resourceReads, [blobOnly.uri, failing.uri]);
});

void test('SK11 readSkill without a Project scope is refused as invalid input', async (t) => {
  const world = await activated(t);

  assert.equal(
    await codeOfFailure(() =>
      world.mcp(undefined).readSkill({ id: randomUUID(), uri: REFUNDS_URI }),
    ),
    'invalid_input',
  );
});

void test('SK13 the skill source of mcp lists the skills of the connected servers of the Project only, by group, name, description and reference, without reading them', async (t) => {
  const world = await activated(t);
  const server = await served(t, {
    tools: [textTool('alpha')],
    skills: [[refunds()]],
  });
  const connected = await world.create(
    P1,
    httpServer('Acme Billing', server.url),
  );
  const disabled = await world.create(
    P1,
    httpServer('Docs', server.url, [], false),
  );
  const failing = await world.create(
    P1,
    httpServer('Gone', await unreachableUrl()),
  );
  const other = await world.create(P2, httpServer('Other', server.url));
  await world.watchUntil(
    P1,
    (servers) =>
      connectedWith(connected.id, 1)(servers) &&
      inState(disabled.id, 'disabled')(servers) &&
      inState(failing.id, 'error')(servers),
    'one connected, one disabled, one in error',
  );
  await world.watchUntil(
    P2,
    connectedWith(other.id, 1),
    'connected with one skill',
  );

  const { skills } = await world.skillSources(P1).list({ cwd: '/workspace' });

  assert.deepEqual(
    skills.map(({ group, name, description, reference }) => ({
      group,
      name,
      description,
      reference,
    })),
    [
      {
        group: 'acme_billing',
        name: 'refunds',
        description: 'Issue a refund.',
        reference: `${connected.id}\n${REFUNDS_URI}`,
      },
    ],
  );
  assert.deepEqual(server.tools.resourceReads, []);
});

void test('SK14 the skill source of mcp reads a listed skill by its reference, once per call, with the origin line naming the server', async (t) => {
  const { world, server } = await acmeBilling(t);
  const source = world.skillSources(P1);
  const [entry] = (await source.list({ cwd: '/workspace' })).skills;
  assert.ok(entry !== undefined, 'the skill is listed');

  const read = await source.read({ reference: entry.reference });

  assert.deepEqual(
    { origin: read.origin, text: read.text },
    { origin: refundsOrigin('Acme Billing'), text: REFUNDS_TEXT },
  );
  assert.deepEqual(server.tools.resourceReads, [REFUNDS_URI]);
});

void test('SK15 the skill source of mcp refuses a read as readSkill does, and an unparsable reference as invalid input, without reading', async (t) => {
  const { world, server, id } = await acmeBilling(t);
  const source = world.skillSources(P1);

  assert.equal(
    await codeOfFailure(() =>
      source.read({ reference: `${randomUUID()}\n${REFUNDS_URI}` }),
    ),
    'mcp_server_missing',
  );
  assert.equal(
    await codeOfFailure(() =>
      source.read({ reference: `${id}\nskill://triage/SKILL.md` }),
    ),
    'mcp_skill_unavailable',
  );
  assert.equal(
    await codeOfFailure(() => source.read({ reference: REFUNDS_URI })),
    'invalid_input',
  );
  assert.deepEqual(server.tools.resourceReads, []);
});

void test('SK16 the skill source of mcp refuses a read without a Project scope as invalid input', async (t) => {
  const { world, server, id } = await acmeBilling(t);

  assert.equal(
    await codeOfFailure(() =>
      world
        .skillSources(undefined)
        .read({ reference: `${id}\n${REFUNDS_URI}` }),
    ),
    'invalid_input',
  );
  assert.deepEqual(server.tools.resourceReads, []);
});
