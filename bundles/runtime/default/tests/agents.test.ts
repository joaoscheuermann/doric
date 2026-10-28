import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestServices } from 'bundle/testing';
import type { ProviderMessage, ProviderRequest } from 'llms';
import type {
  ConfigurationValue,
  LeaseExecInput,
  LeaseExecResult,
} from 'runtime/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

import {
  type AgentDefinition,
  type AgentSummary,
  DefaultAgentsV1,
} from '../src/contracts/index.js';
import {
  type AgentFile,
  builtInAgentFiles,
} from '../src/host/agents/built-in.js';
import { checkpointMarker } from '../src/host/compaction/markers.js';
import { systemPromptWith } from '../src/host/executor.js';
import { render } from '../src/host/prompts/templates.js';
import { defaultInstruction } from './support/envelopes.js';
import {
  bundleServices,
  type FakeLease,
  type FakeWorkspace,
  fakeThreadState,
  type HarnessSkill,
  harnessVariables,
  projectId,
  promptId,
  type RecordedCall,
  runPrompt,
  sandboxSection,
  skill,
  testConfiguration,
  threadId,
} from './support/harness.js';
import { systemPrompt } from './support/prompts.js';

/*
 * Agent definitions (DORIC-72): the built-in agents shipped with the bundle
 * and the workspace's own `.agents/agents/<name>.md` files, served through
 * `default.agents/v1` and listed to the model in the system prompt's
 * `# Agents` catalog, which follows the Thread's working directory while a
 * run goes on.
 */

/** The prompt every agent call and run is scoped to. */
const scope = { projectId, threadId, promptId };

const AGENTS_DIR = '/.agents/agents';
const SKILLS_DIR = '/.agents/skills';

/** An agent file: its frontmatter lines, a blank line, then its body. */
const agentText = (frontmatter: readonly string[], body: string): string =>
  `---\n${frontmatter.join('\n')}\n---\n\n${body}\n`;

/** A built-in agent file `/doric/agents/<name>.md`. */
const builtIn = (
  name: string,
  description: string,
  body = `Built-in ${name} body.`,
): AgentFile => ({
  path: `/doric/agents/${name}.md`,
  text: agentText([`description: ${description}`], body),
});

/** One record of the agents scan: basename, size in bytes, first 4096 bytes. */
const agentRecord = (basename: string, text: string): string => {
  const bytes = Buffer.from(text, 'utf8');
  return `${basename}\0${bytes.length}\0${bytes.subarray(0, 4096).toString('utf8')}\0`;
};

/** A skill record of the skills scan, described as `<name> description.`. */
const skillRecord = (name: string): string =>
  `${name}\0---\ndescription: ${name} description.\n---\n\0`;

const exited = (stdout: string): LeaseExecResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
});

