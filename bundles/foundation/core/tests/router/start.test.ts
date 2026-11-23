// The credential host-start step (S41c): `core` registers, in process and
// as its own instance, a handler of `doric.app.hooks/v1` `onHostStartHook`
// (a sequence). When the platform (`doric`) runs that hook through
// `hooks/v1.Run`, the handler connects the storage backend, enters the
// `credential_activation` startup stage, logs "Activating stored
// credentials" and loads the stored credentials, and any step's failure
// fails the run (so the host's start), as today's `activateCredentials`
// does. The platform's boot and `doric.startup/v1` come with S61; here
// `doric.startup/v1` is the fake of `serveCore`.

import assert from 'node:assert/strict';
import test from 'node:test';

import { create } from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import { ConnectError } from '@connectrpc/connect';
import { ContractError, fromConnectError } from 'bundle/contracts';
import { HooksService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { OnHostStartHookInputSchema } from 'bundle/contracts/gen/doric/platform/app/hooks/v1/hooks_pb.js';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';

import { type RoutedCore, serveCore } from '../support/router.js';

const APP_HOOKS = 'doric.app.hooks/v1';
const ON_HOST_START = 'onHostStartHook';

/** One stored credential, so the load has a row to read. */
const STORED = {
  id: 'cred-1',
  kind: 'API_TOKEN',
  name: 'Primary',
  secret: 'sk-stored',
};

const withCore = async (run: (core: RoutedCore) => Promise<void>) => {
  const core = await serveCore({ secretsOptions: { rows: [STORED] } });

  try {
    await run(core);
  } finally {
    await core.close();
  }
};

/**
 * What the platform's boot does: `doric` defines `doric.app.hooks/v1` and
 * runs `onHostStartHook` through `hooks/v1`.
 */
const runHostStart = async (core: RoutedCore) => {
  const hooks = core.client(HooksService, 'doric');

  await hooks.define({ contract: APP_HOOKS });

  return await hooks.run({
    contract: APP_HOOKS,
    hook: ON_HOST_START,
    input: anyPack(
      OnHostStartHookInputSchema,
      create(OnHostStartHookInputSchema),
    ),
  });
};

const rejectsWith = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ConnectError, `not a ConnectError: ${error}`);
    assert.equal(fromConnectError(error).code, code, error.message);

    return true;
  });
};

void test("doric's Run of onHostStartHook connects storage, enters credential_activation, logs, then loads the credentials once", async () => {
  await withCore(async (core) => {
    await runHostStart(core);

    assert.deepEqual(core.timeline, [
      'storage.backend:connect',
      'startup:Stage:credential_activation',
      'startup:Log:Activating stored credentials',
      'secrets.backend:list',
    ]);

    const [log] = core.startupLogs;

    assert.equal(core.startupLogs.length, 1);
    assert.equal(log?.level, 'info');
    assert.equal(log?.message, 'Activating stored credentials');
    assert.deepEqual(log?.fields, {});

    // The credentials are loaded: a later secrets call reads the cache and
    // makes no second backend list.
    const { credentials } = await core.client(SecretsService, 'doric').list({});

    assert.deepEqual(
      credentials.map(({ id }) => id),
      [STORED.id],
    );
    assert.deepEqual(core.secretsBackendCalls, ['list']);
  });
});

void test('a failing Stage fails the Run with its code, and no credential load follows', async () => {
  await withCore(async (core) => {
    core.failStage = new ContractError(
      'unavailable',
      'The startup screen is gone.',
    );

    await rejectsWith(runHostStart(core), 'unavailable');

    assert.deepEqual(core.startup, ['Stage:credential_activation']);
    assert.deepEqual(core.secretsBackendCalls, []);
  });
});

void test('a failing credential load fails the Run with its code; the next secrets call loads again', async () => {
  await withCore(async (core) => {
    core.failSecretsList = new ContractError(
      'credential_key_required',
      'DORIC_CREDENTIAL_KEY is required while a stored credential holds a secret.',
    );

    await rejectsWith(runHostStart(core), 'credential_key_required');
    assert.deepEqual(core.secretsBackendCalls, ['list']);

    core.failSecretsList = undefined;

    const { credentials } = await core.client(SecretsService, 'doric').list({});

    assert.deepEqual(
      credentials.map(({ id }) => id),
      [STORED.id],
    );
    assert.deepEqual(core.secretsBackendCalls, ['list', 'list']);
  });
});
