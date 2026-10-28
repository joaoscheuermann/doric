// The whole interactive sign-in as a user lives it: the bundle answers the
// authorization URL, the user consents at the AS, the browser follows the
// redirect to the bundle's local callback, and finishSignIn completes.

import type { McpServerView } from '../../src/contracts/index.js';
import {
  type Approval,
  type FakeAuthorizationServer,
  followRedirect,
} from './oauth-server.js';
import type { World } from './world.js';

export interface SignedIn {
  readonly url: URL;
  readonly approval: Approval;
  readonly view: McpServerView;
}

export const signInThrough = async (
  world: World,
  projectId: string,
  id: string,
  as: FakeAuthorizationServer,
): Promise<SignedIn> => {
  const mcp = world.mcp(projectId);
  const { url } = await mcp.signIn({ id });
  const approval = as.approve(url);
  const finishing = mcp.finishSignIn({ id });
  await followRedirect(approval);

  return { url: new URL(url), approval, view: await finishing };
};

/** The MCP_TOKEN credentials stored for the server, by name. */
export const tokenCredentials = (
  world: World,
  id: string,
): readonly { readonly name: string; readonly secret?: string }[] =>
  [...world.env.credentials.values()].filter(
    (entry) =>
      entry.kind === 'MCP_TOKEN' && entry.name.startsWith(`mcp:${id}:`),
  );
