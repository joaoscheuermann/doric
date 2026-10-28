import assert from 'node:assert/strict';
import test from 'node:test';

import { HooksV1, type RegisteredTool } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import type { ProviderMessage, ProviderRequest } from 'llms';
import type { ConfigurationValue } from 'runtime/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

import { DefaultHooksV1 } from '../src/contracts/index.js';
import { systemPromptWith } from '../src/host/executor.js';
import {
  alwaysAvailableSkillsPrompt,
  builtInSkillsPrompt,
  loadSkillNamePrompt,
  loadSkillPrompt,
  serverSkillsPrompt,
  skillsPrompt,
  skillsToLoadPrompt,
  workspaceSkillsPrompt,
} from '../src/host/prompts/skills.js';
import {
  loadCall,
  skillText,
  toolFailure,
  toolResult,
} from './support/envelopes.js';
import {
  bundleServices,
  type FakeLease,
  type FakeMcp,
  type FakeWorkspace,
  fakeThreadState,
  type HarnessSkill,
  mcpServer,
  projectId,
  promptId,
  runPrompt,
  seedHistory,
  skill,
  testConfiguration,
  threadId,
} from './support/harness.js';

/*
 * A prompt run offers the skills it lists in its system prompt through one
 * tool of its own, `load_skill`, last among the run's tools. Calling it reads
 * the named skill — a bundle body, a workspace SKILL.md through the prompt's
 * sandbox lease, or an MCP server's skill through `mcp/v1` — and answers its
 * instructions.
 */

const SKILL_PATH = '/workspace/.agents/skills/local/SKILL.md';
const GUIDE_URI = 'skill://docs/guide/SKILL.md';

/** The skills/v1 skills of most runs: one always available, one to load. */
const bundled: readonly HarnessSkill[] = [
  skill('always', 'Always body.'),
  skill('b', 'B body.', { alwaysAvailable: false }),
];

/** A sandbox whose working directory holds one skill, `local`. */
const workspaceLease = (
  readFile: FakeLease['readFile'] = () =>
    '---\nname: local\ndescription: Local description.\n---\n\nFollow the local steps.\n',
): FakeLease => ({
  exec: () => ({
    exitCode: 0,
    stdout: 'local\0---\nname: local\ndescription: Local description.\n---\n\0',
    stderr: '',
  }),
  readFile,
});

/** One connected server, "Docs", serving one skill, `guide`. */
const docsServer = (
  readSkill: FakeMcp['readSkill'] = () => ({
    text: '---\nname: guide\ndescription: Guide description.\n---\nFollow the guide.',
  }),
): FakeMcp => ({
  list: () => [
    mcpServer({
      id: 'server-1',
      name: 'Docs',
      skills: [
        { uri: GUIDE_URI, name: 'guide', description: 'Guide description.' },
      ],
    }),
  ],
  readSkill,
});

const table = (...rows: readonly string[]): string =>
  ['| Skill | Description |', '| --- | --- |', ...rows].join('\n');

/** The section the run of `bundled`, `workspaceLease` and `docsServer` renders. */
const section = [
  skillsPrompt,
  alwaysAvailableSkillsPrompt,
  '### Skill: always\n\nAlways body.',
  skillsToLoadPrompt,
  `${builtInSkillsPrompt}\n\n${table('| b | b description |')}`,
  `${workspaceSkillsPrompt}\n\n${table('| cwd/local | Local description. |')}`,
  `${serverSkillsPrompt}\n\n${table('| mcp/docs/guide | Guide description. |')}`,
].join('\n\n');

interface ToolCallStep {
  readonly name: string;
  readonly arguments: string;
}

const loading = (name: string): ToolCallStep => ({
  name: 'load_skill',
  arguments: JSON.stringify({ name }),
});

interface RunEvent {
  readonly type: string;
  readonly call?: { readonly name: string };
  readonly result?: unknown;
}

/** A tool the bundles registered, so `load_skill` has one to follow. */
const inspectTool = () =>
  defineTool({
    name: 'inspect',
    description: 'Inspect state.',
    input: z.object({}),
    output: z.object({}),
    execute: async () => ({}),
  }).bind(createTestServices({ bundle: { id: 'tools-owner' } }).services);

const inspecting: ToolCallStep = { name: 'inspect', arguments: '{}' };

/** A registered tool whose result is 500 characters long. */
const longTool = (): RegisteredTool => ({
  bundleId: 'tools-owner',
  alwaysAvailable: false,
  tool: defineTool({
    name: 'long',
    description: 'Answer a long text.',
    input: z.object({}),
    output: z.string(),
    execute: async () => 'y'.repeat(500),
  }).bind(createTestServices({ bundle: { id: 'tools-owner' } }).services),
});

