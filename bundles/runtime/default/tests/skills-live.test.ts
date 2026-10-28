import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestServices } from 'bundle/testing';
import type { ProviderMessage, ProviderRequest } from 'llms';
import type { ConfigurationValue, LeaseExecInput } from 'runtime/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

import { checkpointMarker } from '../src/host/compaction/markers.js';
import { defaultInstruction, loadedEntry } from './support/envelopes.js';
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
  skill,
  testConfiguration,
  thread,
  threadId,
} from './support/harness.js';
import {
  addedSkillsPrompt,
  changedWorkspaceSkillsPrompt,
  loadedSkillsPrompt,
  removedSkillsPrompt,
  serverSkillsPrompt,
  skillsChangedPrompt,
  systemPrompt,
} from './support/prompts.js';

/*
 * The skills a run can load follow the Thread while it runs. The system
 * prompt stays the one the run started with; before every request after the
 * first, the run reads the working directory and the MCP servers again and,
 * when the skills changed, tells the model in one "Skills changed" bundle
 * instruction. Skills loaded before a compaction stay in effect through one
 * retained "Loaded skills" message.
 */

const LOADED_KEY = 'default:loaded-skills';
const GUIDE_URI = 'skill://docs/guide/SKILL.md';

interface ToolCallStep {
  readonly name: string;
  readonly arguments: string;
}

const loading = (name: string): ToolCallStep => ({
  name: 'load_skill',
  arguments: JSON.stringify({ name }),
});

const inspecting: ToolCallStep = { name: 'inspect', arguments: '{}' };

/** One model turn of a scripted run. */
interface Turn {
  /** The calls the turn makes; none answers `done` and ends the run. */
  readonly calls?: readonly ToolCallStep[];
  /** The input tokens the turn reports, against a 1000-token window. */
  readonly inputTokens?: number;
  /** Runs when the turn's request arrives, before it is answered. */
  readonly before?: () => void;
}

interface RunEvent {
  readonly type: string;
  readonly call?: { readonly name: string };
  readonly result?: unknown;
}

/** Whether a request is the compaction summarizer's rather than the run's. */
const summarizing = (request: ProviderRequest): boolean =>
  !String(request.messages[0]?.content).startsWith(systemPrompt);

/**
 * A model that plays `turns` in order, one per run request, and answers every
 * summarizer request with `summary`.
 */
const scripted = (turns: readonly Turn[]) => {
  const requests: ProviderRequest[] = [];
  const summaries: ProviderRequest[] = [];
  const provider = {
    metadata: { id: 'provider', name: 'provider' },
    stream: async function* (request: ProviderRequest) {
      if (summarizing(request)) {
        summaries.push(request);
        yield {
          type: 'response.finished' as const,
          finish: {
            text: 'summary',
            finishReason: 'stop' as const,
            toolCalls: [],
          },
        };
        return;
      }
      requests.push(request);
      const at = requests.length;
      const turn = turns[at - 1];
      turn?.before?.();
      yield {
        type: 'response.started' as const,
        provider: 'provider',
        model: 'model',
        contextWindow: 1000,
      };
      yield {
        type: 'usage' as const,
        usage: { inputTokens: turn?.inputTokens ?? 10, outputTokens: 1 },
      };
      const calls = turn?.calls ?? [];
      yield {
        type: 'response.finished' as const,
        finish:
          calls.length === 0
            ? { text: 'done', finishReason: 'stop' as const, toolCalls: [] }
            : {
                text: '',
                finishReason: 'tool_calls' as const,
                toolCalls: calls.map((call, index) => ({
                  id: `call-${at}${calls.length === 1 ? '' : `-${index + 1}`}`,
                  ...call,
                })),
              },
      };
    },
  };
  return { provider, requests, summaries };
};

/** A tool the bundles registered, so a turn has something to call. */
const inspectTool = () => ({
  bundleId: 'tools-owner',
  alwaysAvailable: false,
  tool: defineTool({
    name: 'inspect',
    description: 'Inspect state.',
    input: z.object({}),
    output: z.object({}),
    execute: async () => ({}),
  }).bind(createTestServices({ bundle: { id: 'tools-owner' } }).services),
});

