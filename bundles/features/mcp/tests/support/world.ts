// Server configurations the `mcp` tests create. The kernel world that once
// lived here (`activateWorld`, `World`, `createEnvironment`) is gone (S68c):
// every suite runs on the routed world of `router.ts`.

import type { McpEntry, McpServerInput } from '../../src/contracts/index.js';

/** An enabled http server configuration. */
export const httpServer = (
  name: string,
  url: string,
  headers: readonly McpEntry[] = [],
  enabled = true,
): McpServerInput => ({
  name,
  enabled,
  transport: { kind: 'http', url, headers },
});

/** An enabled stdio server configuration. */
export const stdioServer = (
  name: string,
  command: string,
  args: readonly string[] = [],
  env: readonly McpEntry[] = [],
  cwd?: string,
): McpServerInput => ({
  name,
  enabled: true,
  transport: {
    kind: 'stdio',
    command,
    args,
    env,
    ...(cwd === undefined ? {} : { cwd }),
  },
});