/**
 * One prompt run whose model makes the given tool calls, one per turn, then
 * answers; `onActivated` runs once the bundle is active, before the prompt.
 * `seed` is the history an earlier prompt left.
 */
const run = async ({
  skills = bundled,
  lease,
  mcp,
  workspace,
  configuration,
  tools = [],
  seed,
  steps = [],
  onActivated,
}: {
  readonly skills?: readonly HarnessSkill[];
  readonly lease?: FakeLease;
  readonly mcp?: FakeMcp;
  readonly workspace?: FakeWorkspace;
  readonly configuration?: ConfigurationValue;
  readonly tools?: readonly RegisteredTool[];
  readonly seed?: readonly ProviderMessage[];
  readonly steps?: readonly ToolCallStep[];
  readonly onActivated?: (services: ReturnType<typeof bundleServices>) => void;
}) => {
  const requests: ProviderRequest[] = [];
  const provider = {
    metadata: { id: 'provider', name: 'provider' },
    stream: async function* (request: ProviderRequest) {
      requests.push(request);
      const step = steps[requests.length - 1];
      yield {
        type: 'response.finished' as const,
        finish:
          step === undefined
            ? { text: 'done', finishReason: 'stop' as const, toolCalls: [] }
            : {
                text: '',
                finishReason: 'tool_calls' as const,
                toolCalls: [{ id: `call-${requests.length}`, ...step }],
              },
      };
    },
  };
  const services = bundleServices({
    provider,
    skills,
    tools: [
      { bundleId: 'tools-owner', alwaysAvailable: false, tool: inspectTool() },
      ...tools,
    ],
    ...(lease === undefined ? {} : { lease }),
    ...(mcp === undefined ? {} : { mcp }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(configuration === undefined ? {} : { configuration }),
  });
  await services.activate();
  onActivated?.(services);
  const state = fakeThreadState();
  if (seed !== undefined) {
    seedHistory(state, {
      messages: seed,
      checkpoints: { 'earlier-prompt': 0 },
    });
  }
  await runPrompt(services, state, 'do the task');
  const events = state.events.map(({ event }) => event as RunEvent);
  return {
    requests,
    calls: services.calls,
    events,
    /** What each finished `load_skill` call answered, in order. */
    loaded: events
      .filter(
        ({ type, call }) =>
          type === 'tool.finished' && call?.name === 'load_skill',
      )
      .map(({ result }) => result),
  };
};

const toolNames = (request: ProviderRequest | undefined) =>
  request?.tools?.map(({ name }) => name);

void test('T1 offers no load_skill when the run lists no skill to load and nothing changes', async () => {
  const onlyAlways = await run({
    skills: [skill('always', 'Always body.')],
    steps: [inspecting],
  });
  const noSkill = await run({ skills: [], steps: [inspecting] });

  assert.equal(onlyAlways.requests.length, 2);
  for (const request of [...onlyAlways.requests, ...noSkill.requests]) {
    assert.deepEqual(toolNames(request), ['inspect']);
  }
});

void test('T2 offers load_skill last, taking a plain string name, and lists the skills without their bodies', async () => {
  const { requests } = await run({
    lease: workspaceLease(),
    mcp: docsServer(),
  });

  const tools = requests[0]?.tools ?? [];
  const loadSkill = tools.at(-1);
  assert.deepEqual(toolNames(requests[0]), ['inspect', 'load_skill']);
  assert.equal(loadSkill?.description, loadSkillPrompt);
  const properties = loadSkill?.inputSchema.properties as
    | Record<string, unknown>
    | undefined;
  // No enum: the skills a run can load change while it runs.
  assert.deepEqual(properties?.name, {
    type: 'string',
    description: loadSkillNamePrompt,
  });
  const system = requests[0]?.messages[0]?.content as string;
  assert.ok(system.includes('Always body.'));
  assert.ok(system.includes('| b | b description |'));
  assert.ok(!system.includes('B body.'));
});

void test('T3 answers a bundle skill with its body under a Skill heading', async () => {
  const { loaded } = await run({ steps: [loading('b')] });

  assert.deepEqual(loaded, ['# Skill: b\n\nB body.']);
});

void test('T4 reads a workspace skill through the lease under the prompt call and answers it with its source and without frontmatter', async () => {
  const { loaded, calls } = await run({
    lease: workspaceLease(),
    steps: [loading('cwd/local')],
  });

  assert.deepEqual(
    calls.lease.filter(({ method }) => method === 'readFile'),
    [
      {
        method: 'readFile',
        input: SKILL_PATH,
        scope: { projectId, threadId, promptId },
      },
    ],
  );
  assert.deepEqual(loaded, [
    [
      '# Skill: cwd/local',
      `From the workspace: \`${SKILL_PATH}\`. Paths in it are relative to \`/workspace/.agents/skills/local\`.`,
      'Follow the local steps.',
    ].join('\n\n'),
  ]);
});

void test('T5 reads an MCP skill through mcp/v1 only when it is loaded, and answers it with its source and without frontmatter', async () => {
  const idle = await run({ mcp: docsServer() });
  const { loaded, calls } = await run({
    mcp: docsServer(),
    steps: [loading('mcp/docs/guide')],
  });

  assert.equal(
    idle.calls.mcp.filter(({ method }) => method === 'readSkill').length,
    0,
  );
  assert.deepEqual(
    calls.mcp
      .filter(({ method }) => method === 'readSkill')
      .map(({ input }) => input),
    [{ id: 'server-1', uri: GUIDE_URI }],
  );
  assert.deepEqual(loaded, [
    [
      '# Skill: mcp/docs/guide',
      `From the MCP server "Docs" (\`${GUIDE_URI}\`). Its other files are not available.`,
      'Follow the guide.',
    ].join('\n\n'),
  ]);
});

void test('T6 answers a skill that cannot be read with a tool failure naming it, and the run goes on', async () => {
  const { requests, events } = await run({
    lease: workspaceLease(() => Promise.reject(new Error('file gone'))),
    mcp: docsServer(() => Promise.reject(new Error('server gone'))),
    steps: [loading('mcp/docs/guide'), loading('cwd/local')],
  });

  assert.equal(requests.length, 3);
  assert.ok(
    String(requests[1]?.messages.at(-1)?.content).includes(
      'The skill mcp/docs/guide could not be loaded:',
    ),
  );
  assert.ok(
    String(requests[2]?.messages.at(-1)?.content).includes(
      'The skill cwd/local could not be loaded:',
    ),
  );
  assert.equal(
    events.filter(
      ({ type, call }) => type === 'tool.failed' && call?.name === 'load_skill',
    ).length,
    2,
  );
});

void test('T7 caps a loaded skill at 64000 characters', async () => {
  const body = 'x'.repeat(70_000);
  const { loaded } = await run({
    skills: [skill('big', body, { alwaysAvailable: false })],
    steps: [loading('big')],
  });

  assert.deepEqual(loaded, [
    `${`# Skill: big\n\n${body}`.slice(0, 64_000)}...`,
  ]);
});

void test('T8 answers a name the list does not hold with a tool failure naming the valid ids, without reading anything', async () => {
  const { requests, events, calls } = await run({
    lease: workspaceLease(),
    mcp: docsServer(),
    steps: [loading('cwd/missing')],
  });

  assert.equal(toolNames(requests[0])?.at(-1), 'load_skill');
  // The call fails like any tool; the run goes on with the next request.
  assert.equal(requests.length, 2);
  assert.ok(
    events.some(
      ({ type, call }) => type === 'tool.failed' && call?.name === 'load_skill',
    ),
  );
  assert.ok(
    !events.some(
      ({ type, call }) =>
        type === 'tool.finished' && call?.name === 'load_skill',
    ),
  );
  // The failure is the call's answer, with no correction message after it.
  const answered = requests[1]?.messages ?? [];
  assert.equal(answered.length, 4);
  assert.equal(answered.at(-1)?.role, 'tool');
  assert.ok(
    String(answered.at(-1)?.content).includes(
      'Unknown skill id "cwd/missing". Call load_skill with one of: `b`, `cwd/local`, `mcp/docs/guide`.',
    ),
  );
  assert.equal(
    calls.lease.filter(({ method }) => method === 'readFile').length,
    0,
  );
  assert.equal(
    calls.mcp.filter(({ method }) => method === 'readSkill').length,
    0,
  );
});

void test('E1 reads the skills once per run and sends every request the same system prompt and tools', async () => {
  const seen: string[] = [];
  const { requests, calls } = await run({
    lease: workspaceLease(),
    mcp: docsServer(),
    // The Thread stays in the directory the prompt started in.
    workspace: { cwd: () => '/workspace' },
    steps: [loading('b')],
    onActivated: (services) => {
      services.harness.services
        .use(HooksV1)
        .use(DefaultHooksV1)
        .onBeforeModelRequestHook(({ system }) => {
          seen.push(system);
          return { system };
        });
    },
  });

  const system = systemPromptWith(section);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.deepEqual(request.messages[0], { role: 'system', content: system });
    assert.deepEqual(request.tools, requests[0]?.tools);
    assert.ok(
      request.messages.every(
        ({ content }) => !String(content).includes('reason="skills-changed"'),
      ),
    );
  }
  assert.deepEqual(seen, [system, system]);
  // The working directory did not move: the workspace is scanned once.
  assert.equal(calls.lease.filter(({ method }) => method === 'exec').length, 1);
  // The servers are listed at the start and before the later request.
  assert.equal(calls.mcp.filter(({ method }) => method === 'list').length, 2);
});