/** The configuration with compaction on, condensing only past the reported window's half. */
const compacting = (): ConfigurationValue =>
  ({
    ...testConfiguration(),
    execution: {
      maxTurns: 32,
      contextCompaction: {
        enabled: true,
        pressurePercent: 50,
        tailMinMessages: 2,
        summaryMaxChars: 6000,
        charBudget: 100_000_000,
      },
    },
  }) as ConfigurationValue;

/**
 * A sandbox whose `<directory>/.agents/skills` holds the named skills, each
 * described as `<name> description.`, and whose SKILL.md files read
 * `Follow <path>.`.
 */
const sandbox = (
  skills: Readonly<Record<string, readonly string[]>>,
): FakeLease => ({
  exec: (input: LeaseExecInput) => {
    const directory = String(input.cmd.at(-1)).replace(
      /\/\.agents\/skills$/u,
      '',
    );
    const names = skills[directory] ?? [];
    return {
      exitCode: 0,
      stdout: names
        .map(
          (name) => `${name}\0---\ndescription: ${name} description.\n---\n\0`,
        )
        .join(''),
      stderr: '',
    };
  },
  readFile: (path) =>
    `---\ndescription: Some description.\n---\n\nFollow ${path}.\n`,
});

/** The connected server "Docs", serving one skill, `guide`. */
const docs = mcpServer({
  id: 'server-1',
  name: 'Docs',
  skills: [
    { uri: GUIDE_URI, name: 'guide', description: 'Guide description.' },
  ],
});

const table = (...rows: readonly string[]): string =>
  ['| Skill | Description |', '| --- | --- |', ...rows].join('\n');

/** The "Skills changed" message with `parts` after its heading. */
const changed = (...parts: readonly string[]): ProviderMessage => ({
  role: 'user',
  content: defaultInstruction(
    'skills-changed',
    [skillsChangedPrompt, ...parts].join('\n\n'),
  ),
});

