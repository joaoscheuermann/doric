#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { A2AClient } from '@a2a-js/sdk/client';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(ROOT_DIR, '.env');

const REDACTED_KEYS = new Set([
  'authorization',
  'github_token',
  'secret',
  'token',
  'provider_token',
]);
const SECRET_KEY_PATTERN = /(?:authorization|secret|token)/iu;
const SECRET_ENV_KEY_PATTERN = /(?:AUTHORIZATION|SECRET|TOKEN)/iu;

const TEST_PROVIDER = {
  id: 'codex',
  type: 'codex',
};

const TEST_MODEL = {
  id: 'default',
  provider: TEST_PROVIDER.id,
  model: 'gpt-5.5',
};

const TEST_TASK = {
  id: 'coding',
  model: TEST_MODEL.id,
};

const CLI_OPTIONS = new Map([
  ['--repo', 'repoUrl'],
  ['--prompt', 'prompt'],
  ['--contextId', 'contextId'],
]);

const REQUIRED_CLI_OPTIONS = new Map([
  ['repoUrl', '--repo <url>'],
  ['prompt', '--prompt <text>'],
]);

const HELP = `Usage: npm run doric:spawn-agent -- --repo <url> --prompt <text> [options]

Sends Doric's initial A2A message to a running Doric agent server.

Options:
  --repo <url>              Required GitHub repository URL to clone.
  --prompt <text>           Required user prompt sent after config.
  --contextId <id>          Optional A2A context id.
  -h, --help                Show this help.

Configuration:
  AGENT_CARD_URL             Required URL to the A2A Agent Card.
  GITHUB_TOKEN               Required GitHub token for repository access.
  CODEX_AUTHORIZATION        Required Codex provider authorization header.

Values from the shell override root .env for configuration values.

Test configuration:
  Provider                  ${TEST_PROVIDER.id} (${TEST_PROVIDER.type})
  Model                     ${TEST_MODEL.id} -> ${TEST_MODEL.model}
  Task                      ${TEST_TASK.id} -> ${TEST_TASK.model}

The script redacts token-like fields when logging responses.`;

const parseArgs = (args) => {
  const overrides = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      return { help: true, overrides: {} };
    }

    const inlineSeparator = arg.indexOf('=');
    const name = inlineSeparator < 0 ? arg : arg.slice(0, inlineSeparator);
    const envKey = CLI_OPTIONS.get(name);

    if (envKey === undefined) {
      throw new Error(`Unknown option: ${arg}`);
    }

    const inlineValue =
      inlineSeparator < 0 ? undefined : arg.slice(inlineSeparator + 1);

    const value =
      inlineValue === undefined
        ? readOptionValue(args, index, name)
        : inlineValue;

    if (value === '') {
      throw new Error(`${name} requires a value.`);
    }

    overrides[envKey] = value;

    if (inlineValue === undefined) {
      index += 1;
    }
  }

  for (const [key, display] of REQUIRED_CLI_OPTIONS) {
    if (overrides[key] === undefined) {
      throw new Error(`Missing required option: ${display}.`);
    }
  }

  return { help: false, overrides };
};

