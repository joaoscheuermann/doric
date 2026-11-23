import assert from 'node:assert/strict';
import test from 'node:test';

import { toJson } from '@bufbuild/protobuf';
import { isContractError } from 'bundle/contracts';
import type { LeaseExecInput } from 'runtime/contracts';

import { AgentSummarySchema } from '../src/contracts/gen/doric/default/agents/v1/agents_pb.js';
import { DefaultAgentsV1 } from '../src/contracts/index.js';
import type { AgentFile } from '../src/host/agents/built-in.js';
import {
  bundleServices,
  type FakeLease,
  type FakeWorkspace,
} from './support/harness.js';
import { routed, scope } from './support/router.js';
import { failureOf, scriptedModel } from './support/router-helpers.js';
import { plain } from './support/router-wire.js';

// `default`'s host part through the router (phase 3, slice S51d, contract §6,
// D24): `default.agents/v1` over the built-in agents and the workspace's own
// `.agents/agents/<name>.md`, read through `runtime.workspace/v1` and
// `runtime.lease/v1`, answering what the kernel service answers.

const AGENTS_DIR = '/.agents/agents';

/** An agent file: its frontmatter lines, a blank line, then its body. */
const agentText = (frontmatter: readonly string[], body: string): string =>
  `---\n${frontmatter.join('\n')}\n---\n\n${body}\n`;

/** A built-in agent file `/doric/agents/<name>.md`. */
const builtIn = (name: string, description: string): AgentFile => ({
  path: `/doric/agents/${name}.md`,
  text: agentText([`description: ${description}`], `Built-in ${name} body.`),
});

/** One record of the agents scan: basename, size in bytes, first 4096 bytes. */
const agentRecord = (basename: string, text: string): string => {
  const bytes = Buffer.from(text, 'utf8');
  return `${basename}\0${bytes.length}\0${bytes.subarray(0, 4096).toString('utf8')}\0`;
};

/** A sandbox whose `/workspace/.agents/agents` holds `files` (by basename). */
const sandbox = (files: Readonly<Record<string, string>>): FakeLease => ({
  exec: (input: LeaseExecInput) => {
    if (!String(input.cmd.at(-1)).endsWith(AGENTS_DIR)) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return {
      exitCode: 0,
      stdout: Object.keys(files)
        .sort()
        .map((basename) => agentRecord(basename, files[basename] ?? ''))
        .join(''),
      stderr: '',
    };
  },
  readFile: (path) => {
    const basename = path.slice(`/workspace${AGENTS_DIR}/`.length);
    const text = files[basename];
    if (text === undefined) throw new Error(`No such file: ${path}`);
    return text;
  },
});

const builtIns = [builtIn('alpha', 'Alpha.')];
const workspaceFiles = {
  'beta.md': agentText(['description: Beta.', 'model: m1'], 'Beta body.'),
  'broken.md': agentText(['model: m1'], 'No description.'),
};

/** The kernel `default.agents/v1` over the same scenario, under the prompt's scope. */
const kernelAgents = (options: {
  readonly lease?: FakeLease;
  readonly workspace?: FakeWorkspace;
}) => {
  const services = bundleServices({
    provider: scriptedModel([]).provider,
    builtInAgents: builtIns,
    ...options,
  });
  services.activate();
  return services.harness.services.use(DefaultAgentsV1, scope);
};

/** `default.agents/v1` of the host part over the same scenario, activated. */
const routedAgents = async (
  t: test.TestContext,
  options: { readonly lease?: FakeLease; readonly workspace?: FakeWorkspace },
) => {
  const host = routed({
    provider: scriptedModel([]).provider,
    builtInAgents: builtIns,
    ...options,
  });
  t.after(() => host.router.control.stop());
  await host.activate();
  return host.agents;
};

void test('D24 List with the working directory unknown answers the built-in agents', async (t) => {
  const workspace: FakeWorkspace = {
    cwd: () => {
      throw new Error('No Thread session.');
    },
  };
  const expected = await kernelAgents({ workspace }).list();
  const agents = await routedAgents(t, { workspace });

  const { agents: listed } = await agents.list({});

  assert.deepEqual(
    listed.map((agent) => toJson(AgentSummarySchema, agent)),
    plain(expected),
  );
  assert.deepEqual(
    listed.map(({ name }) => name),
    ['alpha'],
  );
});

void test('D24 List with a workspace answers today’s effective agents', async (t) => {
  const options = {
    lease: sandbox(workspaceFiles),
    workspace: { cwd: () => '/workspace' },
  };
  const expected = await kernelAgents(options).list();
  const agents = await routedAgents(t, options);

  const { agents: listed } = await agents.list({});

  assert.deepEqual(
    listed.map((agent) => toJson(AgentSummarySchema, agent)),
    plain(expected),
  );
  assert.deepEqual(
    listed.map(({ name }) => name),
    ['alpha', 'beta'],
  );
});

void test('D24 Resolve of an unknown name fails not_found naming every valid agent', async (t) => {
  const options = {
    lease: sandbox(workspaceFiles),
    workspace: { cwd: () => '/workspace' },
  };
  const agents = await routedAgents(t, options);

  const error = await failureOf(agents.resolve({ name: 'nope' }));

  assert.ok(isContractError(error), String(error));
  assert.equal(error.code, 'not_found');
  assert.deepEqual(error.details, { name: 'nope', agents: ['alpha', 'beta'] });
});

void test('D24 Resolve of an invalid workspace file fails invalid_definition as the kernel does', async (t) => {
  const options = {
    lease: sandbox(workspaceFiles),
    workspace: { cwd: () => '/workspace' },
  };
  const expected = await failureOf(
    kernelAgents(options).resolve({ name: 'broken' }),
  );
  const agents = await routedAgents(t, options);

  const error = await failureOf(agents.resolve({ name: 'broken' }));

  assert.equal(error.code, 'invalid_definition');
  assert.equal(error.message, expected.message);
  assert.deepEqual(plain(error.details), plain(expected.details));
});