void test('K1 answers a second load of an unchanged skill with a note, reading it again each time', async () => {
  const { loaded, calls } = await run({
    lease: workspaceLease(),
    steps: [loading('cwd/local'), loading('cwd/local')],
  });

  assert.deepEqual(loaded, [
    [
      '# Skill: cwd/local',
      `From the workspace: \`${SKILL_PATH}\`. Paths in it are relative to \`/workspace/.agents/skills/local\`.`,
      'Follow the local steps.',
    ].join('\n\n'),
    'Skill cwd/local is already loaded above; follow it.',
  ]);
  assert.equal(
    calls.lease.filter(({ method }) => method === 'readFile').length,
    2,
  );
});

void test('K1 answers the whole new text when the skill changed since it was loaded', async () => {
  const versions = ['Follow the local steps.', 'Follow the new local steps.'];
  let reads = 0;
  const { loaded } = await run({
    lease: workspaceLease(() => {
      const body = versions[Math.min(reads, versions.length - 1)];
      reads += 1;
      return `---\ndescription: Local description.\n---\n\n${body}\n`;
    }),
    steps: [loading('cwd/local'), loading('cwd/local')],
  });

  const source = `From the workspace: \`${SKILL_PATH}\`. Paths in it are relative to \`/workspace/.agents/skills/local\`.`;
  assert.deepEqual(loaded, [
    ['# Skill: cwd/local', source, 'Follow the local steps.'].join('\n\n'),
    ['# Skill: cwd/local', source, 'Follow the new local steps.'].join('\n\n'),
  ]);
});

