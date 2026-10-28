import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestServices } from 'bundle/testing';
import type { ProviderRequest } from 'llms';
import type {
  ConfigurationValue,
  LeaseExecInput,
  LeaseExecResult,
} from 'runtime/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

import { checkTemplate } from '../src/host/prompts/templates.js';
import {
  promptVariableNames,
  promptVariables,
} from '../src/host/prompts/variables.js';
import {
  bundleServices,
  type FakeLease,
  fakeThreadState,
  isOsProbe,
  osLease,
  runPrompt,
  sandboxSection,
  skill,
  testConfiguration,
} from './support/harness.js';
import { systemPrompt } from './support/prompts.js';

/*
 * DORIC-87: the default agent's system prompt ends its instructions with an
 * `# Environment` section rendered once per run from the prompt variables —
 * the sandbox's operating system (probed through the lease), today's date in
 * the profile's time zone, and the user's name from the profile — before the
 * `# Skills` section, if any.
 */

/** The Environment section of a default harness run: UTC at 2026-03-01T12:00Z. */
const dateOnly = `# Environment\n\n- Today's date: 2026-03-01 (UTC)`;

/** The OS line of `osLease()`'s probe answer. */
const osLine =
  '- Operating system of the sandbox: Ubuntu 24.04 LTS (Linux 6.8.0 x86_64)';

const withProfile = (
  profile: NonNullable<ConfigurationValue['profile']>,
): ConfigurationValue => ({ ...testConfiguration(), profile });

/** A tool the model can call, so a run sends a second request. */
const inspectTool = () =>
  defineTool({
    name: 'inspect',
    description: 'Inspect state.',
    input: z.object({}),
    output: z.object({}),
    execute: async () => ({}),
  }).bind(createTestServices({ bundle: { id: 'tools-owner' } }).services);

/**
 * The default bundle over the harness; its model calls `inspect` once when the
 * prompt is `use-tool`, and otherwise answers `done`. `run` sends one prompt
 * and answers the system message of every request that run sent.
 */
const harnessOf = (
  options: {
    readonly configuration?: ConfigurationValue;
    readonly lease?: FakeLease;
    readonly now?: () => Date;
    readonly skills?: Parameters<typeof bundleServices>[0]['skills'];
  } = {},
) => {
  const requests: ProviderRequest[] = [];
  const provider = {
    metadata: { id: 'provider', name: 'provider' },
    stream: async function* (request: ProviderRequest) {
      requests.push(request);
      const last = request.messages.at(-1);
      const calling =
        last?.role === 'user' && String(last.content).includes('use-tool');
      yield {
        type: 'response.finished' as const,
        finish: calling
          ? {
              text: '',
              finishReason: 'tool_calls' as const,
              toolCalls: [{ id: 'call-1', name: 'inspect', arguments: '{}' }],
            }
          : { text: 'done', finishReason: 'stop' as const, toolCalls: [] },
      };
    },
  };
  const services = bundleServices({
    provider,
    tools: [
      { bundleId: 'tools-owner', alwaysAvailable: false, tool: inspectTool() },
    ],
    ...options,
  });
  const state = fakeThreadState();
  let activated: Promise<void> | undefined;
  let runs = 0;

  return {
    calls: services.calls,
    /** The OS probes the lease received, in order. */
    probes: () =>
      services.calls.lease
        .filter(({ method }) => method === 'exec')
        .map(({ input }) => input as LeaseExecInput)
        .filter(isOsProbe),
    run: async (prompt = 'do the task') => {
      activated ??= Promise.resolve(services.activate());
      await activated;
      const from = requests.length;
      runs += 1;
      const text = await runPrompt(services, state, prompt, {
        id: `run-${runs}`,
      });
      const systems = requests.slice(from).map(({ messages }) => {
        assert.equal(messages[0]?.role, 'system');
        return String(messages[0]?.content);
      });
      return { text, systems };
    },
  };
};

void test('V1 ends the instructions with an Environment section holding the date, before the skills', async () => {
  const bare = await harnessOf().run();
  const skilled = await harnessOf({
    skills: [skill('sandbox', 'Inspect before reporting.')],
  }).run();

  assert.deepEqual(bare.systems, [`${systemPrompt}\n\n${dateOnly}`]);
  assert.deepEqual(skilled.systems, [
    `${systemPrompt}\n\n${dateOnly}\n\n${sandboxSection}`,
  ]);
});

void test("V2 dates a run in the profile's time zone, with no OS and no user without them", () => {
  const variables = promptVariables({
    profile: { timezone: 'America/Sao_Paulo' },
    now: new Date('2026-03-01T02:00:00Z'),
  });

  assert.deepEqual(variables, {
    date: '2026-02-28',
    timezone: 'America/Sao_Paulo',
  });
  assert.ok(!('os' in variables));
  assert.ok(!('user' in variables));
});

