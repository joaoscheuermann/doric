// `createCoreServices` (S39a): what holds for every service before and at
// activation.

import assert from 'node:assert/strict';
import test from 'node:test';

import { create } from '@bufbuild/protobuf';
import { anyPack, EmptySchema } from '@bufbuild/protobuf/wkt';
import { ConnectError } from '@connectrpc/connect';
import { defineStorageType, fromConnectError } from 'bundle/contracts';
import { EventsService } from 'bundle/contracts/gen/doric/events/v1/events_pb.js';
import { HooksService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { LogService } from 'bundle/contracts/gen/doric/log/v1/log_pb.js';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { SettingsService } from 'bundle/contracts/gen/doric/settings/v1/settings_pb.js';
import { SkillsService } from 'bundle/contracts/gen/doric/skills/v1/skills_pb.js';
import { StorageService } from 'bundle/contracts/gen/doric/storage/v1/storage_pb.js';
import { ToolsService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { ajvValidators } from 'bundle/host';
import { createTestRouter } from 'bundle/testing';
import { storageClient } from 'storage/rpc';
import { z } from 'zod';

import { createCoreServices } from '../../src/host/services.js';
import { testMessages } from '../support/router.js';

const caller = { bundleId: 'notes', version: '1.2.3', generation: 1 };

void test('every RPC fails with unavailable until activate ran', async () => {
  const core = createCoreServices({
    types: testMessages(),
    validators: ajvValidators(),
  });
  const router = createTestRouter();

  // Served, but `core.activate` is never called.
  await router.activate({ services: core.services, activate: () => {} });

  try {
    const storage = storageClient(router.client(StorageService, { caller }));

    await assert.rejects(
      storage.get({ type: 'notes.note/v1', id: 'a' }),
      { code: 'unavailable' },
    );
    storage.defineType(
      defineStorageType({
        type: 'notes.note/v1',
        schema: z.object({}),
        indexes: [],
      }),
    );
    await assert.rejects(storage.settled(), { code: 'unavailable' });

    await assert.rejects(
      router
        .client(SettingsService, { caller })
        .register({ id: 'notes.prefs/v1', messageType: 'notes.Prefs' }),
      (error: unknown) => {
        assert.ok(error instanceof ConnectError, String(error));
        assert.equal(fromConnectError(error).code, 'unavailable');

        return true;
      },
    );
  } finally {
    await router.control.stop();
  }
});

void test('tools/v1, skills/v1, hooks/v1 and log/v1 follow events/v1 and fail with unavailable until activate ran', async () => {
  const core = createCoreServices({
    types: testMessages(),
    validators: ajvValidators(),
  });

  assert.deepEqual(
    core.services.map(([service]) => service.typeName),
    [
      StorageService.typeName,
      SettingsService.typeName,
      SecretsService.typeName,
      EventsService.typeName,
      ToolsService.typeName,
      SkillsService.typeName,
      HooksService.typeName,
      LogService.typeName,
    ],
  );

  const router = createTestRouter();

  // Served, but `core.activate` is never called.
  await router.activate({ services: core.services, activate: () => {} });

  const unavailable = (error: unknown) => {
    assert.ok(error instanceof ConnectError, String(error));
    assert.equal(fromConnectError(error).code, 'unavailable', error.message);

    return true;
  };

  try {
    const tools = router.client(ToolsService, { caller });
    const skills = router.client(SkillsService, { caller });
    const hooks = router.client(HooksService, { caller });
    const log = router.client(LogService, { caller });
    const contract = 'notes.hooks/v1';
    const calls: readonly (() => Promise<unknown>)[] = [
      () =>
        tools.register({
          tool: {
            name: 'search',
            definition: {
              name: 'search',
              inputSchema: '{}',
              outputSchema: '{}',
            },
          },
          options: { alwaysAvailable: false },
        }),
      () => tools.unregister({ registrationId: 'r1' }),
      () => tools.list({}),
      () => tools.catalog({}),
      () => tools.execute({ name: 'search' }),
      () =>
        skills.register({
          skill: { name: 'triage', description: 'd', body: 'b' },
        }),
      () => skills.unregister({ registrationId: 'r1' }),
      () => skills.list({}),
      () => hooks.define({ contract }),
      () => hooks.register({ contract, hook: 'onSeenHook' }),
      () => hooks.unregister({ registrationId: 'r1' }),
      () =>
        hooks.run({
          contract,
          hook: 'onSeenHook',
          input: anyPack(EmptySchema, create(EmptySchema)),
        }),
      async () => {
        // An item instead of the failure ends the stream read without one.
        for await (const item of hooks.watchAvailability({ contract })) {
          return item;
        }

        return undefined;
      },
      () => log.write({ record: { level: 'info', message: 'm' } }),
      () =>
        log.writeBatch(
          (async function* () {
            yield { record: { level: 'info', message: 'm' } };
          })(),
        ),
    ];

    for (const call of calls) {
      await assert.rejects(call(), unavailable);
    }
  } finally {
    await router.control.stop();
  }
});

void test('activate called a second time throws a TypeError', async () => {
  const core = createCoreServices({
    types: testMessages(),
    validators: ajvValidators(),
  });
  const router = createTestRouter();

  try {
    await assert.rejects(
      router.activate({
        services: core.services,
        activate: (context) => {
          core.activate(context);
          core.activate(context);
        },
      }),
      TypeError,
    );
  } finally {
    await router.control.stop();
  }
});
