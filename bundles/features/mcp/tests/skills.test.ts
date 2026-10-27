// Skills a connected server serves through the MCP Skills extension
// (`io.modelcontextprotocol/skills`): the host declares the extension, lists
// the skills of a server that declares it, and publishes them on the server's
// view. Listed only: no skill reaches a prompt.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { McpServerView } from '../src/contracts/index.js';
import { fakeSkill, SKILLS_EXTENSION, textTool } from './support/mcp-server.js';
import { opened, served } from './support/setup.js';
import { eventually, sleep } from './support/wait.js';
import { httpServer, inState, P1, serverOf } from './support/world.js';

/** Whether the server is connected and lists that many skills. */
const connectedWith =
  (id: string, count: number) =>
  (servers: readonly McpServerView[]): boolean => {
    const view = serverOf(servers, id);

    return view?.status.state === 'connected' && view.skills.length === count;
  };

void test('SK1 a server declaring the Skills extension publishes its skills by uri, name and description', async (t) => {
  const world = await opened(t);
  const server = await served(t, {
    tools: [textTool('alpha')],
    skills: [
      [
        fakeSkill('git-workflow', 'Branch, commit and open a pull request.'),
        fakeSkill('refunds', 'Issue a refund.', { license: 'MIT' }),
      ],
    ],
  });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));

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
  const world = await opened(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
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
  const world = await opened(t);
  const server = await served(t, {
    tools: [textTool('alpha')],
    skills: 'fails',
  });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
  await eventually(
    () => world.warnings.length > 0,
    'a warning',
    () => world.warnings,
  );
  await sleep(200);

  const servers = await world.watchUntil(
    P1,
    inState(created.id, 'connected'),
    'still connected',
  );

  assert.deepEqual(world.liveNames(P1), ['mcp__docs__alpha']);

  assert.deepEqual(serverOf(servers, created.id)?.skills, []);

  assert.equal(world.warnings.length, 1);

  assert.equal(
    JSON.stringify(world.warnings[0]?.fields ?? {}).includes(created.id),
    true,
  );
});

void test('SK4 the skills of every page are listed in order, following nextCursor', async (t) => {
  const world = await opened(t);
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
  const created = await world.mcp(P1).create(httpServer('docs', server.url));

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
