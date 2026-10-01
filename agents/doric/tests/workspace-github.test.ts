import assert from 'node:assert/strict';
import test from 'node:test';

import { type ConfigInput, defaultConfig } from '../src/lib/config/schema.js';
import type { Credential } from '../src/lib/credentials/kind.js';
import type { ThreadExecution } from '../src/lib/workspace/runtime.js';
import { createWorkspaceService } from '../src/lib/workspace/service.js';
import {
  credentialResolver,
  deferred,
  fakeSandbox,
  pool,
  workspace,
} from './helpers/workspace.js';

/** One identity plus credential write: two `git config`, the helper, Git's store, `gh`. */
const APPLY_COMMANDS = 5;

const gitId = '00000000-0000-4000-8000-00000000000a';
const tokenId = '00000000-0000-4000-8000-00000000000b';

const identity = (username = 'doric-agent', email = 'agent@example.com') => ({
  id: gitId,
  kind: 'GIT' as const,
  name: 'github',
  username,
  email,
});

const token = (secret = 'ghp_configured_token') => ({
  id: tokenId,
  kind: 'API_TOKEN' as const,
  name: 'github',
  secret,
});

/** The stored pair, plus the choices the configuration records for them. */
const configured = () => ({
  stored: [identity(), token()] as readonly Credential[],
  choices: { git: gitId, token: tokenId },
});

/**
 * A ready Project on a scripted sandbox whose stored credentials can be rotated
 * the way `PATCH /credentials/:id` rotates them. `choices` is what the
 * configuration records; leaving a value out makes that integration resolve by
 * kind instead. `open` leases the sandbox, and `run` completes one turn so a
 * later rewind is not refused as busy.
 */
const host = (
  stored: readonly Credential[] = [],
  choices: { readonly git?: string; readonly token?: string } = {},
) => {
  const harness = workspace();
  const environment = fakeSandbox();
  const warnings: unknown[][] = [];
  /** Every secret the host registered for redaction after it stored one. */
  const registered: string[] = [];
  const gates = new Map<string, { started: () => void; held: Promise<void> }>();
  let current = stored;
  const list = () => current;
  const generation = () => ({
    snapshot: {
      configuration: {
        ...defaultConfig,
        ...(choices.git === undefined ? {} : { gitCredentialId: choices.git }),
        ...(choices.token === undefined
          ? {}
          : { githubCredentialId: choices.token }),
      } satisfies ConfigInput,
      revision: 1,
      updatedAt: new Date(0).toISOString(),
    },
    providers: new Map(),
    catalog: { skills: [], tools: [] },
    redactions: () => [
      ...current.flatMap(({ secret }) => (secret ? [secret] : [])),
      ...registered,
    ],
  });
  const execute: ThreadExecution = async ({ job }) => {
    const gate = gates.get(job.prompt);
    gate?.started();
    await gate?.held;
    return 'done';
  };
  const service = createWorkspaceService({
    ...harness.dependencies,
    config: {
      current: generation,
      replace: () => {
        throw new Error('Configuration is not replaced in this test');
      },
    },
    credentials: credentialResolver(list, registered),
    pool: pool(undefined, environment),
    logger: {
      debug: () => undefined,
      error: () => undefined,
      warn: (...args: unknown[]) => {
        warnings.push(args);
      },
    } as never,
    execute,
  });
  const open = async () => {
    const project = await service.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const created = await service.threads.create(project.id, 'Thread');
    if (created.status !== 'created') throw new Error('Thread creation failed');
    return { project, thread: created.thread };
  };
  const run = async (threadId: string, prompt: string) => {
    const started = deferred();
    const held = deferred();
    gates.set(prompt, { started: started.resolve, held: held.promise });
    const accepted = await service.threads.prompt(threadId, prompt);
    if (accepted.status !== 'accepted')
      throw new Error(`Prompt was not accepted: ${accepted.status}`);
    await started.promise;
    held.resolve();
    await harness.threadState(threadId, 'ready');
    return accepted.promptId;
  };
  return {
    service,
    environment,
    warnings,
    registered,
    /** Replaces the stored credentials, the way the credentials API does. */
    store: (next: readonly Credential[]) => {
      current = next;
    },
    open,
    run,
  };
};

