import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import pino from 'pino';
import pretty from 'pino-pretty';

import { createAgent, createToolCallStorage } from 'agent';
import { createFetchTransport, createUnifiedProvider } from 'llms';
import { createMessageStorage } from 'messages';
import { createToolStorage } from 'tool';

const createRecorder = (directory, logger, onRecord) => {
  let sequence = 0;

  return async (stage, data) => {
    const entry = { at: new Date().toISOString(), stage, data };

    await appendFile(
      join(directory, 'trace.jsonl'),
      JSON.stringify(entry) + '\n',
    );

    if (
      stage !== 'usage' &&
      !stage.endsWith('.input') &&
      !stage.endsWith('.observation')
    ) {
      const prefix = String(++sequence).padStart(6, '0');
      const name = stage.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
      const stages = join(directory, 'stages');

      await mkdir(stages, { recursive: true });

      await writeFile(
        join(stages, prefix + '-' + name + '.json'),
        JSON.stringify(entry, null, 2) + '\n',
        { flag: 'wx' },
      );
    }

    logger.info({ stage }, 'Stage recorded');

    await onRecord?.(entry);

    return data;
  };
};

/** Measure each provider invocation, including intermediate tool-loop turns. */
const measureProvider = (
  provider,
  stage,
  { logger, record, usage, signal },
) => {
  const call = async (operation, request) => {
    const started = Date.now();

    logger.info({ stage, operation, model: request.model }, 'Provider call');

    signal?.throwIfAborted();

    const response = await provider[operation]({
      ...request,
      signal: signal ?? request.signal,
    });

    const entry = {
      stage,
      operation,
      model: request.model,
      durationMs: Date.now() - started,
      usage: response.usage ?? null,
    };

    usage.push(entry);

    await record('usage', entry);

    return response;
  };

  return {
    ...provider,
    complete: (request) => call('complete', request),
    embedding: (request) => call('embedding', request),
    rerank: (request) => call('rerank', request),
  };
};

/** One session owns its conversation and observation ledger across submissions. */
const createSession = (
  runtime,
  { stage, system, profile, tools = false, extraTools = [] },
) => {
  const { config, sandbox, record, core, signal, observeTool } = runtime;

  const instructions = tools
    ? `${system}

# Always-available skills

${core.skills
  .filter(({ alwaysAvailable }) => alwaysAvailable)
  .map(({ skill }) => `## ${skill.name}\n\n${skill.body}`)
  .join('\n\n')}`
    : system;
  const observations = createToolCallStorage();

  const agent = createAgent({
    provider: runtime.measured(stage),
    model: config[profile],
    effort:
      profile === 'executionModel' ? config.executionEffort : config.effort,
    system: instructions,
    tools: createToolStorage(
      tools
        ? [
            ...core.tools.map(({ factory }) => factory(sandbox)),
            ...extraTools.map((factory) => factory(sandbox)),
          ]
        : [],
    ),
    messages: createMessageStorage(),
    toolCalls: observations,
    flags: { sensitiveOutput: true },
  });

  const onToolEvent = async (event) => {
    await observeTool?.(event);

    if (event.type === 'tool.finished') {
      await record(stage + '.observation', event.record);
    }
  };

  const complete = async (input, schema) => {
    await record(stage + '.input', { system: instructions, input });

    const response = await agent.complete(input, {
      schema,
      maxTurns: config.maxTurns,
      signal,
      onToolEvent,
    });

    return record(stage, schema.parse(response.structured));
  };

  return { observations: () => observations.list(), complete };
};

/** Compose provider access, sessions and experiment evidence in one place. */
export const createRuntime = ({
  directory,
  sandbox,
  config,
  core,
  provider: suppliedProvider,
  environment: suppliedEnvironment,
  signal,
  onRecord,
  onToolEvent: observeTool,
}) => {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();

  if (!suppliedProvider && !apiKey) {
    throw new Error('OPENROUTER_API_KEY is required.');
  }

  const logger = pino(pretty({ sync: true, destination: 2 }));

  const provider =
    suppliedProvider ??
    createUnifiedProvider({
      transport: createFetchTransport(),
      apiKey,
      logger,
    });
  const record = createRecorder(directory, logger, onRecord);
  const usage = [];
  const telemetry = { logger, record, usage, signal };
  const measured = (stage) => measureProvider(provider, stage, telemetry);

  const sessionOptions = {
    config,
    sandbox,
    record,
    measured,
    core,
    signal,
    observeTool,
  };
  const agent = (options) => createSession(sessionOptions, options);

  const complete = ({
    stage,
    system,
    input,
    schema,
    profile = 'planningModel',
  }) => {
    const session = agent({ stage, system, profile });

    return session.complete(input, schema);
  };

  const environment = `# Execution environment

Workspace: ${sandbox.root}
Linux Docker (${config.sandbox.image}), /bin/sh, Node.js and standard Debian utilities.
Container networking is disabled; web uses the host network. Respect task restrictions on external data.`;

  return {
    logger,
    record,
    measured,
    complete,
    agent,
    usage,
    workspace: sandbox.root,
    alwaysAvailableSkills: core.skills
      .filter(({ alwaysAvailable }) => alwaysAvailable)
      .map(({ skill }) => skill),
    config,
    environment: suppliedEnvironment ?? environment,
  };
};
