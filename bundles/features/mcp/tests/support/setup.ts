// Per-test setup that cleans up after itself, so no server, connection or
// activation outlives the test that opened it.

import type { TestContext } from 'node:test';

import {
  type HttpMcpOptions,
  type HttpMcpServer,
  httpMcpServer,
} from './mcp-server.js';
import {
  type AuthorizationServerOptions,
  authorizationServer,
  type FakeAuthorizationServer,
} from './oauth-server.js';
import { activateWorld, type Environment, type World } from './world.js';

/** Activates the bundle for the test; deactivated when the test ends. */
export const opened = async (
  t: TestContext,
  env?: Environment,
): Promise<World> => {
  const world = await activateWorld(env);
  t.after(() => world.deactivate());

  return world;
};

/** An MCP server for the test; closed when the test ends. */
export const served = async (
  t: TestContext,
  options: HttpMcpOptions,
): Promise<HttpMcpServer> => {
  const server = await httpMcpServer(options);
  t.after(() => server.close());

  return server;
};

/** An authorization server for the test; closed when the test ends. */
export const authorizing = async (
  t: TestContext,
  options?: AuthorizationServerOptions,
): Promise<FakeAuthorizationServer> => {
  const as = await authorizationServer(options);
  t.after(() => as.close());

  return as;
};

/** An MCP server guarded by the authorization server's access tokens. */
export const guarded = (
  t: TestContext,
  as: FakeAuthorizationServer,
  options: Omit<HttpMcpOptions, 'auth'>,
): Promise<HttpMcpServer> =>
  served(t, {
    ...options,
    auth: { authorizationServer: () => as.issuer, tokens: as.accessTokens },
  });