const commands = (
  environment: ReturnType<typeof fakeSandbox>,
): readonly string[] => environment.execs.map(({ cmd }) => cmd.join(' '));

/**
 * The token may leave the host only through a sandbox process environment: one
 * entry per secret write, and never a command line.
 */
const assertTokenIsEnvOnly = (
  environment: ReturnType<typeof fakeSandbox>,
  token: string,
  writes: number,
): void => {
  const entries = environment.execs.flatMap(({ env }) => env ?? []);
  assert.equal(
    entries.filter((entry) => entry.includes(token)).length,
    writes,
    'each secret write must carry the token in exactly one environment entry',
  );
  assert.equal(
    commands(environment).some((cmd) => cmd.includes(token)),
    false,
    'no command line may carry the token',
  );
};

test('applies the stored identity and token to a leased sandbox', async () => {
  const { stored, choices } = configured();
  const [git, api] = stored;
  const hostUnderTest = host(stored, choices);
  await hostUnderTest.open();

  const [name, email, helper, credential, gh] = hostUnderTest.environment.execs;
  assert.deepEqual(name?.cmd, [
    'git',
    'config',
    '--global',
    'user.name',
    git?.username,
  ]);
  assert.deepEqual(email?.cmd, [
    'git',
    'config',
    '--global',
    'user.email',
    git?.email,
  ]);
  assert.deepEqual(helper?.cmd, [
    'git',
    'config',
    '--global',
    'credential.helper',
    'store',
  ]);
  assert.deepEqual(credential?.cmd.slice(0, 2), ['sh', '-c']);
  assert.equal(hostUnderTest.environment.execs.length, APPLY_COMMANDS);

  // The script reads the variable the exec provides, creates the store 0600,
  // and never mentions the token.
  const [setting] = credential?.env ?? [];
  assert.equal(
    setting,
    `DORIC_GIT_CREDENTIAL=https://${git?.username}:${api?.secret}@github.com`,
  );
  const variable = setting?.split('=')[0] ?? '';
  const script = credential?.cmd[2] ?? '';
  assert.ok(script.includes(`"$${variable}"`));
  assert.ok(script.includes('"$HOME/.git-credentials"'));
  assert.ok(script.includes('umask 077'));
  assert.ok(script.includes('printf'));

  // The `gh` write reads its token and username from the environment too, so the
  // sandbox's GitHub CLI is authenticated from the same stored credential pair.
  assert.deepEqual(gh?.cmd.slice(0, 2), ['sh', '-c']);
  assert.deepEqual(gh?.env, [
    `DORIC_GH_TOKEN=${api?.secret}`,
    `DORIC_GH_USERNAME=${git?.username}`,
  ]);
  const ghScript = gh?.cmd[2] ?? '';
  assert.ok(ghScript.includes('umask 077'));
  assert.ok(ghScript.includes('mkdir -p "$HOME/.config/gh"'));
  assert.ok(ghScript.includes('"$HOME/.config/gh/hosts.yml"'));
  assert.ok(ghScript.includes('github.com:'));
  assert.ok(ghScript.includes('oauth_token: %s'));
  assert.ok(ghScript.includes('user: %s'));
  assert.ok(ghScript.includes('git_protocol: https'));
  assert.ok(ghScript.includes('"$DORIC_GH_TOKEN"'));
  assert.ok(ghScript.includes('"$DORIC_GH_USERNAME"'));
  assertTokenIsEnvOnly(hostUnderTest.environment, api?.secret ?? '', 2);
});

test('writes the credential files only when a token is stored', async () => {
  // The identity alone stores no secret, so neither secret file is written and
  // the sandbox's GitHub CLI stays unauthenticated rather than holding an empty
  // one.
  const hostUnderTest = host([identity()], { git: gitId });
  await hostUnderTest.open();

  assert.deepEqual(commands(hostUnderTest.environment), [
    'git config --global user.name doric-agent',
    'git config --global user.email agent@example.com',
  ]);
  assert.equal(
    hostUnderTest.environment.execs.some(({ cmd }) => cmd[0] === 'sh'),
    false,
  );
});