void test("V3 falls back to the host's time zone without a profile", () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  try {
    // Node re-reads TZ when it is set at runtime; the host zone is now Tokyo.
    assert.equal(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      'Asia/Tokyo',
    );
    const variables = promptVariables({
      now: new Date('2026-03-01T20:00:00Z'),
    });

    assert.equal(variables.timezone, 'Asia/Tokyo');
    assert.equal(variables.date, '2026-03-02');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

void test('V4 names the user right after the date line only when the profile has a name', async () => {
  const unnamed = await harnessOf().run();
  const named = await harnessOf({
    configuration: withProfile({ name: 'Ada', timezone: 'UTC' }),
  }).run();

  const [system] = unnamed.systems;
  assert.ok(!String(system).includes("User's name"));
  assert.equal(
    String(system).split('\n').at(-1),
    "- Today's date: 2026-03-01 (UTC)",
  );
  assert.deepEqual(named.systems, [
    `${systemPrompt}\n\n${dateOnly}\n- User's name: Ada`,
  ]);
});

void test('V5 states the probed OS of the sandbox right before the date line, probing with a 5 s timeout', async () => {
  const harness = harnessOf({ lease: osLease() });
  const { systems } = await harness.run();

  assert.deepEqual(systems, [
    `${systemPrompt}\n\n# Environment\n\n${osLine}\n- Today's date: 2026-03-01 (UTC)`,
  ]);
  const probes = harness.probes();
  assert.equal(probes.length, 1);
  assert.equal(probes[0]?.timeoutMs, 5000);
});

/** A lease `lease-1` whose OS probe answers `probe`; other execs exit 0 empty. */
const probing = (
  probe: (input: LeaseExecInput) => LeaseExecResult | Promise<LeaseExecResult>,
  describe: FakeLease['describe'] = () => ({
    id: 'lease-1',
    root: '/workspace',
  }),
): FakeLease => ({
  describe,
  exec: (input) =>
    isOsProbe(input) ? probe(input) : { exitCode: 0, stdout: '', stderr: '' },
});

const answer = (exitCode: number | null, stdout: string): LeaseExecResult => ({
  exitCode,
  stdout,
  stderr: exitCode === 0 ? '' : 'probe failed',
});

const probeOutput = 'Linux 6.8.0 x86_64\nUbuntu 24.04 LTS\n';

for (const [name, lease] of [
  ['no lease provider', undefined],
  [
    'describe rejecting',
    probing(
      () => answer(0, probeOutput),
      () => Promise.reject(new Error('no lease')),
    ),
  ],
  [
    'exec rejecting',
    probing(() => Promise.reject(new Error('sandbox unavailable'))),
  ],
  ['exit code 1', probing(() => answer(1, probeOutput))],
  ['a null exit code', probing(() => answer(null, probeOutput))],
  ['empty stdout', probing(() => answer(0, ''))],
] as const) {
  void test(`V5 leaves the OS line out, with no blank line in its place, and completes the run on ${name}`, async () => {
    const { text, systems } = await harnessOf(
      lease === undefined ? {} : { lease },
    ).run();

    assert.equal(text, 'done');
    assert.deepEqual(systems, [`${systemPrompt}\n\n${dateOnly}`]);
  });
}

void test('V6 probes a lease once across runs, and again for another lease', async () => {
  let id = 'lease-1';
  const harness = harnessOf({
    lease: probing(
      () => answer(0, probeOutput),
      () => ({ id, root: '/workspace' }),
    ),
  });

  const first = await harness.run();
  const second = await harness.run();
  assert.equal(harness.probes().length, 1);
  for (const { systems } of [first, second])
    assert.ok(String(systems[0]).includes(`\n${osLine}\n`));

  id = 'lease-2';
  const third = await harness.run();
  assert.equal(harness.probes().length, 2);
  assert.ok(String(third.systems[0]).includes(`\n${osLine}\n`));
});

void test('V6 probes again on the next run after a probe failed', async () => {
  let failing = true;
  const harness = harnessOf({
    lease: probing(() => answer(failing ? 1 : 0, probeOutput)),
  });

  const failed = await harness.run();
  failing = false;
  const retried = await harness.run();

  assert.equal(harness.probes().length, 2);
  assert.deepEqual(failed.systems, [`${systemPrompt}\n\n${dateOnly}`]);
  assert.deepEqual(retried.systems, [
    `${systemPrompt}\n\n# Environment\n\n${osLine}\n- Today's date: 2026-03-01 (UTC)`,
  ]);
});

void test('V7 dates every request of a run with the date the run started on', async () => {
  const instants = [
    new Date('2026-02-28T23:59:59Z'),
    new Date('2026-03-01T00:00:01Z'),
  ];
  let reads = 0;
  const now = () => {
    const instant = instants[Math.min(reads, instants.length - 1)];
    reads += 1;
    assert.ok(instant);
    return new Date(instant);
  };

  const { systems } = await harnessOf({ now }).run('use-tool');

  assert.equal(systems.length, 2);
  assert.equal(systems[0], systems[1]);
  assert.ok(String(systems[0]).endsWith("\n- Today's date: 2026-02-28 (UTC)"));
});

void test("V8 writes the user's name as it is, with no HTML escaping", async () => {
  const { systems } = await harnessOf({
    configuration: withProfile({ name: '<b>&', timezone: 'UTC' }),
  }).run();

  assert.ok(String(systems[0]).endsWith("\n- User's name: <b>&"));
});

void test('N1 accepts a template citing every prompt variable', () => {
  assert.deepEqual(
    [...promptVariableNames],
    ['os', 'date', 'timezone', 'user', 'user.name'],
  );
  assert.doesNotThrow(() =>
    checkTemplate(
      '{{date}} {{timezone}} {{#os}}{{os}}{{/os}}{{#user}}{{user.name}}{{/user}}',
      promptVariableNames,
      'x',
    ),
  );
});