/** Directory → the files of its `.agents/agents`, by basename. */
type AgentDirs = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * A sandbox answering the scan of `<dir>/.agents/agents` with the records of
 * `agents[dir]` (sorted by basename, as the shell's glob yields them), the
 * scan of `<dir>/.agents/skills` with the skills of `skills[dir]`, and
 * `readFile` with the agent files. It has no `describe`, so no OS probe runs.
 */
const sandbox = (
  agents: AgentDirs,
  skills: Readonly<Record<string, readonly string[]>> = {},
): FakeLease => ({
  exec: (input: LeaseExecInput) => {
    const directory = String(input.cmd.at(-1));
    if (directory.endsWith(AGENTS_DIR)) {
      const files = agents[directory.slice(0, -AGENTS_DIR.length)] ?? {};
      return exited(
        Object.keys(files)
          .sort()
          .map((basename) => agentRecord(basename, files[basename] ?? ''))
          .join(''),
      );
    }
    if (directory.endsWith(SKILLS_DIR)) {
      const names = skills[directory.slice(0, -SKILLS_DIR.length)] ?? [];
      return exited(names.map(skillRecord).join(''));
    }
    throw new Error(`Unexpected exec: ${input.cmd.join(' ')}`);
  },
  readFile: (path) => {
    for (const [directory, files] of Object.entries(agents)) {
      for (const [basename, text] of Object.entries(files)) {
        if (`${directory}${AGENTS_DIR}/${basename}` === path) return text;
      }
    }
    throw new Error(`No such file: ${path}`);
  },
});

/** The exec calls that scanned `directory`'s agents. */
const agentScans = (
  calls: readonly RecordedCall[],
  directory = '/workspace',
): readonly RecordedCall[] =>
  calls.filter(
    ({ method, input }) =>
      method === 'exec' &&
      (input as LeaseExecInput).cmd.at(-1) === `${directory}${AGENTS_DIR}`,
  );

/**
 * The `default` bundle activated over `lease`, a working directory `cwd`
 * (null: no `runtime.workspace/v1`) and `builtInAgents`, with
 * `default.agents/v1` used under the prompt's scope.
 */
const agentServices = ({
  lease,
  cwd = '/workspace',
  builtInAgents,
}: {
  readonly lease?: FakeLease;
  readonly cwd?: string | null;
  readonly builtInAgents?: readonly AgentFile[];
}) => {
  const services = bundleServices({
    provider: scripted([]).provider,
    ...(lease === undefined ? {} : { lease }),
    ...(cwd === null ? {} : { workspace: { cwd: () => cwd } }),
    ...(builtInAgents === undefined ? {} : { builtInAgents }),
  });
  services.activate();
  return {
    calls: services.calls,
    agents: services.harness.services.use(DefaultAgentsV1, scope),
  };
};

interface ToolCallStep {
  readonly name: string;
  readonly arguments: string;
}

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

/** Whether a request is the compaction summarizer's rather than the run's. */
const summarizing = (request: ProviderRequest): boolean =>
  !String(request.messages[0]?.content).startsWith(systemPrompt);

/**
 * A model that plays `turns` in order, one per run request, and answers every
 * summarizer request with `summary`.
 */
function scripted(turns: readonly Turn[]) {
  const requests: ProviderRequest[] = [];
  const provider = {
    metadata: { id: 'provider', name: 'provider' },
    stream: async function* (request: ProviderRequest) {
      if (summarizing(request)) {
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
                  id: `call-${at}-${index + 1}`,
                  ...call,
                })),
              },
      };
    },
  };
  return { provider, requests };
}

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