test('authenticates a token with no stored identity as the token user', async () => {
  const hostUnderTest = host([token()], { token: tokenId });
  await hostUnderTest.open();

  const [helper, credential, gh] = hostUnderTest.environment.execs;
  assert.deepEqual(helper?.cmd, [
    'git',
    'config',
    '--global',
    'credential.helper',
    'store',
  ]);
  assert.equal(
    credential?.env?.[0],
    'DORIC_GIT_CREDENTIAL=https://oauth2:ghp_configured_token@github.com',
  );
  assert.equal(gh?.env?.[1], 'DORIC_GH_USERNAME=oauth2');
});

test('issues no Git command when no credential is configured', async () => {
  const hostUnderTest = host();
  const { thread } = await hostUnderTest.open();

  const accepted = await hostUnderTest.service.threads.prompt(
    thread.id,
    'hello',
  );
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(hostUnderTest.environment.execs, []);
});

test('resolves the kind when the configuration names no credential', async () => {
  const { stored } = configured();
  const hostUnderTest = host(stored);
  await hostUnderTest.open();

  assert.equal(hostUnderTest.environment.execs.length, APPLY_COMMANDS);
  assertTokenIsEnvOnly(hostUnderTest.environment, token().secret, 2);
});

test('refuses to guess between two credentials of the same kind', async () => {
  // Two stored API_TOKEN credentials with no configured choice: taking one would
  // be a guess about which secret authenticates GitHub, so the token half stays
  // off and the warning names the kind. The Git identity is unambiguous, so it is
  // still applied.
  const other = {
    ...token('ghp_openrouter_key'),
    id: '00000000-0000-4000-8000-00000000000c',
    name: 'OPENROUTER_API_KEY',
  };
  const hostUnderTest = host([identity(), token(), other]);
  await hostUnderTest.open();

  assert.deepEqual(commands(hostUnderTest.environment), [
    'git config --global user.name doric-agent',
    'git config --global user.email agent@example.com',
  ]);
  assert.equal(hostUnderTest.warnings.length, 1);
  assert.match(String(hostUnderTest.warnings[0]?.[1]), /API_TOKEN/u);
  assert.equal(
    JSON.stringify(hostUnderTest.warnings).includes('ghp_openrouter_key'),
    false,
  );
});

test("keeps a provider's key out of GitHub authentication", async () => {
  // The only stored API_TOKEN is the one a provider uses, and the configuration
  // names no GitHub credential. A provider key and a GitHub token are the same
  // kind, so a fallback that ignored the provider's claim would write that key
  // into the sandbox's git credential store and `gh` hosts file.
  const providerKey = {
    ...token('sk_provider_key'),
    // The id the default configuration's provider references, so the provider
    // really does claim this credential.
    id: '00000000-0000-4000-8000-000000000002',
    name: 'OPENROUTER_API_KEY',
  };
  const hostUnderTest = host([identity(), providerKey]);
  await hostUnderTest.open();

  // The identity is still applied; no secret file is written, and the key never
  // reaches the sandbox.
  assert.deepEqual(commands(hostUnderTest.environment), [
    'git config --global user.name doric-agent',
    'git config --global user.email agent@example.com',
  ]);
  assert.equal(
    hostUnderTest.environment.execs.some(({ cmd }) => cmd[0] === 'sh'),
    false,
  );
  assert.equal(
    JSON.stringify(hostUnderTest.environment.execs).includes('sk_provider_key'),
    false,
  );
});

