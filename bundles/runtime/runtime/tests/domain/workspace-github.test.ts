import assert from 'node:assert/strict';
import test from 'node:test';

import type { SandboxExecInput } from 'sandbox';

import type { ConfigurationValue } from '../../src/contracts/configuration.js';
import type { Secret } from '../support/credentials.js';
import { fakeSandbox } from '../support/sandbox.js';
import {
  createHarness,
  defaultConfiguration,
  deferred,
  type HarnessRun,
} from './support/harness.js';

/*
 * Ported from agents/doric tests/workspace-github.test.ts (design 57 §13.1,
 * R10): the Git identity and GitHub token resolved through secrets/v1 and the
 * claimed provider credentials through models/v1, applied at acquisition and
 * before a prompt, rewind or resume.
 */

type Credential = Secret;

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
  const environment = fakeSandbox();
  const gates = new Map<string, { started: () => void; held: Promise<void> }>();
  let current = stored;
  const configuration: ConfigurationValue = {
    ...defaultConfiguration,
    ...(choices.git === undefined ? {} : { gitCredentialId: choices.git }),
    ...(choices.token === undefined
      ? {}
      : { githubCredentialId: choices.token }),
  };
  const execute = async ({ job, session }: HarnessRun) => {
    const gate = gates.get(job.prompt);
    gate?.started();
    await gate?.held;
    // A tool result that echoes whatever the agent read in the sandbox.
    if (job.prompt.startsWith('echo '))
      await session.record({
        event: { type: 'tool.finished', output: job.prompt.slice(5) },
      });
    return 'done';
  };
  const harness = createHarness({
    configuration: () => ({
      configuration,
      revision: 1,
      updatedAt: new Date(0).toISOString(),
    }),
    credentials: () => current,
    sandbox: { sandbox: environment as never },
    execute,
  });
  const { service } = harness;
  /** The warnings the runtime logged, as `[fields, message]`. */
  const warnings = {
    get length() {
      return harness.logs.filter(({ level }) => level === 'warn').length;
    },
    all: () =>
      harness.logs
        .filter(({ level }) => level === 'warn')
        .map(({ message, fields }) => [fields, message] as const),
  };
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
    harness,
    service,
    environment,
    warnings,
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
 * The commands that apply credentials to a sandbox: the Git identity and helper
 * settings, the credential-store write, and the `gh` hosts write. Everything
 * else the host runs there — the repository probe above all — is not a
 * credential, so a case counting what a prompt re-applied counts these.
 */
const credentialCommands = (
  environment: ReturnType<typeof fakeSandbox>,
): readonly SandboxExecInput[] =>
  environment.execs.filter(
    ({ cmd, env }) =>
      cmd[0] === 'git' ||
      (env ?? []).some(
        (entry) =>
          entry.startsWith('DORIC_GIT_CREDENTIAL=') ||
          entry.startsWith('DORIC_GH_TOKEN='),
      ),
  );

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

