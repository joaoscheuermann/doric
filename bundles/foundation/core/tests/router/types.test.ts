// `loadCatalogTypes` (S41c): every bundle's message types, read from
// `doric.catalog/v1.Descriptors` (the catalog index, S41a) and built into a
// registry for `CoreServicesOptions.types`, which may be a function so a
// registry loaded at `activate` is seen by every later call. The catalog is
// a fake served in memory: the platform is a real boundary of `core`.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRegistry,
  type DescFile,
  type DescService,
  type Registry,
  toBinary,
} from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import {
  type Client,
  ConnectError,
  createClient,
  createRouterTransport,
  type ServiceImpl,
} from '@connectrpc/connect';
import {
  ContractError,
  fromConnectError,
  toConnectError,
} from 'bundle/contracts';
import { CatalogService } from 'bundle/contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import { SettingsService } from 'bundle/contracts/gen/doric/settings/v1/settings_pb.js';
import type { HostServices } from 'bundle/host';

import { loadCatalogTypes } from '../../src/host/types.js';
import { serveCore, testMessages } from '../support/router.js';

/** The settings message the set carries, and its file. */
const PREFS = 'notes.Prefs';
const NOTES_FILE = 'notes/test.proto';

/** `file` and every file it imports, transitively, imports first, each once. */
const withImports = (file: DescFile): DescFile[] => {
  const files: DescFile[] = [];
  const visit = (current: DescFile) => {
    if (files.some(({ name }) => name === current.name)) {
      return;
    }

    for (const dependency of current.dependencies) {
      visit(dependency);
    }

    files.push(current);
  };

  visit(file);

  return files;
};

const notesFile = (): DescFile => {
  const file = testMessages().getMessage(PREFS)?.file;

  assert.equal(file?.proto.name, NOTES_FILE);

  return file as DescFile;
};

/** The binary `FileDescriptorSet` of `files`. */
const setOf = (files: readonly DescFile[]): Uint8Array =>
  toBinary(FileDescriptorSetSchema, {
    $typeName: 'google.protobuf.FileDescriptorSet',
    file: files.map(({ proto }) => proto),
  });

/** `bytes` cut in two chunks (the first `at` bytes, then the rest). */
const twoChunks = (bytes: Uint8Array, at = Math.floor(bytes.length / 2)) => [
  bytes.slice(0, at),
  bytes.slice(at),
];

/**
 * `HostServices.use` whose `CatalogService` is an in-memory fake with
 * `descriptors`; every `Descriptors` call is counted in `calls`.
 */
const catalogServices = (
  descriptors: ServiceImpl<typeof CatalogService>['descriptors'],
): {
  readonly services: Pick<HostServices, 'use'>;
  readonly calls: string[];
} => {
  const calls: string[] = [];
  const notServed = (): never => {
    throw toConnectError(new ContractError('unknown_contract', 'Not served.'));
  };
  const catalog: ServiceImpl<typeof CatalogService> = {
    get: notServed,
    distribution: notServed,
    readArtifact: notServed,
    watch: notServed,
    disable: notServed,
    resetComposition: notServed,
    descriptors: (request, context) => {
      calls.push('descriptors');

      return descriptors(request, context);
    },
  };
  const client = createClient(
    CatalogService,
    createRouterTransport((router) => {
      router.service(CatalogService, catalog);
    }),
  );

  return {
    calls,
    services: {
      use: <S extends DescService>(ref: S): Client<S> => {
        assert.equal(ref.typeName, CatalogService.typeName);

        return client as unknown as Client<S>;
      },
    } as Pick<HostServices, 'use'>,
  };
};

/** A `Descriptors` fake streaming `chunks`, one item each. */
const streaming = (chunks: readonly Uint8Array[]) =>
  async function* () {
    for (const chunk of chunks) {
      yield { chunk };
    }
  };

const rejectsWithCode = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ContractError, `not a ContractError: ${error}`);
    assert.equal(error.code, code, error.message);

    return true;
  });
};

void test('loadCatalogTypes joins the Descriptors chunks into a registry that finds the settings message', async () => {
  const { services, calls } = catalogServices(
    streaming(twoChunks(setOf(withImports(notesFile())))),
  );

  const registry = await loadCatalogTypes(services);

  assert.equal(registry.getMessage(PREFS)?.typeName, PREFS);
  assert.equal(registry.getMessage('notes.Strict')?.typeName, 'notes.Strict');
  assert.deepEqual(calls, ['descriptors']);
});

void test('a types function is read at every call: settings Register of a message refused before the catalog types load is accepted after', async () => {
  const { services } = catalogServices(
    streaming(twoChunks(setOf(withImports(notesFile())))),
  );
  let types: Registry = createRegistry();
  const core = await serveCore({
    bundles: { notes: ['notes.prefs/v1@1.2.0'] },
    types: () => types,
  });

  try {
    const settings = core.client(SettingsService, 'notes');

    await assert.rejects(
      settings.register({ id: 'notes.prefs/v1', messageType: PREFS }),
      (error: unknown) => {
        assert.ok(
          error instanceof ConnectError,
          `not a ConnectError: ${error}`,
        );
        assert.equal(fromConnectError(error).code, 'invalid_input');

        return true;
      },
    );

    types = await loadCatalogTypes(services);

    const { registrationId } = await settings.register({
      id: 'notes.prefs/v1',
      messageType: PREFS,
    });

    assert.notEqual(registrationId, '');
  } finally {
    await core.close();
  }
});

void test('a Descriptors failure rejects loadCatalogTypes with its code', async () => {
  const { services } = catalogServices(
    // biome-ignore lint/correctness/useYield: the fake fails before any item.
    async function* () {
      throw toConnectError(
        new ContractError('unavailable', 'The catalog is unreachable.'),
      );
    },
  );

  await rejectsWithCode(loadCatalogTypes(services), 'unavailable');
});

void test('bytes that are not a FileDescriptorSet reject with invalid_output', async () => {
  const { services } = catalogServices(
    streaming([Uint8Array.of(0xff, 0xff, 0xff, 0xff)]),
  );

  await rejectsWithCode(loadCatalogTypes(services), 'invalid_output');
});

void test('a set whose file imports one the set does not hold rejects with invalid_output', async () => {
  const { services } = catalogServices(streaming([setOf([notesFile()])]));

  await rejectsWithCode(loadCatalogTypes(services), 'invalid_output');
});