void test('K2 answers the note for a skill an earlier prompt of the Thread loaded', async () => {
  const { loaded } = await run({
    seed: [
      { role: 'user', content: '<user-request>\nearlier\n</user-request>' },
      loadCall('old-1', 'b'),
      toolResult('old-1', skillText('b', 'B body.')),
      { role: 'assistant', content: 'done' },
    ],
    steps: [loading('b')],
  });

  assert.deepEqual(loaded, ['Skill b is already loaded above; follow it.']);
});

void test('K2 answers the whole skill when the earlier load failed or was interrupted', async () => {
  const failed = await run({
    seed: [
      { role: 'user', content: '<user-request>\nearlier\n</user-request>' },
      loadCall('old-1', 'b'),
      toolFailure('old-1', 'The skill b could not be loaded: gone'),
      { role: 'assistant', content: 'done' },
    ],
    steps: [loading('b')],
  });
  const interrupted = await run({
    seed: [
      { role: 'user', content: '<user-request>\nearlier\n</user-request>' },
      loadCall('old-1', 'b'),
      toolResult('old-1', skillText('b', 'B body.'), 'incomplete'),
      { role: 'assistant', content: 'done' },
    ],
    steps: [loading('b')],
  });

  assert.deepEqual(failed.loaded, ['# Skill: b\n\nB body.']);
  assert.deepEqual(interrupted.loaded, ['# Skill: b\n\nB body.']);
});

void test('K3 sends a loaded skill whole past the tool result cap, which still caps the other tools', async () => {
  const body = 'z'.repeat(5000);
  const { requests } = await run({
    configuration: {
      ...testConfiguration(),
      execution: { maxTurns: 32, maxToolResultChars: 100 },
    },
    skills: [skill('big', body, { alwaysAvailable: false })],
    tools: [longTool()],
    steps: [loading('big'), { name: 'long', arguments: '{}' }],
  });

  assert.equal(requests.length, 3);
  const results = (requests[2]?.messages ?? []).filter(
    ({ role }) => role === 'tool',
  );
  assert.equal(results.length, 2);
  assert.ok(String(results[0]?.content).includes(`# Skill: big\n\n${body}`));
  assert.ok(String(results[1]?.content).includes('y'.repeat(100)));
  assert.ok(!String(results[1]?.content).includes('y'.repeat(101)));
});
