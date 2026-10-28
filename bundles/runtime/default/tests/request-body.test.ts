import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Call } from 'bundle/contracts';
import {
  createProviderForKind,
  type HttpRequest,
  type HttpStreamChunk,
  type HttpTransport,
} from 'llms';
import pino from 'pino';
import type { ConfigurationValue } from 'runtime/contracts';
import { z } from 'zod';

import { systemPromptWith } from '../src/host/executor.js';
import { systemPrompt } from '../src/host/prompts/system.js';
import { skillCatalog } from '../src/host/skills/catalog.js';
import {
  bundleServices,
  fakeThreadState,
  type HarnessSkill,
  runPrompt,
  testConfiguration,
} from './support/harness.js';

// The exact model request bodies of the stage-1 host for a fresh Thread:
// `system-prompt.md` and `tools.json` are the stage-1 parity fixtures, and the
// two bodies were recorded by the E2E baseline (scenarios 06 and 16) from the
// pre-migration host. The real llms providers build the body; only their HTTP
// transport is faked.
//
// Re-baselined for the skill catalog (DORIC-56): `skills.json` holds the 22
// recorded skills with their recorded bodies and the `alwaysAvailable` flag
// they ship with; `system-prompt.md` is the base instruction followed by the
// `# Skills` section those skills render, and every expected tool list ends
// with the run's own `load_skill`, which no bundle registers. Its `name` is a
// plain string since the skills a run can load change while it runs.

/** dist-tests/tests → the package's own tests/fixtures folder. */
const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tests',
  'fixtures',
  'request-body',
);

const readJson = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(join(fixtures, name), 'utf8')) as T;

interface RecordedBody {
  readonly path: string;
  readonly fields: Record<string, unknown>;
  readonly tools: readonly unknown[];
  readonly nonSystemMessages?: readonly unknown[];
  readonly firstMessage?: unknown;
}

interface ToolFixture {
  readonly definition: { readonly name: string; readonly description: string };
  readonly settings: readonly object[];
}

interface RecordedSkill {
  readonly name: string;
  readonly description: string;
  readonly alwaysAvailable: boolean;
  readonly body: string;
}

/** The tool the executor adds to a run whose system prompt lists skills to load. */
const LOAD_SKILL = 'load_skill';

const catalog = {
  data: [
    {
      id: 'deepseek/fake-chat',
      name: 'Fake Chat',
      context_length: 128000,
      supported_parameters: [
        'tools',
        'tool_choice',
        'reasoning',
        'include_reasoning',
        'max_tokens',
        'temperature',
      ],
      reasoning: {
        supported_efforts: ['low', 'medium', 'high'],
        default_effort: 'low',
      },
    },
  ],
};