const removed = (...locators: readonly string[]): string =>
  `${removedSkillsPrompt}\n\n${locators.map((locator) => `- \`${locator}\``).join('\n')}`;

const isChange = (message: ProviderMessage | undefined): boolean =>
  String(message?.content).startsWith(
    '<bundle-instruction bundle="default" reason="skills-changed">',
  );

const isLoadedSkills = (message: ProviderMessage | undefined): boolean =>
  String(message?.content).startsWith(
    '<bundle-instruction bundle="default" reason="loaded-skills">',
  );

const toolNames = (request: ProviderRequest | undefined) =>
  request?.tools?.map(({ name }) => name);

/** One prompt run over the given model turns and boundary fakes. */
const run = async ({
  turns,
  skills = [],
  lease,
  mcp,
  workspace,
  configuration,
  state = fakeThreadState(),
}: {
  readonly turns: readonly Turn[];
  readonly skills?: readonly HarnessSkill[];
  readonly lease?: FakeLease;
  readonly mcp?: FakeMcp;
  readonly workspace?: FakeWorkspace;
  readonly configuration?: ConfigurationValue;
  readonly state?: ReturnType<typeof fakeThreadState>;
}) => {
  const model = scripted(turns);
  const services = bundleServices({
    provider: model.provider,
    skills,
    tools: [inspectTool()],
    ...(lease === undefined ? {} : { lease }),
    ...(mcp === undefined ? {} : { mcp }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(configuration === undefined ? {} : { configuration }),
  });
  await services.activate();
  const text = await runPrompt(services, state, 'do the task');
  const events = state.events.map(({ event }) => event as RunEvent);
  return {
    text,
    services,
    state,
    requests: model.requests,
    summaries: model.summaries,
    calls: services.calls,
    events,
    /** What each finished `load_skill` call answered, in order. */
    loaded: events
      .filter(
        ({ type, call }) =>
          type === 'tool.finished' && call?.name === 'load_skill',
      )
      .map(({ result }) => result),
    stored: () => state.parts().messages as readonly ProviderMessage[],
    retained: () =>
      (state.parts().meta as { retained?: Record<string, number> }).retained ??
      {},
  };
};

/** The Thread moves from `/workspace` (`local`, `shared`) to `/workspace/repo` (`fresh`, `shared`) during the first turn. */
const movingRun = async () => {
  let cwd = '/workspace';
  return run({
    skills: [skill('b', 'B body.', { alwaysAvailable: false })],
    lease: sandbox({
      '/workspace': ['local', 'shared'],
      '/workspace/repo': ['fresh', 'shared'],
    }),
    workspace: { cwd: () => cwd },
    turns: [
      {
        calls: [inspecting],
        before: () => {
          cwd = '/workspace/repo';
        },
      },
      {},
    ],
  });
};

/** The change `movingRun` tells the model about. */
const movedChange = changed(
  addedSkillsPrompt,
  `${changedWorkspaceSkillsPrompt}\n\n${table(
    '| cwd/fresh | fresh description. |',
    '| cwd/shared~2 | shared description. |',
  )}`,
  removed('cwd/local', 'cwd/shared'),
);

void test('D1 tells the model once about the skills of the directory the Thread moved to, after the tool result, with the system prompt unchanged', async () => {
  const { requests, calls } = await movingRun();

  assert.equal(requests.length, 2);
  const scans = calls.lease
    .filter(({ method }) => method === 'exec')
    .map(({ input }) => (input as LeaseExecInput).cmd.at(-1))
    .filter((directory) => String(directory).endsWith('/.agents/skills'));
  assert.deepEqual(scans, [
    '/workspace/.agents/skills',
    '/workspace/repo/.agents/skills',
  ]);
  const second = requests[1]?.messages ?? [];
  assert.equal(second.at(-2)?.role, 'tool');
  assert.deepEqual(second.at(-1), movedChange);
  assert.equal(second.filter(isChange).length, 1);
  assert.deepEqual(second[0], requests[0]?.messages[0]);
});

void test('D4 saves the change message in the history at the place the model read it', async () => {
  const { stored } = await movingRun();

  const messages = stored();
  assert.equal(messages.length, 5);
  assert.equal(messages[2]?.role, 'tool');
  assert.deepEqual(messages[3], movedChange);
  assert.equal(messages[4]?.role, 'assistant');
});

void test('D2 tells the model about the skills of a server that connected mid-run, and the next turn loads one', async () => {
  let servers: readonly (typeof docs)[] = [];
  const { requests, loaded } = await run({
    mcp: {
      list: () => servers,
      readSkill: () => ({
        text: '---\nname: guide\ndescription: Guide description.\n---\nFollow the guide.',
      }),
    },
    turns: [
      {
        calls: [inspecting],
        before: () => {
          servers = [docs];
        },
      },
      { calls: [loading('mcp/docs/guide')] },
      {},
    ],
  });

  assert.deepEqual(
    requests[1]?.messages.at(-1),
    changed(
      addedSkillsPrompt,
      `${serverSkillsPrompt}\n\n${table('| mcp/docs/guide | Guide description. |')}`,
    ),
  );
  assert.deepEqual(loaded, [
    [
      '# Skill: mcp/docs/guide',
      `From the MCP server "Docs" (\`${GUIDE_URI}\`). Its other files are not available.`,
      'Follow the guide.',
    ].join('\n\n'),
  ]);
});

void test('D2 reports a skill whose server went away, and loading it then fails naming the ids that remain', async () => {
  let servers: readonly (typeof docs)[] = [docs];
  const { requests, calls, events } = await run({
    skills: [skill('b', 'B body.', { alwaysAvailable: false })],
    mcp: { list: () => servers },
    turns: [
      {
        calls: [inspecting],
        before: () => {
          servers = [];
        },
      },
      { calls: [loading('mcp/docs/guide')] },
      {},
    ],
  });

  assert.deepEqual(
    requests[1]?.messages.at(-1),
    changed(removed('mcp/docs/guide')),
  );
  assert.ok(
    events.some(
      ({ type, call }) => type === 'tool.failed' && call?.name === 'load_skill',
    ),
  );
  assert.ok(
    String(requests[2]?.messages.at(-1)?.content).includes(
      'Unknown skill id "mcp/docs/guide". Call load_skill with one of: `b`.',
    ),
  );
  assert.equal(
    calls.mcp.filter(({ method }) => method === 'readSkill').length,
    0,
  );
});