/** One prompt run over the given model turns and boundary fakes. */
const run = async ({
  turns = [{}],
  lease,
  workspace,
  builtInAgents,
  skills = [],
  configuration,
}: {
  readonly turns?: readonly Turn[];
  readonly lease?: FakeLease;
  readonly workspace?: FakeWorkspace;
  readonly builtInAgents?: readonly AgentFile[];
  readonly skills?: readonly HarnessSkill[];
  readonly configuration?: ConfigurationValue;
}) => {
  const model = scripted(turns);
  const state = fakeThreadState();
  const services = bundleServices({
    provider: model.provider,
    skills,
    tools: [inspectTool()],
    ...(lease === undefined ? {} : { lease }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(builtInAgents === undefined ? {} : { builtInAgents }),
    ...(configuration === undefined ? {} : { configuration }),
  });
  services.activate();
  const text = await runPrompt(services, state, 'do the task');
  return {
    text,
    requests: model.requests,
    calls: services.calls,
    /** The system prompt of the run's first request. */
    system: () => model.requests[0]?.messages[0],
    retained: () =>
      (state.parts().meta as { retained?: Record<string, number> }).retained ??
      {},
  };
};

const agentsTable = (...rows: readonly string[]): string =>
  ['| Agent | Description |', '| --- | --- |', ...rows].join('\n');

/** The `# Agents` section with `rows` shown and `dropped` more left out. */
const agentsSection = (rows: readonly string[], dropped = 0): string =>
  [
    '# Agents',
    'The agents defined for this thread, each by its name and a description of when to use it.',
    agentsTable(...rows),
    ...(dropped === 0
      ? []
      : [`${dropped} more ${dropped === 1 ? 'agent' : 'agents'} did not fit.`]),
  ].join('\n\n');

/** The "Agents changed" bundle instruction with `sections` after its heading. */
const agentsChanged = (...sections: readonly string[]): ProviderMessage => ({
  role: 'user',
  content: defaultInstruction(
    'agents-changed',
    [
      '# Agents changed',
      'The agents defined for this thread changed with its working directory. This message updates the agents listed in your instructions and in earlier "Agents changed" messages.',
      ...sections,
    ].join('\n\n'),
  ),
});

const addedOrChanged = (...rows: readonly string[]): string =>
  `## Added or changed\n\n${agentsTable(...rows)}`;

const noLongerAvailable = (...names: readonly string[]): string =>
  `## No longer available\n\n${names.map((name) => `- \`${name}\``).join('\n')}`;

const isAgentsChange = (message: ProviderMessage | undefined): boolean =>
  String(message?.content).startsWith(
    '<bundle-instruction bundle="default" reason="agents-changed">',
  );

const isSkillsChange = (message: ProviderMessage | undefined): boolean =>
  String(message?.content).startsWith(
    '<bundle-instruction bundle="default" reason="skills-changed">',
  );

/** The `excerpt` cap the skill catalog gives a description. */
const capped = (description: string, max = 500): string =>
  description.length <= max ? description : `${description.slice(0, max)}...`;

const invalidReason = {
  noDescription: 'the frontmatter has no description',
  turbo:
    'effort "turbo" is not one of none, minimal, low, medium, high, xhigh, max',
  tooLarge: 'the file is larger than 64000 bytes',
  secrets:
    'the instructions cite "secrets.TOKEN", which is not a prompt variable (os, date, timezone, user, user.name); to write literal mustache tags, switch delimiters with {{=<% %>=}}',
};

/** The `invalid_definition` error of the workspace agent `name` under `/workspace`. */
const invalidDefinition = (name: string, reason: string) => ({
  code: 'invalid_definition',
  message: `Agent "${name}" is invalid: ${reason}.`,
  details: {
    name,
    path: `/workspace${AGENTS_DIR}/${name}.md`,
    reason,
  },
});

const fooText = agentText(
  [
    'name: ignored',
    'description: Foo does F.',
    'model: m1',
    'effort: high',
    'color: blue',
  ],
  'Work on {{ os }} as of {{ date }} ({{ timezone }}).\n\nGreet {{ user.name }}.',
);

void test('AG1 lists a valid workspace agent and the run lists it in # Agents, between # Environment and # Skills, from one scan at its start', async () => {
  const lease = sandbox({ '/workspace': { 'foo.md': fooText } });

  const { requests, calls, system } = await run({
    lease,
    skills: [skill('sandbox', 'Inspect before reporting.')],
  });

  assert.equal(requests.length, 1);
  const content = String(system()?.content);
  assert.equal(
    content,
    systemPromptWith(
      harnessVariables,
      `${agentsSection(['| foo | Foo does F. |'])}\n\n${sandboxSection}`,
    ),
  );
  const environmentAt = content.indexOf('# Environment');
  const agentsAt = content.indexOf('# Agents');
  const skillsAt = content.indexOf('# Skills');
  assert.ok(environmentAt !== -1 && environmentAt < agentsAt);
  assert.ok(agentsAt < skillsAt);

  const scans = agentScans(calls.lease);
  assert.equal(scans.length, 1);
  const input = scans[0]?.input as LeaseExecInput;
  assert.equal(input.cmd.length, 5);
  assert.deepEqual(
    [input.cmd[0], input.cmd[1], input.cmd[3], input.cmd[4]],
    ['sh', '-c', 'sh', '/workspace/.agents/agents'],
  );
  assert.equal(typeof input.cmd[2], 'string');
  assert.equal(input.timeoutMs, 5000);
  assert.deepEqual(scans[0]?.scope, scope);

  const { agents } = agentServices({ lease });
  const expected: readonly AgentSummary[] = [
    {
      name: 'foo',
      description: 'Foo does F.',
      source: 'workspace',
      model: 'm1',
      effort: 'high',
    },
  ];
  assert.deepEqual(await agents.list(), expected);
});

void test('AG1b caps catalog descriptions at 500 characters, keeps the built-in row first and drops trailing rows past 8000 characters', async () => {
  const builtInDescription = `Built-in agent. ${'b'.repeat(600)}`;
  const names = Array.from(
    { length: 20 },
    (_, at) => `w${String(at).padStart(2, '0')}`,
  );
  const description = (name: string) => `Agent ${name}. ${'x'.repeat(600)}`;
  const lease = sandbox({
    '/workspace': Object.fromEntries(
      names.map((name) => [
        `${name}.md`,
        agentText([`description: ${description(name)}`], `Be ${name}.`),
      ]),
    ),
  });
  const builtInAgents = [builtIn('builtin', builtInDescription)];

  const { system } = await run({ lease, builtInAgents });

  // Each row is its name plus 510 characters (the capped description is 503):
  // 15 rows take at most 7713 characters, 16 at least 8212.
  const rows = [
    `| builtin | ${capped(builtInDescription)} |`,
    ...names
      .slice(0, 14)
      .map((name) => `| ${name} | ${capped(description(name))} |`),
  ];
  assert.deepEqual(system(), {
    role: 'system',
    content: systemPromptWith(harnessVariables, agentsSection(rows, 6)),
  });

  const { agents } = agentServices({ lease, builtInAgents });
  assert.deepEqual(await agents.list(), [
    { name: 'builtin', description: builtInDescription, source: 'built-in' },
    ...names.map((name) => ({
      name,
      description: description(name),
      source: 'workspace' as const,
    })),
  ]);
});

void test('AG1b ends the catalog with "1 more agent did not fit." when one row is dropped', async () => {
  const names = Array.from(
    { length: 16 },
    (_, at) => `w${String(at).padStart(2, '0')}`,
  );
  const description = (name: string) => `Agent ${name}. ${'x'.repeat(600)}`;
  const lease = sandbox({
    '/workspace': Object.fromEntries(
      names.map((name) => [
        `${name}.md`,
        agentText([`description: ${description(name)}`], `Be ${name}.`),
      ]),
    ),
  });

  const { system } = await run({ lease });

  assert.deepEqual(system(), {
    role: 'system',
    content: systemPromptWith(
      harnessVariables,
      agentsSection(
        names
          .slice(0, 15)
          .map((name) => `| ${name} | ${capped(description(name))} |`),
        1,
      ),
    ),
  });
});

void test('AG2 resolves a workspace agent to its raw instructions, reading the whole file under the prompt scope', async () => {
  const { agents, calls } = agentServices({
    lease: sandbox({ '/workspace': { 'foo.md': fooText } }),
  });

  const expected: AgentDefinition = {
    name: 'foo',
    description: 'Foo does F.',
    source: 'workspace',
    model: 'm1',
    effort: 'high',
    instructions:
      'Work on {{ os }} as of {{ date }} ({{ timezone }}).\n\nGreet {{ user.name }}.',
  };
  assert.deepEqual(await agents.resolve({ name: 'foo' }), expected);
  const reads = calls.lease.filter(({ method }) => method === 'readFile');
  assert.deepEqual(
    reads.map(({ input }) => input),
    ['/workspace/.agents/agents/foo.md'],
  );
  assert.deepEqual(reads[0]?.scope, scope);
});

void test('AG3 a workspace agent hides the built-in of its name; built-ins come first in shipped order', async () => {
  const builtInAgents = [
    builtIn('zeta', 'Built-in zeta.'),
    builtIn('foo', 'Built-in foo.'),
  ];
  const { agents } = agentServices({
    builtInAgents,
    lease: sandbox({
      '/workspace': {
        'alpha.md': agentText(['description: Workspace alpha.'], 'Alpha.'),
        'foo.md': agentText(['description: Workspace foo.'], 'Workspace body.'),
      },
    }),
  });

  assert.deepEqual(await agents.list(), [
    { name: 'zeta', description: 'Built-in zeta.', source: 'built-in' },
    { name: 'alpha', description: 'Workspace alpha.', source: 'workspace' },
    { name: 'foo', description: 'Workspace foo.', source: 'workspace' },
  ]);
  assert.deepEqual(await agents.resolve({ name: 'foo' }), {
    name: 'foo',
    description: 'Workspace foo.',
    source: 'workspace',
    instructions: 'Workspace body.',
  });
});

void test('AG3 without a workspace file the built-in agent is listed and resolved', async () => {
  const { agents } = agentServices({
    builtInAgents: [builtIn('foo', 'Built-in foo.', 'Built-in body.')],
    lease: sandbox({}),
  });

  assert.deepEqual(await agents.list(), [
    { name: 'foo', description: 'Built-in foo.', source: 'built-in' },
  ]);
  assert.deepEqual(await agents.resolve({ name: 'foo' }), {
    name: 'foo',
    description: 'Built-in foo.',
    source: 'built-in',
    instructions: 'Built-in body.',
  });
});

void test('AG3b an invalid workspace agent hides the built-in of its name and resolving it fails as invalid_definition', async () => {
  const { agents } = agentServices({
    builtInAgents: [builtIn('foo', 'Built-in foo.')],
    lease: sandbox({
      '/workspace': { 'foo.md': agentText(['model: m1'], 'No description.') },
    }),
  });

  assert.deepEqual(await agents.list(), []);
  await assert.rejects(
    agents.resolve({ name: 'foo' }),
    invalidDefinition('foo', invalidReason.noDescription),
  );
});

void test('AG4 resolving an undefined agent fails as not_found naming every valid agent', async () => {
  const { agents } = agentServices({
    builtInAgents: [builtIn('alpha', 'Alpha.')],
    lease: sandbox({
      '/workspace': {
        'beta.md': agentText(['description: Beta.'], 'Beta.'),
        'broken.md': agentText(['model: m1'], 'Broken.'),
        'gamma.md': agentText(['description: Gamma.'], 'Gamma.'),
      },
    }),
  });

  await assert.rejects(agents.resolve({ name: 'nope' }), {
    code: 'not_found',
    message: 'Agent "nope" is not defined. Defined agents: alpha, beta, gamma.',
    details: { name: 'nope', agents: ['alpha', 'beta', 'gamma'] },
  });
});

void test('AG4 resolving an agent when none is defined says so', async () => {
  const { agents } = agentServices({ lease: sandbox({}) });

  await assert.rejects(agents.resolve({ name: 'nope' }), {
    code: 'not_found',
    message: 'Agent "nope" is not defined. No agent is defined.',
    details: { name: 'nope', agents: [] },
  });
});

void test('AG5 leaves out agents without a description, with an unknown effort or larger than 64000 bytes, and resolving each names the reason', async () => {
  const hugeHead = '---\ndescription: Huge.\n---\n\n';
  const huge = `${hugeHead}${'x'.repeat(64_001 - hugeHead.length)}`;
  assert.equal(Buffer.byteLength(huge), 64_001);
  const { agents } = agentServices({
    lease: sandbox({
      '/workspace': {
        'bare.md': agentText(['model: m1'], 'Bare.'),
        'blank.md': agentText(
          ['description: Blank.', 'model:   ', 'effort: '],
          'Blank.',
        ),
        'empty.md': agentText(['description:   '], 'Empty.'),
        'huge.md': huge,
        'turbo.md': agentText(['description: Turbo.', 'effort: turbo'], 'Go.'),
      },
    }),
  });

  // A blank model or effort is absent.
  assert.deepEqual(await agents.list(), [
    { name: 'blank', description: 'Blank.', source: 'workspace' },
  ]);
  for (const [name, reason] of [
    ['bare', invalidReason.noDescription],
    ['empty', invalidReason.noDescription],
    ['turbo', invalidReason.turbo],
    ['huge', invalidReason.tooLarge],
  ] as const) {
    await assert.rejects(
      agents.resolve({ name }),
      invalidDefinition(name, reason),
    );
  }
  assert.deepEqual(await agents.resolve({ name: 'blank' }), {
    name: 'blank',
    description: 'Blank.',
    source: 'workspace',
    instructions: 'Blank.',
  });
});

void test('AG6 ignores files whose name is not <name>.md and refuses a name outside the pattern as invalid_input', async () => {
  const valid = agentText(['description: Valid.'], 'Valid.');
  const { agents } = agentServices({
    lease: sandbox({
      '/workspace': {
        'Foo Bar.md': valid,
        'Foo.md': valid,
        'notes.txt': valid,
        'ok.md': valid,
      },
    }),
  });

  assert.deepEqual(await agents.list(), [
    { name: 'ok', description: 'Valid.', source: 'workspace' },
  ]);
  for (const name of ['Foo Bar', 'Foo', '', '-dash']) {
    await assert.rejects(async () => agents.resolve({ name }), {
      code: 'invalid_input',
    });
  }
  await assert.rejects(
    async () => agents.resolve({ name: 'ok', extra: true } as { name: string }),
    { code: 'invalid_input' },
  );
});

/** A lease whose every exec fails as `failure` says, though it prints a valid agent. */
const failingLease = (failure: 'reject' | number | null): FakeLease => ({
  exec: () => {
    if (failure === 'reject') throw new Error('The sandbox is gone.');
    return {
      exitCode: failure,
      stdout: agentRecord('foo.md', fooText),
      stderr: 'failed',
    };
  },
  readFile: () => fooText,
});

const failures: readonly (readonly [string, FakeLease | undefined])[] = [
  ['no runtime.lease/v1 provider', undefined],
  ['an exec killed with a null exit code', failingLease(null)],
  ['an exec exiting 1', failingLease(1)],
  ['an exec that rejects', failingLease('reject')],
];

for (const [name, lease] of failures) {
  void test(`AG7 lists the built-in agents only with ${name}, and a run without built-ins lists no agent`, async () => {
    const helper = builtIn('helper', 'Helps.');
    const { agents } = agentServices({
      builtInAgents: [helper],
      ...(lease === undefined ? {} : { lease }),
    });

    assert.deepEqual(await agents.list(), [
      { name: 'helper', description: 'Helps.', source: 'built-in' },
    ]);

    const { text, system } = await run({
      ...(lease === undefined ? {} : { lease }),
    });
    assert.equal(text, 'done');
    assert.ok(!String(system()?.content).includes('# Agents'));
  });
}

void test('AG7 lists the built-in agents only without a working directory to scan', async () => {
  const { agents, calls } = agentServices({
    cwd: null,
    builtInAgents: [builtIn('helper', 'Helps.')],
    lease: sandbox({ '/workspace': { 'foo.md': fooText } }),
  });

  assert.deepEqual(await agents.list(), [
    { name: 'helper', description: 'Helps.', source: 'built-in' },
  ]);
  assert.equal(calls.lease.filter(({ method }) => method === 'exec').length, 0);
});

void test('AG8 tells the model once which agents changed when the Thread moved, after the tool result, with the system prompt unchanged and nothing retained', async () => {
  let cwd = '/workspace';
  const { requests, retained, system } = await run({
    lease: sandbox({
      '/workspace': {
        'a.md': agentText(['description: A.'], 'A.'),
        'shared.md': agentText(['description: Shared A.'], 'Shared.'),
      },
      '/workspace/repo': {
        'fresh.md': agentText(['description: Fresh.'], 'Fresh.'),
        'shared.md': agentText(['description: Shared B.'], 'Shared.'),
      },
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

  assert.equal(requests.length, 2);
  assert.deepEqual(system(), {
    role: 'system',
    content: systemPromptWith(
      harnessVariables,
      agentsSection(['| a | A. |', '| shared | Shared A. |']),
    ),
  });
  const second = requests[1]?.messages ?? [];
  assert.equal(second.at(-2)?.role, 'tool');
  assert.deepEqual(
    second.at(-1),
    agentsChanged(
      addedOrChanged('| fresh | Fresh. |', '| shared | Shared B. |'),
      noLongerAvailable('a'),
    ),
  );
  assert.equal(second.filter(isAgentsChange).length, 1);
  assert.deepEqual(second[0], requests[0]?.messages[0]);
  assert.deepEqual(
    Object.keys(retained()).filter((key) => key.includes('agents-changed')),
    [],
  );
});

void test('AG8 gives the agents change before the skills change when both changed', async () => {
  let cwd = '/workspace';
  const { requests } = await run({
    lease: sandbox(
      {
        '/workspace/repo': {
          'fresh.md': agentText(['description: Fresh.'], 'Fresh.'),
        },
      },
      { '/workspace/repo': ['local'] },
    ),
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

  const second = requests[1]?.messages ?? [];
  assert.equal(second.at(-3)?.role, 'tool');
  assert.deepEqual(
    second.at(-2),
    agentsChanged(addedOrChanged('| fresh | Fresh. |')),
  );
  assert.ok(isSkillsChange(second.at(-1)));
  assert.equal(second.filter(isAgentsChange).length, 1);
});

void test('AG8 neither rescans nor tells anything while the working directory stays', async () => {
  const { requests, calls } = await run({
    lease: sandbox({
      '/workspace': { 'a.md': agentText(['description: A.'], 'A.') },
    }),
    workspace: { cwd: () => '/workspace' },
    turns: [{ calls: [inspecting] }, { calls: [inspecting] }, {}],
  });

  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.messages.filter(isAgentsChange).length, 0);
  }
  assert.equal(agentScans(calls.lease).length, 1);
});

void test('AG8 does not report an agent whose model or effort alone changed', async () => {
  let cwd = '/workspace';
  const { requests } = await run({
    lease: sandbox({
      '/workspace': {
        'a.md': agentText(['description: A.', 'model: m1'], 'A.'),
      },
      '/workspace/repo': {
        'a.md': agentText(
          ['description: A.', 'model: m2', 'effort: max'],
          'A.',
        ),
      },
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

  assert.equal(requests.length, 2);
  assert.ok(String(requests[0]?.messages[0]?.content).includes('| a | A. |'));
  assert.equal(requests[1]?.messages.filter(isAgentsChange).length, 0);
});

void test('AG8b tells the model again about an agents change a compaction condensed away', async () => {
  let cwd = '/workspace';
  const { requests } = await run({
    configuration: compacting(),
    lease: sandbox({
      '/workspace/repo': {
        'local.md': agentText(['description: Local.'], 'Local.'),
      },
    }),
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

  const added = agentsChanged(addedOrChanged('| local | Local. |'));
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[1]?.messages.at(-1), added);
  assert.equal(requests[2]?.messages.filter(isAgentsChange).length, 1);
  const last = requests[3]?.messages ?? [];
  assert.ok(String(last[1]?.content).startsWith(checkpointMarker));
  assert.equal(last.filter(isAgentsChange).length, 1);
  assert.deepEqual(last.at(-1), added);
});

void test('AG9 a run with no agent to list sends the same system prompt as a run with no lease', async () => {
  const unleased = await run({});
  const empty = await run({ lease: sandbox({ '/workspace': {} }) });
  const invalid = await run({
    lease: sandbox({
      '/workspace': {
        'bare.md': agentText(['model: m1'], 'Bare.'),
        'leak.md': agentText(
          ['description: Leaks.'],
          'Run {{ secrets.TOKEN }}.',
        ),
      },
    }),
  });

  const expected = {
    role: 'system',
    content: systemPromptWith(harnessVariables, ''),
  };
  for (const { system } of [unleased, empty, invalid]) {
    assert.deepEqual(system(), expected);
    assert.ok(!String(system()?.content).includes('# Agents'));
  }
  // The leased runs did look for agents.
  assert.equal(agentScans(empty.calls.lease).length, 1);
  assert.equal(agentScans(invalid.calls.lease).length, 1);
});

void test('AG10 leaves out an agent whose instructions cite a name that is not a prompt variable, and resolving it names the tag and the delimiter switch', async () => {
  const { agents } = agentServices({
    lease: sandbox({
      '/workspace': {
        'leak.md': agentText(
          ['description: Leaks.'],
          'Run {{ secrets.TOKEN }}.',
        ),
      },
    }),
  });

  assert.deepEqual(await agents.list(), []);
  await assert.rejects(
    agents.resolve({ name: 'leak' }),
    invalidDefinition('leak', invalidReason.secrets),
  );
});

void test('AG10b an agent that switches delimiters keeps literal mustache tags and renders its own', async () => {
  const instructions = '{{=<% %>=}}\nRun {{ secrets.TOKEN }} on <% os %>.';
  const { agents } = agentServices({
    lease: sandbox({
      '/workspace': {
        'literal.md': agentText(['description: Literal.'], instructions),
      },
    }),
  });

  assert.deepEqual(await agents.list(), [
    { name: 'literal', description: 'Literal.', source: 'workspace' },
  ]);
  const definition = await agents.resolve({ name: 'literal' });
  assert.equal(definition.instructions, instructions);
  assert.equal(
    render(definition.instructions, { os: 'Linux' }),
    'Run {{ secrets.TOKEN }} on Linux.',
  );
});

void test('AG11 activation throws synchronously on an invalid built-in agent and provides nothing', async () => {
  const services = bundleServices({
    provider: scripted([]).provider,
    builtInAgents: [
      {
        path: '/x/agents/bad.md',
        text: '---\ndescription: Bad.\n---\n{{ secrets.TOKEN }}',
      },
    ],
  });

  assert.throws(() => services.activate(), {
    message: `Built-in agent "/x/agents/bad.md" is invalid: ${invalidReason.secrets}.`,
  });
  await assert.rejects(async () =>
    services.harness.services.use(DefaultAgentsV1, scope).list(),
  );
});

void test('AG11 activation refuses a built-in file name outside the pattern and two files of one name', () => {
  const valid = agentText(['description: Valid.'], 'Valid.');
  const activating = (builtInAgents: readonly AgentFile[]) => () =>
    bundleServices({
      provider: scripted([]).provider,
      builtInAgents,
    }).activate();

  assert.throws(
    activating([{ path: '/x/agents/Bad Name.md', text: valid }]),
    (error: unknown) =>
      error instanceof Error &&
      error.message.startsWith(
        'Built-in agent "/x/agents/Bad Name.md" is invalid: its file name is not',
      ),
  );
  assert.throws(
    activating([
      { path: '/x/one/dup.md', text: valid },
      { path: '/x/two/dup.md', text: valid },
    ]),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('is invalid: two files define "dup".'),
  );
});

void test('AG11 a valid injected built-in agent activates and is listed as built-in', async () => {
  const { agents } = agentServices({
    cwd: null,
    builtInAgents: [
      {
        path: '/x/agents/helper.md',
        text: agentText(
          ['description: Helps.', 'model: m2', 'effort: low'],
          'Help on {{ os }}.',
        ),
      },
    ],
  });

  assert.deepEqual(await agents.list(), [
    {
      name: 'helper',
      description: 'Helps.',
      source: 'built-in',
      model: 'm2',
      effort: 'low',
    },
  ]);
  assert.deepEqual(await agents.resolve({ name: 'helper' }), {
    name: 'helper',
    description: 'Helps.',
    source: 'built-in',
    model: 'm2',
    effort: 'low',
    instructions: 'Help on {{ os }}.',
  });
});

void test('AG12 the shipped built-in agents activate and are listed in workflow order, each resolving to the common block then its own step', async () => {
  const { agents } = agentServices({
    cwd: null,
    builtInAgents: builtInAgentFiles,
  });
  const shipped = [
    {
      name: 'triage',
      description:
        'Classifies a coding task — route signals, unclear-idea check, docs to update — so the coordinator can choose its route.',
    },
    {
      name: 'search',
      description:
        'Locates the code, tests and patterns a change depends on and reports them as file:line evidence; changes no files.',
    },
    {
      name: 'spec',
      description:
        'Writes or revises a feature concept or the spec of a large change, and answers review findings with CONTEST or FIX.',
    },
    {
      name: 'review',
      description:
        'Reviews one document through one lens given in the instruction (Scope, Comprehension, Critique, Structural, Style, Readiness, Codebase or Docs) and reports findings by severity.',
    },
    {
      name: 'plan',
      description:
        'Decides the smallest change that meets the requirements, with per-file changes, contracts and a test list; changes no files.',
    },
    {
      name: 'contracts',
      description:
        'Writes the public types, interfaces and signatures a plan names, with doc comments; no behavior and no file changes.',
    },
    {
      name: 'tests',
      description:
        'Writes the failing tests for a test list through the given contracts and proves they fail for the right reason.',
    },
    {
      name: 'implementation',
      description:
        'Adds the given contracts and the smallest behavior that turns the red tests green, without touching tests.',
    },
    {
      name: 'cleanup',
      description:
        'Makes a change smaller and simpler without changing its behavior, starting from green tests.',
    },
    {
      name: 'docs',
      description:
        'Brings the living documentation in line with a change: feature docs, READMEs, reference docs and decision records.',
    },
  ];

  assert.deepEqual(
    await agents.list(),
    shipped.map((agent) => ({ ...agent, source: 'built-in' })),
  );
  const prefixes: string[] = [];
  for (const { name } of shipped) {
    const text = render(
      (await agents.resolve({ name })).instructions,
      harnessVariables,
    );
    assert.notEqual(text, '', name);
    assert.ok(!text.includes('{{'), name);
    const at = text.indexOf(
      `\n## ${name.charAt(0).toUpperCase()}${name.slice(1)}\n`,
    );
    assert.ok(at > 0, name);
    prefixes.push(text.slice(0, at));
  }
  for (const prefix of prefixes) {
    assert.equal(prefix, prefixes[0]);
  }
  assert.ok(prefixes[0]?.startsWith('## Workflow step'));
});