const sse = (payload: unknown): string =>
  `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;

const chatStream = (model: string): readonly HttpStreamChunk[] => {
  const chunk = (delta: object, finish: string | null = null) => ({
    id: 'chat-1',
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return [
    sse(chunk({ role: 'assistant', content: '' })),
    sse(chunk({ content: 'Hello.' })),
    sse(chunk({}, 'stop')),
    sse('[DONE]'),
  ];
};

const responsesStream = (model: string): readonly HttpStreamChunk[] => {
  const message = {
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Hello.', annotations: [] }],
  };
  const final = {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    model,
    output: [message],
  };
  return [
    sse({
      type: 'response.created',
      response: { ...final, status: 'in_progress', output: [] },
    }),
    sse({
      type: 'response.output_text.delta',
      output_index: 0,
      delta: 'Hello.',
    }),
    sse({ type: 'response.output_text.done', output_index: 0, text: 'Hello.' }),
    sse({ type: 'response.output_item.done', output_index: 0, item: message }),
    sse({ type: 'response.completed', response: final }),
    sse('[DONE]'),
  ];
};

/** Captures every streamed request body; answers the catalog read. */
const capturingTransport = (
  stream: (model: string) => readonly HttpStreamChunk[],
) => {
  const bodies: { readonly url: string; readonly body: unknown }[] = [];
  const transport: HttpTransport = {
    request: (request: HttpRequest) =>
      Promise.resolve({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          request.url.endsWith('/models') ? catalog : { data: [] },
        ),
      }),
    stream: async function* (request: HttpRequest) {
      const body = JSON.parse(request.body ?? '{}') as { model: string };
      bodies.push({ url: request.url, body });
      yield* stream(body.model);
    },
  };
  return { transport, bodies };
};

/** A bound tool with the recorded definition, as tools/v1 lists it. */
const recordedTool = ({ definition, settings }: ToolFixture) => {
  const input = z.object({});
  const output = z.unknown();
  const check = (payload: unknown) => ({
    success: true as const,
    data: payload,
  });
  const execute = () => Promise.resolve({});
  return {
    bundleId: 'recorded',
    alwaysAvailable: false,
    tool: {
      name: definition.name,
      description: definition.description,
      input,
      output,
      definition,
      settings,
      check,
      execute,
      toTool: (_call: Call) => ({
        name: definition.name,
        description: definition.description,
        input,
        output,
        definition,
        execute,
        check,
      }),
    },
  };
};

/** The recorded skills, as skills/v1 lists them, in bundle order. */
const recordedSkills = async (): Promise<readonly HarnessSkill[]> =>
  (await readJson<readonly RecordedSkill[]>('skills.json')).map(
    ({ name, description, alwaysAvailable, body }) => ({
      name,
      description,
      body,
      allowedTools: [],
      indexText: name,
      alwaysAvailable,
    }),
  );

const runFresh = async (
  configuration: ConfigurationValue,
  stream: (model: string) => readonly HttpStreamChunk[],
) => {
  const system = await readFile(join(fixtures, 'system-prompt.md'), 'utf8');
  const expectedTools = await readJson<readonly ToolFixture[]>('tools.json');
  // The bundles register every recorded tool but the executor's own.
  const tools = expectedTools.filter(
    ({ definition }) => definition.name !== LOAD_SKILL,
  );
  const skills = await recordedSkills();
  const { transport, bodies } = capturingTransport(stream);
  const provider = configuration.providers.find(
    ({ id }) => id === configuration.models.execution.providerId,
  );
  assert.ok(provider);
  const languageModel = createProviderForKind(
    provider.kind as 'openrouter' | 'openai',
    { ...provider.configuration, token: () => 'secret-value' },
    {
      transport,
      logger: pino({ enabled: false }),
      identity: { id: provider.id, name: provider.id },
    },
  );
  const services = bundleServices({
    configuration,
    provider: languageModel,
    tools: tools.map(recordedTool) as never,
    skills,
  });
  await services.activate();
  await runPrompt(services, fakeThreadState(), '[[plain]] Say hello.');
  return {
    system,
    bodies,
    toolNames: expectedTools.map(({ definition }) => definition.name),
  };
};

const split = (body: Record<string, unknown>, chat: boolean) => {
  const {
    messages,
    input,
    instructions,
    tools,
    ...fields
  }: Record<string, unknown> = body;
  const entries = (chat ? messages : input) as readonly {
    readonly role?: string;
    readonly content?: unknown;
  }[];
  const system = chat
    ? entries
        .filter(({ role }) => role === 'system')
        .map(({ content }) => content)
        .join('\n\n')
    : instructions;
  return {
    fields,
    system,
    tools,
    nonSystemMessages: entries.filter(({ role }) => role !== 'system'),
  };
};

void test('F1 builds the recorded system prompt from the base instruction and the skill section of the recorded skills', async () => {
  const system = await readFile(join(fixtures, 'system-prompt.md'), 'utf8');
  const skills = await readJson<readonly RecordedSkill[]>('skills.json');
  const [base] = system.split('\n\n# Skills\n\n');

  assert.equal(base, systemPrompt);
  assert.equal(skills.length, 22);
  assert.deepEqual(
    skills
      .filter(({ alwaysAvailable }) => alwaysAvailable)
      .map(({ name }) => name),
    ['goal-directed-tool-use', 'thread-delegation'],
  );
  const { section } = skillCatalog({
    alwaysAvailable: skills
      .filter(({ alwaysAvailable }) => alwaysAvailable)
      .map(({ name, description, body }) => ({ name, description, body })),
    builtIn: skills
      .filter(({ alwaysAvailable }) => !alwaysAvailable)
      .map(({ name, description, body }) => ({
        name,
        description,
        origin: { kind: 'bundle' as const, body },
      })),
    workspace: [],
    server: [],
  });
  assert.equal(systemPromptWith(section), system);
});

void test('sends the exact OpenRouter chat body the stage-1 host sent for a fresh Thread', async () => {
  const recorded = await readJson<RecordedBody>('openrouter-body.json');
  const base = testConfiguration();
  const configuration: ConfigurationValue = {
    ...base,
    providers: [
      {
        id: 'openrouter',
        kind: 'openrouter',
        configuration: {
          endpoint: 'http://127.0.0.1:3310/v1',
          token: 'credential-1',
        },
      },
    ],
    models: {
      execution: {
        providerId: 'openrouter',
        model: 'deepseek/fake-chat',
        effort: 'low',
      },
    },
    execution: { maxTurns: 16 },
  };

  const { system, bodies, toolNames } = await runFresh(
    configuration,
    chatStream,
  );

  assert.equal(bodies.length, 1);
  assert.equal(
    new URL(bodies[0]?.url ?? '').pathname.replace('/v1', ''),
    recorded.path,
  );
  const sent = split(bodies[0]?.body as Record<string, unknown>, true);
  assert.deepEqual(sent.fields, recorded.fields);
  assert.equal(sent.system, system);
  assert.deepEqual(sent.tools, recorded.tools);
  assert.deepEqual(
    (
      sent.tools as readonly { readonly function: { readonly name: string } }[]
    ).map(({ function: tool }) => tool.name),
    toolNames,
  );
  assert.deepEqual(sent.nonSystemMessages, recorded.nonSystemMessages);
});

void test('sends the exact OpenAI Responses body the stage-1 host sent', async () => {
  const recorded = await readJson<RecordedBody>('openai-responses-body.json');
  const configuration: ConfigurationValue = {
    ...testConfiguration(),
    providers: [
      {
        id: 'fake-openai',
        kind: 'openai',
        configuration: {
          endpoint: 'http://127.0.0.1:3310/v1',
          token: 'credential-2',
        },
      },
    ],
    models: {
      execution: {
        providerId: 'fake-openai',
        model: 'fake-responses',
        effort: 'low',
      },
    },
    execution: { maxTurns: 16 },
  };

  const { system, bodies, toolNames } = await runFresh(
    configuration,
    responsesStream,
  );

  assert.equal(bodies.length, 1);
  assert.equal(
    new URL(bodies[0]?.url ?? '').pathname.replace('/v1', ''),
    recorded.path,
  );
  const sent = split(bodies[0]?.body as Record<string, unknown>, false);
  assert.deepEqual(sent.fields, recorded.fields);
  assert.equal(sent.system, system);
  assert.deepEqual(sent.tools, recorded.tools);
  assert.deepEqual(
    (sent.tools as readonly { readonly name: string }[]).map(
      ({ name }) => name,
    ),
    toolNames,
  );
  // The recorded body continued a long Thread; its first input is the
  // same fresh user request this run sends.
  assert.deepEqual(sent.nonSystemMessages, [recorded.firstMessage]);
});