test('re-applies a rotated token and never an unchanged pair', async () => {
  const { stored, choices } = configured();
  const hostUnderTest = host(stored, choices);
  const { thread } = await hostUnderTest.open();
  assert.equal(hostUnderTest.environment.execs.length, APPLY_COMMANDS);
  // The credentials the sandbox received are the ones in force, so nothing has
  // been learned for redaction yet.
  assert.deepEqual(hostUnderTest.registered, []);

  // The sandbox already holds these credentials, so a prompt issues nothing.
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'one')).status,
    'accepted',
  );
  assert.equal(hostUnderTest.environment.execs.length, APPLY_COMMANDS);
  assert.deepEqual(hostUnderTest.registered, []);

  const rotated = token('ghp_rotated_token');
  hostUnderTest.store([identity(), rotated]);
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'two')).status,
    'accepted',
  );
  assert.equal(hostUnderTest.environment.execs.length, APPLY_COMMANDS * 2);
  // The host just wrote the rotated token into the sandbox, so it is registered
  // for redaction before an event can carry it: the sandbox's credential file is
  // readable by the agent's own tools.
  assert.deepEqual(hostUnderTest.registered, ['ghp_rotated_token']);
  assert.deepEqual(hostUnderTest.environment.execs[APPLY_COMMANDS]?.cmd, [
    'git',
    'config',
    '--global',
    'user.name',
    identity().username,
  ]);
  const [credential, gh] = hostUnderTest.environment.execs.slice(-2);
  assert.equal(
    credential?.env?.[0],
    `DORIC_GIT_CREDENTIAL=https://${identity().username}:${rotated.secret}@github.com`,
  );
  assert.equal(gh?.env?.[0], `DORIC_GH_TOKEN=${rotated.secret}`);
  assertTokenIsEnvOnly(hostUnderTest.environment, rotated.secret, 2);

  // The rotation is now the sandbox's credentials too, so nothing runs again.
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'three')).status,
    'accepted',
  );
  assert.equal(hostUnderTest.environment.execs.length, APPLY_COMMANDS * 2);

  // An emptied store has nothing to apply; it cannot be unset remotely.
  hostUnderTest.store([]);
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'four')).status,
    'accepted',
  );
  assert.equal(hostUnderTest.environment.execs.length, APPLY_COMMANDS * 2);
});

test('applies newly saved credentials to a Project that captured none', async () => {
  const hostUnderTest = host();
  const { thread } = await hostUnderTest.open();
  assert.deepEqual(hostUnderTest.environment.execs, []);

  const { stored } = configured();
  hostUnderTest.store(stored);
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'hello')).status,
    'accepted',
  );
  assert.equal(hostUnderTest.environment.execs.length, APPLY_COMMANDS);
  assertTokenIsEnvOnly(hostUnderTest.environment, token().secret, 2);
});

test('applies the current credentials before a rewound prompt is enqueued', async () => {
  const hostUnderTest = host();
  const { thread } = await hostUnderTest.open();
  const promptId = await hostUnderTest.run(thread.id, 'first');

  const { stored } = configured();
  hostUnderTest.store(stored);
  const rewound = await hostUnderTest.service.threads.rewind(
    thread.id,
    promptId,
    'edited',
  );
  assert.equal(rewound.status, 'accepted');
  assert.equal(hostUnderTest.environment.execs.length, APPLY_COMMANDS);
  assertTokenIsEnvOnly(hostUnderTest.environment, token().secret, 2);
});

test('keeps a prompt usable when the credential write fails, logging no secret', async () => {
  const { choices } = configured();
  const hostUnderTest = host(
    [identity(), token('ghp_original_token')],
    choices,
  );
  const { project, thread } = await hostUnderTest.open();

  // The rotated writes fail: one by rejecting, one by exiting non-zero. Neither
  // may break the prompt that needed the credential.
  const rejected = 'ghp_rejected_token';
  const exited = 'ghp_exiting_token';
  const exec = hostUnderTest.environment.exec;
  let writes = 0;
  hostUnderTest.environment.exec = async (input) => {
    if (input.cmd[0] !== 'sh') return exec(input);
    writes += 1;
    if (writes === 1) throw new Error(`Credential write failed: ${rejected}`);
    return { ...(await exec(input)), exitCode: 1 };
  };

  hostUnderTest.store([identity(), token(rejected)]);
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'hello')).status,
    'accepted',
  );
  hostUnderTest.store([identity(), token(exited)]);
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'again')).status,
    'accepted',
  );

  // Each warning names the Project and carries nothing else.
  assert.equal(hostUnderTest.warnings.length, 2);
  for (const warning of hostUnderTest.warnings) {
    assert.deepEqual(warning[0], { projectId: project.id });
    assert.equal(typeof warning[1], 'string');
  }
  const logged = JSON.stringify(hostUnderTest.warnings);
  assert.equal(logged.includes(rejected), false);
  assert.equal(logged.includes(exited), false);

  // The delivered credentials are the ones the sandbox received, so no retry
  // loop.
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'third')).status,
    'accepted',
  );
  assert.equal(hostUnderTest.warnings.length, 2);
});
