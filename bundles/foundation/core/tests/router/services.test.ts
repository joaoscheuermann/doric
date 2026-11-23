// `createCoreServices` (S39a): what holds for every service before and at
// activation.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectError } from '@connectrpc/connect';
import { defineStorageType, fromConnectError } from 'bundle/contracts';
import { SettingsService } from 'bundle/contracts/gen/doric/settings/v1/settings_pb.js';
import { StorageService } from 'bundle/contracts/gen/doric/storage/v1/storage_pb.js';
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
