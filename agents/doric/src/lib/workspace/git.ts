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
 * The two variables that carry the GitHub identity into the `gh` write. Passing
 * them through the environment keeps the token out of argv, and writing a file
 * rather than exporting `GH_TOKEN` keeps it out of the environment of every
 * later command.
 */
const GH_TOKEN_ENV = 'DORIC_GH_TOKEN';
const GH_USERNAME_ENV = 'DORIC_GH_USERNAME';

/**
 * The credential write: one line copied from that environment variable, with
 * `umask 077` creating the store with mode 0600. The token never reaches argv.
 */
const CREDENTIAL_SCRIPT = `umask 077 && printf '%s\\n' "$${CREDENTIAL_ENV}" > "$HOME/.git-credentials"`;

/**
 * The `gh` write: the `hosts.yml` `gh` reads for `github.com`, created under
 * `umask 077` so it is 0600. `git_protocol: https` keeps `gh repo clone` on the
 * credential store above, and the token and username reach the script only
 * through the environment, as `printf` arguments rather than its format.
 */
const GH_HOSTS_SCRIPT = `umask 077 && mkdir -p "$HOME/.config/gh" && printf 'github.com:\\n    oauth_token: %s\\n    user: %s\\n    git_protocol: https\\n' "$${GH_TOKEN_ENV}" "$${GH_USERNAME_ENV}" > "$HOME/.config/gh/hosts.yml"`;

/**
 * Applies the configured GitHub identity to one Project sandbox and, when a
 * token is configured, the credential store Git authenticates `github.com` with
 * plus the `gh` hosts file that authenticates the same user's GitHub CLI.
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
    await authenticateGh(sandbox, github.username, github.token);
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

/**
 * Writes the `hosts.yml` the sandbox's GitHub CLI authenticates with, so `gh`
 * and Git answer to the one credential applied to the lease.
 */
const authenticateGh = async (
  sandbox: Sandbox,
  username: string,
  token: string,
): Promise<void> => {
  const result = await sandbox.exec({
    cmd: ['sh', '-c', GH_HOSTS_SCRIPT],
    env: [`${GH_TOKEN_ENV}=${token}`, `${GH_USERNAME_ENV}=${username}`],
  });

  if (result.exitCode !== 0)
    throw new Error('GitHub CLI authentication failed');
};
