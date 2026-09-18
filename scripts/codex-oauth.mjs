#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CODEX_AUTHORIZATION_ENV_KEY,
  CODEX_OAUTH_CALLBACK_HOST,
  CODEX_OAUTH_CALLBACK_PATH,
  CODEX_OAUTH_CALLBACK_PORT,
  CODEX_OAUTH_FALLBACK_CALLBACK_PORT,
  createCodexOAuth,
  createFetchTransport,
  createLocalCallbackServer,
  openBrowser,
} from 'oauth';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(ROOT_DIR, '.env');

const HELP = `Usage: npm run codex:oauth

Starts a Codex OAuth authorization-code flow in your browser and writes the
resulting authorization header to root .env.

Configuration:
  CODEX_OAUTH_CLIENT_ID          Optional OAuth client id override.
  CODEX_OAUTH_CLIENT_SECRET      Optional OAuth client secret.
  CODEX_OAUTH_SCOPE              Optional OAuth scope override.
  CODEX_OAUTH_CALLBACK_HOST      Optional callback host. Defaults to ${CODEX_OAUTH_CALLBACK_HOST}.
  CODEX_OAUTH_CALLBACK_PORT      Optional callback port. Defaults to ${CODEX_OAUTH_CALLBACK_PORT}, falling back to ${CODEX_OAUTH_FALLBACK_CALLBACK_PORT} when busy.
  CODEX_OAUTH_CALLBACK_PATH      Optional callback path. Defaults to ${CODEX_OAUTH_CALLBACK_PATH}.
  CODEX_OAUTH_OUTPUT_KEY         Optional .env output key. Defaults to CODEX_AUTHORIZATION.

The script never prints the token or existing .env contents.`;
const hasHelpFlag = (args) =>
  args.some((arg) => arg === '--help' || arg === '-h');

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

  return [key, unquote(value)];
};

const unquote = (value) => {
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
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

const parsePort = (value) => {
  const raw = optional(value);

  if (raw === undefined) {
    return undefined;
  }

  const port = Number.parseInt(raw, 10);

  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65_535 ||
    String(port) !== raw
  ) {
    throw new Error(
      'CODEX_OAUTH_CALLBACK_PORT must be an integer from 0 to 65535.',
    );
  }

  return port;
};

const assertOutputKey = (key) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error('CODEX_OAUTH_OUTPUT_KEY must be a valid .env key.');
  }

  return key;
};

const envLinePattern = (key) =>
  new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const serializeEnvValue = (value) => JSON.stringify(value);

const writeEnvKey = async (contents, key, value) => {
  const linePattern = envLinePattern(key);
  const lineEnding = contents.includes('\r\n') ? '\r\n' : '\n';
  const lines = contents === '' ? [] : contents.split(/\r?\n/);
  const hasTrailingNewline = contents === '' || /\r?\n$/.test(contents);
  const nextLine = `${key}=${serializeEnvValue(value)}`;
  let replaced = false;

  const nextLines = lines.flatMap((line) => {
    if (!linePattern.test(line)) {
      return [line];
    }

    if (replaced) {
      return [];
    }

    replaced = true;

    return [nextLine];
  });

  if (!replaced) {
    if (nextLines.length === 0) {
      nextLines.push(nextLine);
    } else if (nextLines.at(-1) !== '') {
      nextLines.push(nextLine);
    } else {
      nextLines[nextLines.length - 1] = nextLine;
    }
  }

  const nextContents = `${nextLines.join(lineEnding)}${hasTrailingNewline ? lineEnding : ''}`;

  await writeFile(ENV_PATH, nextContents, 'utf8');
};

const tokenStore = () => {
  let record;

  return {
    async load() {
      return record;
    },

    async save(next) {
      record = next;
    },
  };
};

const errorMessage = (error) =>
  error instanceof Error ? error.message : String(error);

const log = (message) => {
  console.log(`[codex:oauth] ${message}`);
};

const isAddressInUse = (error) =>
  error instanceof Error && error.code === 'EADDRINUSE';

const createCodexCallbackServer = async (env) => {
  const configuredPort = parsePort(env.CODEX_OAUTH_CALLBACK_PORT);

  const options = {
    host: optional(env.CODEX_OAUTH_CALLBACK_HOST) ?? CODEX_OAUTH_CALLBACK_HOST,
    port: configuredPort ?? CODEX_OAUTH_CALLBACK_PORT,
    path: optional(env.CODEX_OAUTH_CALLBACK_PATH) ?? CODEX_OAUTH_CALLBACK_PATH,
  };

  try {
    return await createLocalCallbackServer(options);
  } catch (error) {
    if (configuredPort !== undefined || !isAddressInUse(error)) {
      throw error;
    }

    return createLocalCallbackServer({
      ...options,
      port: CODEX_OAUTH_FALLBACK_CALLBACK_PORT,
    });
  }
};

const authorize = async () => {
  const envContents = await readEnvFile();
  const env = mergedEnv(parseEnv(envContents));

  const outputKey = assertOutputKey(
    optional(env.CODEX_OAUTH_OUTPUT_KEY) ?? CODEX_AUTHORIZATION_ENV_KEY,
  );
  let callbackServer;

  try {
    callbackServer = await createCodexCallbackServer(env);

    const codex = createCodexOAuth({
      transport: createFetchTransport(),
      tokenStore: tokenStore(),
      clientId: optional(env.CODEX_OAUTH_CLIENT_ID),
      clientSecret: optional(env.CODEX_OAUTH_CLIENT_SECRET),
      scope: optional(env.CODEX_OAUTH_SCOPE),
      redirectUri: callbackServer.redirectUri,
      async browserOpener(url) {
        log(`Opening browser. If it does not open, visit:\n${url}`);

        await openBrowser(url);

        log('Waiting for authorization...');
      },
      callbackServer,
    });

    await codex.authorize();

    const credential = await codex.credential();

    await writeEnvKey(await readEnvFile(), outputKey, credential.authorization);

    log(`Saved authorization to .env key ${outputKey}.`);
  } finally {
    await callbackServer?.close();
  }
};

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(HELP);
} else {
  try {
    await authorize();
  } catch (error) {
    console.error(errorMessage(error));

    process.exitCode = 1;
  }
}
