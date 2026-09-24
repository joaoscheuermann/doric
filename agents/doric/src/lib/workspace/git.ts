import type { Logger } from 'pino';

import type { Sandbox } from 'sandbox';

import type { ConfigInput } from '../config/schema.js';

/** The configured GitHub block: an identity plus an optional write-only token. */
export type GithubIdentity = NonNullable<ConfigInput['github']>;

interface Context {
  readonly logger: Logger;
  readonly projectId: string;
}

/** The one variable that carries the credential line into the sandbox process. */
const CREDENTIAL_ENV = 'DORIC_GIT_CREDENTIAL';

/**
 * The credential write: one line copied from that environment variable, with
 * `umask 077` creating the store with mode 0600. The token never reaches argv.
 */
const CREDENTIAL_SCRIPT = `umask 077 && printf '%s\\n' "$${CREDENTIAL_ENV}" > "$HOME/.git-credentials"`;

/**
 * Applies the configured GitHub identity to one Project sandbox and, when a
 * token is configured, the credential store Git authenticates `github.com` with.
 * Every effect goes through `sandbox.exec`, and the token travels only in that
 * process environment: no tool argument, result, event, or log line carries it.
 * The writes are idempotent, and any failure stays a warning that names the
 * Project alone, so a credential can never break the prompt that needed it.
 */
export const applyGitIdentity = async (
  sandbox: Sandbox,
  github: GithubIdentity | undefined,
  { logger, projectId }: Context,
): Promise<void> => {
  if (github === undefined) return;

  try {
    // The identity is not a secret: its values are ordinary Git settings.
    await configure(sandbox, 'user.name', github.username);
    await configure(sandbox, 'user.email', github.email);

    if (github.token === undefined) return;

    await configure(sandbox, 'credential.helper', 'store');
    await storeCredential(sandbox, github.username, github.token);
  } catch {
    logger.warn({ projectId }, 'GitHub identity could not be applied');
  }
};

const configure = async (
  sandbox: Sandbox,
  key: string,
  value: string,
): Promise<void> => {
  const result = await sandbox.exec({
    cmd: ['git', 'config', '--global', key, value],
  });

  if (result.exitCode !== 0) throw new Error('Git configuration failed');
};

/**
 * Writes `https://<username>:<token>@github.com` as the credential for this host,
 * which is the shape the `store` helper matches against.
 */
const storeCredential = async (
  sandbox: Sandbox,
  username: string,
  token: string,
): Promise<void> => {
  const result = await sandbox.exec({
    cmd: ['sh', '-c', CREDENTIAL_SCRIPT],
    env: [`${CREDENTIAL_ENV}=https://${username}:${token}@github.com`],
  });

  if (result.exitCode !== 0) throw new Error('Git credential store failed');
};
