import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderRequest } from 'llms';
import type { ExecutorThread, SpawnAgent } from 'runtime/contracts';

import type { AgentFile } from '../src/host/agents/built-in.js';
import { systemPromptWith } from '../src/host/executor.js';
import {
  bundleServices,
  fakeThreadState,
  type HarnessOptions,
  harnessVariables,
  runPrompt,
  sandboxSection,
  skill,
  testConfiguration,
} from './support/harness.js';

/*
 * DORIC-73: `default` runs a Thread with its saved agent, model and effort.
 * An agent Thread's system prompt opens with a `# Agent: <name>` section —
 * the agent's instructions rendered with the run's prompt variables — before
 * `# Agents` and `# Skills`; the Thread's model and effort override the
 * configured execution ones, on the configured provider.
 */

const reviewer: SpawnAgent = {
  name: 'reviewer',
  source: 'workspace',
  instructions: 'Review the diff.',
};

/** The `# Agent` section of an agent named `name` with rendered `instructions`. */
const agentSection = (name: string, instructions: string): string =>
  [
    `# Agent: ${name}`,
    `You run as the ${name} agent. Follow these instructions; they take precedence over general guidance for how to do your task.`,
    instructions,
  ].join('\n\n');

/** The `# Agents` catalog listing `rows`. */
const agentsSection = (...rows: readonly string[]): string =>
  [
    '# Agents',
    'The agents defined for this thread, each by its name and a description of when to use it.',
    ['| Agent | Description |', '| --- | --- |', ...rows].join('\n'),
  ].join('\n\n');

/** A built-in agent file `/doric/agents/<name>.md`. */
const builtIn = (name: string, description: string): AgentFile => ({
  path: `/doric/agents/${name}.md`,
  text: `---\ndescription: ${description}\n---\n\nBuilt-in ${name} body.\n`,
});

/** A configuration whose execution model is `configured-model` at `high`. */
const configured = () => ({
  ...testConfiguration(),
  models: {
    execution: {
      providerId: 'openrouter',
      model: 'configured-model',
      effort: 'high' as const,
    },
  },
});

/**
 * The default bundle over a provider that records every request and answers
 * `done`, with the one always-available skill `sandbox`.
 */
const harnessOf = (options: Omit<HarnessOptions, 'provider'> = {}) => {
  const requests: ProviderRequest[] = [];
  const state = fakeThreadState();
  const services = bundleServices({
    skills: [skill('sandbox', 'Inspect before reporting.')],
    ...options,
    provider: {
      metadata: { id: 'provider', name: 'provider' },
      stream: async function* (request: ProviderRequest) {
        requests.push(request);
        yield {
          type: 'response.finished' as const,
          finish: {
            text: 'done',
            finishReason: 'stop' as const,
            toolCalls: [],
          },
        };
      },
    },
  });
  let activated: Promise<void> | undefined;
  return {
    requests,
    services,
    /** The system prompt of request `at`. */
    system: (at = 0) => requests[at]?.messages[0]?.content,
    run: async (
      thread: Partial<ExecutorThread> = {},
      id?: string,
    ): Promise<string> => {
      activated ??= Promise.resolve(services.activate());
      await activated;
      return runPrompt(services, state, 'do the task', {
        thread,
        ...(id === undefined ? {} : { id }),
      });
    },
  };
};

void test('EX1 an agent Thread runs with its # Agent section before the skills', async () => {
  const harness = harnessOf();

  await harness.run({ agent: reviewer });

  assert.deepEqual(harness.requests[0]?.messages[0], {
    role: 'system',
    content: systemPromptWith(
      harnessVariables,
      `${agentSection('reviewer', 'Review the diff.')}\n\n${sandboxSection}`,
    ),
  });
});

void test('EX1b the # Agent section comes before # Agents and # Skills', async () => {
  const harness = harnessOf({ builtInAgents: [builtIn('helper', 'Helps.')] });

  await harness.run({ agent: reviewer });

  const system = String(harness.system());
  assert.equal(
    system,
    systemPromptWith(
      harnessVariables,
      [
        agentSection('reviewer', 'Review the diff.'),
        agentsSection('| helper | Helps. |'),
        sandboxSection,
      ].join('\n\n'),
    ),
  );
  const agentAt = system.indexOf('# Agent: reviewer');
  const agentsAt = system.indexOf('# Agents');
  const skillsAt = system.indexOf('# Skills');
  assert.ok(agentAt !== -1 && agentAt < agentsAt && agentsAt < skillsAt);
});

void test('EX2 the Thread model and effort replace the configured ones on the configured provider', async () => {
  const harness = harnessOf({ configuration: configured() });

  await harness.run({ model: 'thread-model', effort: 'low' });

  assert.deepEqual(harness.services.resolved, [
    { providerId: 'openrouter', model: 'thread-model', effort: 'low' },
  ]);
  assert.equal(harness.requests[0]?.model, 'thread-model');
  assert.equal(harness.requests[0]?.effort, 'low');
});

void test('EX2c a Thread with only a model keeps the configured effort', async () => {
  const harness = harnessOf({ configuration: configured() });

  await harness.run({ model: 'thread-model' });

  assert.deepEqual(harness.services.resolved, [
    { providerId: 'openrouter', model: 'thread-model', effort: 'high' },
  ]);
  assert.equal(harness.requests[0]?.model, 'thread-model');
  assert.equal(harness.requests[0]?.effort, 'high');
});

void test('EX2c a Thread with only an effort keeps the configured model', async () => {
  const harness = harnessOf({ configuration: configured() });

  await harness.run({ effort: 'low' });

  assert.deepEqual(harness.services.resolved, [
    { providerId: 'openrouter', model: 'configured-model', effort: 'low' },
  ]);
  assert.equal(harness.requests[0]?.model, 'configured-model');
  assert.equal(harness.requests[0]?.effort, 'low');
});

void test('EX3 a Thread without agent, model or effort runs as before', async () => {
  const harness = harnessOf({ configuration: configured() });

  await harness.run();

  assert.equal(harness.requests[0]?.model, 'configured-model');
  assert.equal(harness.requests[0]?.effort, 'high');
  assert.equal(
    harness.system(),
    systemPromptWith(harnessVariables, sandboxSection),
  );
  assert.ok(!String(harness.system()).includes('# Agent:'));
});

void test('EX7 the agent instructions render with each run’s own prompt variables', async () => {
  let clock = new Date('2026-03-01T12:00:00.000Z');
  const harness = harnessOf({ now: () => new Date(clock) });
  const agent: SpawnAgent = { ...reviewer, instructions: 'Today is {{date}}.' };

  await harness.run({ agent }, 'first');
  clock = new Date('2026-03-02T12:00:00.000Z');
  await harness.run({ agent }, 'second');

  const first = String(harness.system(0));
  const second = String(harness.system(1));
  assert.ok(first.includes('Today is 2026-03-01.'), first);
  assert.ok(second.includes('Today is 2026-03-02.'), second);
  assert.ok(!first.includes('{{'));
  assert.ok(!second.includes('{{'));
});

void test('EX8 instructions citing an undeclared name reject the run before its first model request', async () => {
  const harness = harnessOf();

  await assert.rejects(
    harness.run({ agent: { ...reviewer, instructions: '{{project}}' } }),
    {
      message: 'Template "agent reviewer" cites undeclared name "project".',
    },
  );
  assert.equal(harness.requests.length, 0);
});
