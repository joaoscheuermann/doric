#!/usr/bin/env node

import { chmod, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import {
  CLAUDE_AUTHORIZATION_ENV_KEY,
  CLAUDE_OAUTH_CALLBACK_HOST,
  CLAUDE_OAUTH_CALLBACK_PATH,
  CLAUDE_OAUTH_CALLBACK_PORT,
  CLAUDE_OAUTH_FALLBACK_CALLBACK_PORT,
  CLAUDE_OAUTH_HOSTED_REDIRECT_URI,
  createClaudeOAuth,
  createFetchTransport,
  createLocalCallbackServer,
  openBrowser,
  resolveClaudeAuth,
} from 'oauth';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(ROOT_DIR, '.env');

const HELP = `Usage: npm run claude:oauth [-- --no-browser]

Starts a Claude Code OAuth authorization-code flow in your browser and writes
the resulting authorization header to root .env.

Configuration:
  CLAUDE_OAUTH_CLIENT_ID          Optional OAuth client id override.
  CLAUDE_OAUTH_SCOPE              Optional OAuth scope override.
  CLAUDE_OAUTH_CALLBACK_HOST      Optional callback host. Defaults to ${CLAUDE_OAUTH_CALLBACK_HOST}.
  CLAUDE_OAUTH_CALLBACK_PORT      Optional callback port. Defaults to ${CLAUDE_OAUTH_CALLBACK_PORT}, falling back to ${CLAUDE_OAUTH_FALLBACK_CALLBACK_PORT} when busy.
  CLAUDE_OAUTH_CALLBACK_PATH      Optional callback path. Defaults to ${CLAUDE_OAUTH_CALLBACK_PATH}.
  CLAUDE_OAUTH_OUTPUT_KEY         Optional .env output key. Defaults to ${CLAUDE_AUTHORIZATION_ENV_KEY}.
  CLAUDE_OAUTH_NO_BROWSER         Set to 1 to paste the authorization code by hand.

An existing long-lived Claude Code login (CLAUDE_CODE_OAUTH_TOKEN, or a
~/.claude login good for 30 more days) is used when one is present; otherwise
a fresh login replaces the stored value. The value already stored under the
output key is never what is reused. The script never prints the token or
existing .env contents.`;
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
      'CLAUDE_OAUTH_CALLBACK_PORT must be an integer from 0 to 65535.',
    );
  }

  return port;
};

const assertOutputKey = (key) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error('CLAUDE_OAUTH_OUTPUT_KEY must be a valid .env key.');
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

  // The file holds a year-long bearer token: private on creation, and
  // tightened when it already existed.
  await writeFile(ENV_PATH, nextContents, { encoding: 'utf8', mode: 0o600 });
  await chmod(ENV_PATH, 0o600);
};

const tokenStore = () => {
  let record;

  return {
    load() {
      return Promise.resolve(record);
    },

    save(next) {
      record = next;

      return Promise.resolve();
    },
  };
};

const prompt = async (question) => {
  const rl = createInterface({ input, output });

  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
};

const errorMessage = (error) =>
  error instanceof Error ? error.message : String(error);

const log = (message) => {
  console.log(`[claude:oauth] ${message}`);
};

const isAddressInUse = (error) =>
  error instanceof Error && error.code === 'EADDRINUSE';

/**
 * How long a reused login must still be good for: Claude Code's own access
 * tokens expire within hours, and nothing refreshes the copy in .env.
 */
const REUSE_MIN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const createClaudeCallbackServer = async (env) => {
  const configuredPort = parsePort(env.CLAUDE_OAUTH_CALLBACK_PORT);

  const options = {
    host:
      optional(env.CLAUDE_OAUTH_CALLBACK_HOST) ?? CLAUDE_OAUTH_CALLBACK_HOST,
    port: configuredPort ?? CLAUDE_OAUTH_CALLBACK_PORT,
    path:
      optional(env.CLAUDE_OAUTH_CALLBACK_PATH) ?? CLAUDE_OAUTH_CALLBACK_PATH,
  };

  try {
    return await createLocalCallbackServer(options);
  } catch (error) {
    if (configuredPort !== undefined || !isAddressInUse(error)) {
      throw error;
    }

    return createLocalCallbackServer({
      ...options,
      port: CLAUDE_OAUTH_FALLBACK_CALLBACK_PORT,
    });
  }
};

