// SK1–SK2 (phase 3, S59c): `default.skill-sources/v1` over the router, as
// `default` reads it from `mcp`. `List` answers one entry per listed skill of
// each connected server of the Project (group = the server's slug, a
// reference carrying the server id and the skill's uri); a disconnected
// server contributes none. `Read` answers the origin line and the text; an
// unparsable reference is `invalid_input`, another Project's server
// `mcp_server_missing`.

import assert from 'node:assert/strict';
import test from 'node:test';

import { type FakeSkill, fakeSkill, textTool } from './support/mcp-server.js';
import { activated, failureOf, inState, P1, P2 } from './support/router.js';
import { served } from './support/setup.js';
import { httpServer } from './support/world.js';

const REFUNDS_URI = 'skill://refunds/SKILL.md';
const REFUNDS_TEXT =
  '---\nname: refunds\ndescription: Issue a refund.\n---\n\n# Refunds\n';

const refunds = (): FakeSkill => ({
  ...fakeSkill('refunds', 'Issue a refund.'),
  text: REFUNDS_TEXT,
});

/** A connected "Acme Billing" server of P1 serving `refunds`, beside a disabled one. */
const acmeBilling = async (t: test.TestContext) => {
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
  await world.watchUntil(
    P1,
    (servers) =>
      inState(connected.id, 'connected')(servers) &&
      inState(disabled.id, 'disabled')(servers),
    'one connected, one disabled',
  );

  return { world, server, id: connected.id };
};

void test("SK1: List answers one entry per listed skill of each connected server, grouped by the server's slug, with a reference to it; a disconnected server contributes none", async (t) => {
  const { world, server, id } = await acmeBilling(t);

  const { skills } = await world.skillSources(P1).list({ cwd: '' });

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
        reference: `${id}\n${REFUNDS_URI}`,
      },
    ],
  );
  assert.deepEqual(server.tools.resourceReads, []);
});

void test("SK2: Read answers the origin line and the text; a malformed reference is invalid_input with today's text; another Project's server is mcp_server_missing", async (t) => {
  const { world, server } = await acmeBilling(t);
  const other = await world.create(P2, httpServer('Other', server.url));
  const source = world.skillSources(P1);
  const [entry] = (await source.list({ cwd: '/workspace' })).skills;
  assert.ok(entry !== undefined, 'the skill is listed');

  const read = await source.read({ reference: entry.reference });
  const malformed = await failureOf(() =>
    source.read({ reference: REFUNDS_URI }),
  );
  const foreign = await failureOf(() =>
    source.read({ reference: `${other.id}\n${REFUNDS_URI}` }),
  );

  assert.deepEqual(
    { origin: read.origin, text: read.text },
    {
      origin: `From the MCP server "Acme Billing" (\`${REFUNDS_URI}\`). Its other files are not available.`,
      text: REFUNDS_TEXT,
    },
  );
  assert.deepEqual(
    { code: malformed.code, message: malformed.message },
    {
      code: 'invalid_input',
      message: 'The reference names no MCP server and skill.',
    },
  );
  assert.equal(foreign.code, 'mcp_server_missing');
});