void test('applies the stored identity and token to a leased sandbox', async () => {
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

void test('writes the credential files only when a token is stored', async () => {
  // The identity alone stores no secret, so neither secret file is written and
  // the sandbox's GitHub CLI stays unauthenticated rather than holding an empty
  // one.
  const hostUnderTest = host([identity()], { git: gitId });
  await hostUnderTest.open();

  assert.deepEqual(
    credentialCommands(hostUnderTest.environment).map(({ cmd }) =>
      cmd.join(' '),
    ),
    [
      'git config --global user.name doric-agent',
      'git config --global user.email agent@example.com',
    ],
  );
  assert.equal(
    credentialCommands(hostUnderTest.environment).some(
      ({ cmd }) => cmd[0] === 'sh',
    ),
    false,
  );
});

void test('authenticates a token with no stored identity as the token user', async () => {
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

void test('issues no Git command when no credential is configured', async () => {
  const hostUnderTest = host();
  const { thread } = await hostUnderTest.open();

  const accepted = await hostUnderTest.service.threads.prompt(
    thread.id,
    'hello',
  );
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(credentialCommands(hostUnderTest.environment), []);
});

void test('resolves the kind when the configuration names no credential', async () => {
  const { stored } = configured();
  const hostUnderTest = host(stored);
  await hostUnderTest.open();

  assert.equal(hostUnderTest.environment.execs.length, APPLY_COMMANDS);
  assertTokenIsEnvOnly(hostUnderTest.environment, token().secret, 2);
});

void test('refuses to guess between two credentials of the same kind', async () => {
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

  assert.deepEqual(
    credentialCommands(hostUnderTest.environment).map(({ cmd }) =>
      cmd.join(' '),
    ),
    [
      'git config --global user.name doric-agent',
      'git config --global user.email agent@example.com',
    ],
  );
  assert.equal(hostUnderTest.warnings.length, 1);
  assert.match(String(hostUnderTest.warnings.all()[0]?.[1]), /API_TOKEN/u);
  assert.equal(
    JSON.stringify(hostUnderTest.warnings.all()).includes('ghp_openrouter_key'),
    false,
  );
});

void test("keeps a provider's key out of GitHub authentication", async () => {
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
  assert.deepEqual(
    credentialCommands(hostUnderTest.environment).map(({ cmd }) =>
      cmd.join(' '),
    ),
    [
      'git config --global user.name doric-agent',
      'git config --global user.email agent@example.com',
    ],
  );
  assert.equal(
    credentialCommands(hostUnderTest.environment).some(
      ({ cmd }) => cmd[0] === 'sh',
    ),
    false,
  );
  assert.equal(
    JSON.stringify(hostUnderTest.environment.execs).includes('sk_provider_key'),
    false,
  );
});

void test('re-applies a rotated token and never an unchanged pair', async () => {
  const { stored, choices } = configured();
  const hostUnderTest = host(stored, choices);
  const { thread } = await hostUnderTest.open();
  const writes = () => credentialCommands(hostUnderTest.environment);
  assert.equal(writes().length, APPLY_COMMANDS);

  // The sandbox already holds these credentials, so a prompt issues nothing.
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'one')).status,
    'accepted',
  );
  assert.equal(writes().length, APPLY_COMMANDS);

  const rotated = token('ghp_rotated_token');
  hostUnderTest.store([identity(), rotated]);
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'two')).status,
    'accepted',
  );
  assert.equal(writes().length, APPLY_COMMANDS * 2);
  assert.deepEqual(writes()[APPLY_COMMANDS]?.cmd, [
    'git',
    'config',
    '--global',
    'user.name',
    identity().username,
  ]);
  const [credential, gh] = writes().slice(-2);
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
  assert.equal(writes().length, APPLY_COMMANDS * 2);

  // An emptied store has nothing to apply; it cannot be unset remotely.
  hostUnderTest.store([]);
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'four')).status,
    'accepted',
  );
  assert.equal(writes().length, APPLY_COMMANDS * 2);

  // The host wrote the rotated token into the sandbox, so it stays redacted
  // after the store no longer holds it: the sandbox's credential file is
  // readable by the agent's own tools.
  await hostUnderTest.harness.threadState(thread.id, 'ready');
  const echoed = await hostUnderTest.service.threads.prompt(
    thread.id,
    `echo token=${rotated.secret}`,
  );
  assert.ok(echoed.status === 'accepted');
  await hostUnderTest.harness.waitFor(
    async () =>
      (await hostUnderTest.service.threads.find(thread.id))?.result
        ?.promptId === echoed.promptId,
  );
  const log = JSON.stringify(
    await hostUnderTest.service.threads.events(thread.id, 0),
  );
  assert.equal(log.includes(rotated.secret), false);
  assert.match(log, /token=\[REDACTED\]/u);
});

void test('applies newly saved credentials to a Project that captured none', async () => {
  const hostUnderTest = host();
  const { thread } = await hostUnderTest.open();
  assert.deepEqual(credentialCommands(hostUnderTest.environment), []);

  const { stored } = configured();
  hostUnderTest.store(stored);
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'hello')).status,
    'accepted',
  );
  assert.equal(
    credentialCommands(hostUnderTest.environment).length,
    APPLY_COMMANDS,
  );
  assertTokenIsEnvOnly(hostUnderTest.environment, token().secret, 2);
});

void test('applies the current credentials before a rewound prompt is enqueued', async () => {
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
  assert.equal(
    credentialCommands(hostUnderTest.environment).length,
    APPLY_COMMANDS,
  );
  assertTokenIsEnvOnly(hostUnderTest.environment, token().secret, 2);
});

void test('keeps a prompt usable when the credential write fails, logging no secret', async () => {
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
  for (const warning of hostUnderTest.warnings.all()) {
    assert.deepEqual(warning[0], { projectId: project.id });
    assert.equal(typeof warning[1], 'string');
  }
  const logged = JSON.stringify(hostUnderTest.warnings.all());
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