void test('D3 offers load_skill from the first request after a skill appears in a run that started with none', async () => {
  let cwd = '/workspace';
  const { requests, loaded } = await run({
    lease: sandbox({ '/workspace/repo': ['local'] }),
    workspace: { cwd: () => cwd },
    turns: [
      {
        calls: [inspecting],
        before: () => {
          cwd = '/workspace/repo';
        },
      },
      { calls: [loading('cwd/local')] },
      {},
    ],
  });

  assert.deepEqual(toolNames(requests[0]), ['inspect']);
  assert.deepEqual(toolNames(requests[1]), ['inspect', 'load_skill']);
  assert.deepEqual(toolNames(requests[2]), ['inspect', 'load_skill']);
  const path = '/workspace/repo/.agents/skills/local/SKILL.md';
  assert.deepEqual(loaded, [
    [
      '# Skill: cwd/local',
      `From the workspace: \`${path}\`. Paths in it are relative to \`/workspace/repo/.agents/skills/local\`.`,
      `Follow ${path}.`,
    ].join('\n\n'),
  ]);
});

void test('D5 keeps a steer that arrives with a change its own message, and a final answer still ends the run', async () => {
  const state = fakeThreadState();
  let cwd = '/workspace';
  const { requests, events, text } = await run({
    state,
    lease: sandbox({
      '/workspace/repo': ['local'],
      '/workspace/other': ['other'],
    }),
    workspace: { cwd: () => cwd },
    turns: [
      {
        calls: [inspecting],
        before: () => {
          cwd = '/workspace/repo';
          state.steer('Also check the tests.');
        },
      },
      {
        // The Thread moves again while the model gives its final answer.
        before: () => {
          cwd = '/workspace/other';
        },
      },
    ],
  });

  assert.equal(text, 'done');
  assert.equal(requests.length, 2);
  const second = requests[1]?.messages ?? [];
  const toolAt = second.findIndex(({ role }) => role === 'tool');
  const after = second.slice(toolAt + 1);
  assert.equal(after.length, 2);
  assert.ok(
    after.some(
      ({ role, content }) =>
        role === 'user' &&
        content === '<user-request>\nAlso check the tests.\n</user-request>',
    ),
  );
  assert.equal(after.filter(isChange).length, 1);
  assert.equal(events.filter(({ type }) => type === 'agent.steered').length, 1);
});

void test('D6 changes nothing when the server list cannot be read mid-run', async () => {
  let failing = false;
  const { requests, loaded } = await run({
    mcp: {
      list: () => {
        if (failing) throw new Error('mcp/v1 is restarting');
        return [docs];
      },
      readSkill: () => ({ text: 'Follow the guide.' }),
    },
    turns: [
      {
        calls: [inspecting],
        before: () => {
          failing = true;
        },
      },
      { calls: [loading('mcp/docs/guide')] },
      {},
    ],
  });

  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.messages.filter(isChange).length, 0);
  }
  assert.equal(loaded.length, 1);
});

void test('D6 changes nothing and scans once when no runtime.workspace/v1 tells the working directory', async () => {
  const { requests, loaded, calls } = await run({
    lease: sandbox({ '/workspace': ['local'] }),
    turns: [{ calls: [inspecting] }, { calls: [loading('cwd/local')] }, {}],
  });

  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.messages.filter(isChange).length, 0);
  }
  assert.equal(
    calls.lease.filter(
      ({ method, input }) =>
        method === 'exec' &&
        String((input as LeaseExecInput).cmd.at(-1)).endsWith(
          '/.agents/skills',
        ),
    ).length,
    1,
  );
  assert.equal(loaded.length, 1);
});

