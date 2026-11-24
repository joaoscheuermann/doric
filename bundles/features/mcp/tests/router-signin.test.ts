// M9 (phase 3, S59c): the whole OAuth sign-in over `mcp/v1` against a fake
// authorization server: `SignIn` answers the authorization URL, the browser's
// redirect reaches the loopback callback, `FinishSignIn` answers the server
// signed in and connected. The tokens are kept only as MCP_TOKEN credentials
// created through `secrets/v1.Create`; the stored client information keeps the
// registration's keys and never a client secret.

import assert from 'node:assert/strict';
import test from 'node:test';

import { textTool } from './support/mcp-server.js';
import { activated, P1, signInThrough } from './support/router.js';
import { authorizing, guarded } from './support/setup.js';
import { httpServer } from './support/world.js';

void test("M9: SignIn, the browser redirect and FinishSignIn connect the server signed in; tokens are MCP_TOKEN credentials created through secrets/v1, and the stored client information keeps the server's keys without a client secret", async (t) => {
  const world = await activated(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.create(P1, httpServer('docs', server.url));

  const view = await signInThrough(world, P1, created.id, as);

  assert.equal(view.signedIn, true);
  assert.equal(view.status.state, 'connected');
  const [tokens] = as.issued;
  assert.ok(tokens !== undefined, 'the authorization server issued tokens');
  const creates = world.callsOf('secrets.create').map(({ request }) => request);
  assert.deepEqual(
    [...creates].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
    [
      { kind: 'MCP_TOKEN', name: `mcp:${created.id}:access` },
      { kind: 'MCP_TOKEN', name: `mcp:${created.id}:refresh` },
    ],
  );
  const secrets = [...world.credentials.values()];
  assert.equal(
    secrets.find(({ name }) => name === `mcp:${created.id}:access`)?.secret,
    tokens.accessToken,
  );
  assert.equal(
    secrets.find(({ name }) => name === `mcp:${created.id}:refresh`)?.secret,
    tokens.refreshToken,
  );

  const [document] = world.documents();
  const oauth = document?.oauth as
    | { readonly clientInformation?: Record<string, unknown> }
    | undefined;
  const information = oauth?.clientInformation;
  assert.ok(information !== undefined, JSON.stringify(document));
  assert.equal(information.client_id, 'client-1');
  assert.equal(typeof information.client_id_issued_at, 'number');
  assert.deepEqual(
    information.redirect_uris,
    as.registrations[0]?.redirect_uris,
  );
  assert.ok(!('client_secret' in information));
  const stored = JSON.stringify(world.documents());
  assert.ok(!stored.includes(tokens.accessToken));
  assert.ok(!stored.includes(tokens.refreshToken));
});