const readOptionValue = (args, index, name) => {
  const value = args[index + 1];

  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${name} requires a value.`);
  }

  return value;
};

const readEnvFile = async () => {
  try {
    return await readFile(ENV_PATH, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return '';
    }

    throw error;
  }
};

const parseEnv = (contents) =>
  Object.fromEntries(
    contents
      .split(/\r?\n/)
      .map(parseEnvLine)
      .filter((entry) => entry !== undefined),
  );

const parseEnvLine = (line) => {
  const trimmed = line.trim();

  if (trimmed === '' || trimmed.startsWith('#')) {
    return undefined;
  }

  const normalized = trimmed.startsWith('export ')
    ? trimmed.slice('export '.length)
    : line;
  const separator = normalized.indexOf('=');

  if (separator < 1) {
    return undefined;
  }

  const key = normalized.slice(0, separator).trim();
  const value = normalized.slice(separator + 1).trim();

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return undefined;
  }

  return [key, unquote(key, value)];
};

const unquote = (key, value) => {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`${key} has an invalid quoted value.`);
    }
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  return value;
};

const mergedEnv = (fileEnv) => ({
  ...fileEnv,
  ...Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  ),
});

const optional = (value) =>
  value === undefined || value === '' ? undefined : value;

const required = (env, key) => {
  const value = optional(env[key]);

  if (value === undefined) {
    throw new Error(`${key} is required. Set it in root .env or the shell.`);
  }

  return value;
};

const createTextRedactor = (env) => {
  const secrets = Object.entries(env)
    .filter(([key]) => SECRET_ENV_KEY_PATTERN.test(key))
    .map(([, value]) => optional(value))
    .filter((value) => value !== undefined && value.length >= 4);

  return (text) =>
    secrets.reduce(
      (redacted, secret) => redacted.replaceAll(secret, '[redacted]'),
      text,
    );
};

const createConfig = (env, options) => {
  const githubToken = required(env, 'GITHUB_TOKEN');
  const codexAuthorization = required(env, 'CODEX_AUTHORIZATION');

  return {
    github: {
      repo: { url: options.repoUrl },
      token: githubToken,
    },
    providers: [
      {
        ...TEST_PROVIDER,
        token: codexAuthorization,
      },
    ],
    models: [
      {
        ...TEST_MODEL,
      },
    ],
    tasks: [
      {
        ...TEST_TASK,
      },
    ],
  };
};

const createMessageParams = (env, options) => {
  return {
    message: {
      kind: 'message',
      messageId: randomUUID(),
      role: 'user',
      ...(options.contextId === undefined
        ? {}
        : { contextId: options.contextId }),
      metadata: { configuration: createConfig(env, options) },
      parts: [{ kind: 'text', text: options.prompt }],
    },
  };
};

const logJson = (type, value, redactText) => {
  console.log(
    JSON.stringify({ type, value: redact(value, redactText) }, null, 2),
  );
};

const redact = (value, redactText) =>
  redactValue(value, new WeakSet(), redactText);

const redactValue = (value, seen, redactText) => {
  if (typeof value === 'string') {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen, redactText));
  }

  if (!isRecord(value)) {
    return value;
  }

  if (seen.has(value)) {
    return '[circular]';
  }

  seen.add(value);

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      isSecretKey(key) ? '[redacted]' : redactValue(child, seen, redactText),
    ]),
  );
};

const isSecretKey = (key) =>
  REDACTED_KEYS.has(key.toLowerCase()) || SECRET_KEY_PATTERN.test(key);

const isRecord = (value) => typeof value === 'object' && value !== null;

const errorMessage = (error) =>
  error instanceof Error ? error.message : String(error);

const sendWithStreamingFallback = async (client, params, redactText) => {
  let streamed = false;

  try {
    for await (const event of client.sendMessageStream(params)) {
      streamed = true;

      logJson('stream-event', event, redactText);
    }

    return;
  } catch (error) {
    if (streamed) {
      throw error;
    }

    console.error(
      `Streaming unavailable; falling back to sendMessage: ${redactText(
        errorMessage(error),
      )}`,
    );
  }

  logJson(
    'send-message-response',
    await client.sendMessage(params),
    redactText,
  );
};

const run = async (options) => {
  const env = mergedEnv(parseEnv(await readEnvFile()));
  const redactText = createTextRedactor(env);

  try {
    const params = createMessageParams(env, options);
    const client = await A2AClient.fromCardUrl(required(env, 'AGENT_CARD_URL'));

    await sendWithStreamingFallback(client, params, redactText);
  } catch (error) {
    throw new Error(redactText(errorMessage(error)), { cause: error });
  }
};

try {
  const { help, overrides } = parseArgs(process.argv.slice(2));

  if (help) {
    console.log(HELP);
  } else {
    await run(overrides);
  }
} catch (error) {
  console.error(errorMessage(error));

  process.exitCode = 1;
}
