// The .env and process helpers the `*:oauth` scripts share, for one script's
// env prefix (such as `CLAUDE_OAUTH`) and log tag (such as `claude:oauth`).

import { chmod, readFile, writeFile } from 'node:fs/promises';

export const oauthEnv = ({ envPath, prefix, tag }) => {
  const hasHelpFlag = (args) =>
    args.some((arg) => arg === '--help' || arg === '-h');

  const readEnvFile = async () => {
    try {
      return await readFile(envPath, 'utf8');
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
        `${prefix}_CALLBACK_PORT must be an integer from 0 to 65535.`,
      );
    }

    return port;
  };

  const assertOutputKey = (key) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${prefix}_OUTPUT_KEY must be a valid .env key.`);
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
    await writeFile(envPath, nextContents, { encoding: 'utf8', mode: 0o600 });
    await chmod(envPath, 0o600);
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

  const errorMessage = (error) =>
    error instanceof Error ? error.message : String(error);

  const log = (message) => {
    console.log(`[${tag}] ${message}`);
  };

  const isAddressInUse = (error) =>
    error instanceof Error && error.code === 'EADDRINUSE';

  return {
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
  };
};