/**
 * The paste-mode callback: no local server, so the code the browser shows is
 * the one pasted here, with the state the flow expects.
 */
const pasteCallbackServer = {
  async waitForCallback() {
    // Claude's hosted page shows `code#state`. The state is required: the
    // flow checks it against the one it sent, so a code from another
    // sign-in is refused.
    const [code, state] = (await prompt('Paste the authorization code: '))
      .trim()
      .split('#');

    if (code === '' || state === undefined || state === '') {
      throw new Error(
        'Paste the whole code the page shows, including the part after #.',
      );
    }

    return { code, state };
  },
};

/**
 * Saves an existing long-lived Claude Code login and answers whether it did.
 * The output key's own value is hidden from the resolver, so a stored (and
 * maybe expired) value never stands in for a fresh login, and any resolve
 * failure is a reason to sign in fresh rather than to stop.
 */
const saveExistingLogin = async (env, envContents, outputKey) => {
  const resolverEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => key !== outputKey),
  );
  let existing;

  try {
    // Read without refreshing: a refresh rotates the refresh token Claude
    // Code holds, which is only worth it for a login this script keeps. The
    // macOS Keychain is skipped: Claude Code's own login there lives hours,
    // never the 30 days a reuse needs, so asking to read it is a wasted prompt.
    existing = await resolveClaudeAuth({
      env: resolverEnv,
      refresh: false,
      keychain: false,
    });
  } catch {
    return false;
  }

  if (
    existing.expiresAt !== undefined &&
    existing.expiresAt - Date.now() < REUSE_MIN_LIFETIME_MS
  ) {
    log('The existing Claude Code login expires soon; signing in fresh.');

    return false;
  }

  log('Using existing Claude Code login.');

  await writeEnvKey(envContents, outputKey, existing.authorization);

  log(`Saved authorization to .env key ${outputKey}.`);

  return true;
};

const authorize = async () => {
  const envContents = await readEnvFile();
  const env = mergedEnv(parseEnv(envContents));

  const outputKey = assertOutputKey(
    optional(env.CLAUDE_OAUTH_OUTPUT_KEY) ?? CLAUDE_AUTHORIZATION_ENV_KEY,
  );

  if (await saveExistingLogin(env, envContents, outputKey)) {
    return;
  }

  const noBrowser =
    process.argv.slice(2).includes('--no-browser') ||
    optional(env.CLAUDE_OAUTH_NO_BROWSER) === '1';
  let callbackServer;

  try {
    callbackServer =
      noBrowser === true ? undefined : await createClaudeCallbackServer(env);

    const claude = createClaudeOAuth({
      transport: createFetchTransport(),
      tokenStore: tokenStore(),
      clientId: optional(env.CLAUDE_OAUTH_CLIENT_ID),
      scope: optional(env.CLAUDE_OAUTH_SCOPE),
      redirectUri:
        noBrowser === true
          ? CLAUDE_OAUTH_HOSTED_REDIRECT_URI
          : callbackServer.redirectUri,
      async browserOpener(url) {
        if (noBrowser === true) {
          log(
            `Paste-mode flow. Visit the authorize URL and paste the code:\n${url}`,
          );

          return;
        }

        log(`Opening browser. If it does not open, visit:\n${url}`);

        // The URL above is the way in when no browser opens (a headless
        // machine): the flow keeps waiting for the callback either way.
        await openBrowser(url).catch(() =>
          log('Could not open a browser; visit the URL above.'),
        );

        log('Waiting for authorization...');
      },
      callbackServer: noBrowser === true ? pasteCallbackServer : callbackServer,
    });

    await claude.authorize();

    const credential = await claude.credential();

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