/** The loaded-skills message holding the given skill texts. */
const loadedSkillsMessage = (...texts: readonly string[]): ProviderMessage => ({
  role: 'user',
  content: defaultInstruction(
    'loaded-skills',
    [loadedSkillsPrompt, ...texts.map(loadedEntry)].join('\n\n'),
  ),
});

void test('X1 keeps a skill loaded before an in-run compaction in a retained message after the summary', async () => {
  const { stored, retained, requests, loaded } = await run({
    configuration: compacting(),
    skills: [skill('b', 'B body.', { alwaysAvailable: false })],
    turns: [
      { calls: [loading('b')] },
      { calls: [inspecting] },
      // Past half the window: the history is condensed after this turn.
      { calls: [inspecting], inputTokens: 900 },
      { calls: [loading('b')] },
      {},
    ],
  });

  const messages = stored();
  assert.ok(String(messages[0]?.content).startsWith(checkpointMarker));
  assert.deepEqual(messages[1], loadedSkillsMessage('# Skill: b\n\nB body.'));
  assert.equal(retained()[LOADED_KEY], 1);
  assert.equal(messages[2]?.role, 'assistant');
  assert.equal(messages[2]?.toolCalls?.[0]?.id, 'call-2');
  // The request after the compaction carries it.
  assert.ok(
    (requests[3]?.messages ?? []).some(
      ({ content }) =>
        content === loadedSkillsMessage('# Skill: b\n\nB body.').content,
    ),
  );
  assert.deepEqual(loaded, [
    '# Skill: b\n\nB body.',
    'Skill b is already loaded above; follow it.',
  ]);
});

void test('X2 keeps exactly one loaded-skills message across repeated on-demand compactions, out of the summarizer input', async () => {
  const transcripts: string[] = [];
  const state = fakeThreadState();
  const { services, stored, retained, summaries } = await run({
    state,
    configuration: compacting(),
    skills: [skill('b', 'B body.', { alwaysAvailable: false })],
    turns: [
      { calls: [loading('b')] },
      { calls: [inspecting] },
      { calls: [inspecting] },
      { calls: [inspecting] },
      {},
    ],
  });
  const scope = { projectId, threadId, promptId };

  for (const tailMinMessages of [6, 2]) {
    const result = await services.executor(scope).compact({
      thread: thread(),
      session: state.session(`compaction-${tailMinMessages}`),
      policy: { tailMinMessages, summaryMaxChars: 6000 },
    });
    assert.equal(result.status, 'compacted');
    transcripts.push(String(summaries.at(-1)?.messages.at(-1)?.content));
    const messages = stored();
    assert.equal(messages.filter(isLoadedSkills).length, 1);
    assert.deepEqual(
      messages[retained()[LOADED_KEY] ?? -1],
      loadedSkillsMessage('# Skill: b\n\nB body.'),
    );
  }
  assert.ok(transcripts[0]?.includes('B body.'));
  assert.ok(!transcripts[1]?.includes('B body.'));
  assert.ok(!transcripts[1]?.includes('reason="loaded-skills"'));
});

void test('Q1 tells the model again about a change a compaction condensed away', async () => {
  let cwd = '/workspace';
  const { requests } = await run({
    configuration: compacting(),
    lease: sandbox({ '/workspace/repo': ['local'] }),
    workspace: { cwd: () => cwd },
    turns: [
      {
        calls: [inspecting],
        before: () => {
          cwd = '/workspace/repo';
        },
      },
      { calls: [inspecting] },
      // Past half the window: the change message is condensed after this turn.
      { calls: [inspecting], inputTokens: 900 },
      {},
    ],
  });

  const added = changed(
    addedSkillsPrompt,
    `${changedWorkspaceSkillsPrompt}\n\n${table('| cwd/local | local description. |')}`,
  );
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[1]?.messages.at(-1), added);
  assert.equal(requests[2]?.messages.filter(isChange).length, 1);
  const last = requests[3]?.messages ?? [];
  assert.ok(String(last[1]?.content).startsWith(checkpointMarker));
  assert.equal(last.filter(isChange).length, 1);
  assert.deepEqual(last.at(-1), added);
});
