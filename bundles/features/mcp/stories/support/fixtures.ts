// The servers and credentials the MCP stories draw: one Project's servers in
// every status, and the host answers as a logging `McpApi` (no live host).

import type { CredentialDescription } from 'bundle/contracts';

import type { McpApi } from '../../src/client/api.js';
import {
  type McpServerView,
  type McpStatus,
  mcpStatuses,
} from '../../src/contracts/index.js';

export const projectId = 'p-checkout';

export const linearServer: McpServerView = {
  id: 's-linear',
  projectId,
  name: 'Linear',
  enabled: true,
  transport: {
    kind: 'http',
    url: 'https://mcp.linear.app/mcp',
    headers: [{ name: 'Authorization', credentialId: 'c-linear' }],
  },
  status: { state: 'connected' },
  signedIn: false,
  tools: [
    { name: 'list_issues', description: 'List the issues of a team.' },
    { name: 'create_issue', description: 'Create an issue in a team.' },
    { name: 'get_issue' },
  ],
  skills: [
    {
      uri: 'skill://triage/SKILL.md',
      name: 'triage',
      description: 'Sort new issues by team.',
    },
    {
      uri: 'skill://release-notes/SKILL.md',
      name: 'release-notes',
      description: 'Draft release notes from closed issues.',
    },
  ],
};

export const filesServer: McpServerView = {
  id: 's-files',
  projectId,
  name: 'Files',
  enabled: true,
  transport: {
    kind: 'stdio',
    command: 'npx',
    args: [
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '/workspace/My Files',
    ],
    cwd: '/workspace',
    env: [
      { name: 'LOG_LEVEL', value: 'debug' },
      { name: 'GITHUB_TOKEN', credentialId: 'c-github' },
    ],
  },
  status: { state: 'idle' },
  signedIn: false,
  tools: [],
  skills: [],
};

/** A server name per status, so each row says which one it shows. */
const names: Readonly<Record<McpStatus, string>> = {
  connected: 'Linear',
  connecting: 'Sentry',
  idle: 'Files',
  disabled: 'Postgres',
  'needs-sign-in': 'Notion',
  'waiting-for-sandbox': 'Playwright',
  error: 'Shell',
};

/** One server per status; the remote ones are http, the others stdio. */
export const everyStatus: readonly McpServerView[] = mcpStatuses.map(
  (state) => ({
    ...(state === 'needs-sign-in' || state === 'connected'
      ? linearServer
      : filesServer),
    id: `s-${state}`,
    name: names[state],
    enabled: state !== 'disabled',
    status:
      state === 'error'
        ? { state, message: 'The process exited with code 1.' }
        : { state },
    tools: state === 'connected' ? linearServer.tools : [],
    skills: state === 'connected' ? linearServer.skills : [],
  }),
);

const credentials: readonly CredentialDescription[] = [
  { id: 'c-linear', kind: 'API_TOKEN', name: 'Linear token', hasSecret: true },
  { id: 'c-github', kind: 'API_TOKEN', name: 'GitHub token', hasSecret: true },
];

/** The host's side, logged to the console instead of reached. */
export const fakeApi: McpApi = {
  create: (project, input) => {
    console.info('mcp/v1.create', project, input);
    return Promise.resolve({
      ...linearServer,
      ...input,
      id: 's-new',
      projectId: project,
    });
  },
  update: (project, id, input) => {
    console.info('mcp/v1.update', project, id, input);
    return Promise.resolve({
      ...linearServer,
      ...input,
      id,
      projectId: project,
    });
  },
  remove: (project, id) => {
    console.info('mcp/v1.remove', project, id);
    return Promise.resolve();
  },
  signIn: (project, id) => {
    console.info('mcp/v1.signIn', project, id);
    return Promise.resolve('https://mcp.linear.app/authorize');
  },
  finishSignIn: (project, id) => {
    console.info('mcp/v1.finishSignIn', project, id);
    return Promise.resolve({ ...linearServer, id, signedIn: true });
  },
  openBrowser: (url) => {
    console.info('doric.browser/v1.open', url);
    return Promise.resolve();
  },
  credentials: () => Promise.resolve(credentials),
  createCredential: ({ name }) => {
    console.info('secrets/v1.create', name);
    return Promise.resolve({
      id: 'c-new',
      kind: 'API_TOKEN',
      name,
      hasSecret: true,
    });
  },
  watch: () => ({ dispose: () => undefined }),
};
