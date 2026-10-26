#!/usr/bin/env node

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

import { oauthEnv } from './lib/oauth-env.mjs';

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
const {
  hasHelpFlag,
  readEnvFile,
  parseEnv,
  mergedEnv,
  optional,
  parsePort,
  assertOutputKey,
  writeEnvKey,
  tokenStore,
  errorMessage,
  log,
  isAddressInUse,
} = oauthEnv({ envPath: ENV_PATH, prefix: 'CODEX_OAUTH', tag: 'codex:oauth' });

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

        // The URL above is the way in when no browser opens (a headless
        // machine): the flow keeps waiting for the callback either way.
        await openBrowser(url).catch(() =>
          log('Could not open a browser; visit the URL above.'),
        );

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
