// The basic `HOST` contracts as a fallback of a staged catalog index
// (`withBasicContracts`, contracts `s62d.md` §2.7 and §5 test 10): the host
// boots with a staged index that lacks the basic files no bundle's
// `descriptors.binpb` holds, and the platform answers them from here.

import assert from 'node:assert/strict';
import test from 'node:test';

import { file_doric_models_v1_models } from '../../src/contracts/gen/doric/models/v1/models_pb.js';
import { file_doric_secrets_v1_secrets } from '../../src/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { file_doric_tools_v1_tools } from '../../src/contracts/gen/doric/tools/v1/tools_pb.js';
import { basicContracts } from '../../src/contracts/index.js';
import { descriptorSetBytes } from '../../src/platform/descriptor-set.js';
import {
  basicHostContractFiles,
  type CatalogIndex,
  catalogIndexFromDescriptors,
  createCatalogIndex,
  withBasicContracts,
} from '../../src/platform/index.js';

/** The ids of `basicContracts` served on the host, in table order. */
const hostIds = Object.entries(basicContracts)
  .filter(([, spec]) => spec.environments.includes('host'))
  .map(([id]) => id);

/**
 * A staged index as the host reads it from `descriptors.binpb`: `tools/v1`
 * (and its imports) decoded from bytes, so its files are other `DescFile`s
 * than the generated ones of the same names.
 */
const stagedTools = (): CatalogIndex =>
  catalogIndexFromDescriptors([
    descriptorSetBytes([file_doric_tools_v1_tools]),
  ]);

void test('the files declare exactly the basicContracts ids with a host environment, in table order', () => {
  assert.equal(basicHostContractFiles.length, hostIds.length);
  assert.ok(Object.isFrozen(basicHostContractFiles));

  for (const [position, id] of hostIds.entries()) {
    const file = basicHostContractFiles[position];
    assert.ok(file, id);
    assert.equal(createCatalogIndex([file]).contract(id)?.file, file, id);
  }
});

void test('a staged file wins over a basic file of the same name; a method only the basic files hold resolves', () => {
  const staged = stagedTools();
  const index = withBasicContracts(staged);
  const list = '/doric.tools.v1.ToolsService/List';

  // `tools/v1` is in both: the staged file answers.
  assert.equal(
    index.contract('tools/v1')?.file,
    staged.contract('tools/v1')?.file,
  );
  assert.notEqual(index.contract('tools/v1')?.file, file_doric_tools_v1_tools);
  assert.equal(index.method(list)?.method, staged.method(list)?.method);
  assert.equal(
    index.service('doric.tools.v1.ToolsService')?.service,
    staged.service('doric.tools.v1.ToolsService')?.service,
  );
  assert.equal(
    index.registry.getFile('doric/tools/v1/tools.proto'),
    staged.contract('tools/v1')?.file,
  );

  // `secrets/v1` is only basic: it resolves from the basic files.
  assert.equal(staged.contract('secrets/v1'), undefined);
  assert.equal(
    index.method('/doric.secrets.v1.SecretsService/Kinds')?.contract.id,
    'secrets/v1',
  );
  assert.equal(
    index.service('doric.secrets.v1.SecretsService')?.contract.id,
    'secrets/v1',
  );
  assert.equal(
    index.contract('secrets/v1')?.file.proto.name,
    'doric/secrets/v1/secrets.proto',
  );
  assert.ok(index.registry.getFile('doric/secrets/v1/secrets.proto'));

  // A key neither holds answers undefined.
  assert.equal(index.contract('nothing/v1'), undefined);
  assert.equal(index.method('/doric.nothing.v1.NothingService/Get'), undefined);
});

void test('desktopMethods lists the staged then the basic-only DESKTOP methods, each path once; publicMethods is the staged index', () => {
  const tools = stagedTools();
  const publicApi = tools.desktopMethods().slice(0, 1);
  // A staged index whose public API is not empty, so that the answer can
  // only be the staged one.
  const staged: CatalogIndex = { ...tools, publicMethods: () => publicApi };
  const index = withBasicContracts(staged);
  // The basic `HOST` contracts other than `tools/v1` that expose methods to
  // `DESKTOP`, in table order: `secrets/v1`, then `models/v1`.
  const basicOnly = createCatalogIndex([
    file_doric_secrets_v1_secrets,
    file_doric_models_v1_models,
  ]).desktopMethods();
  const desktop = index.desktopMethods();

  assert.ok(staged.desktopMethods().length > 0);
  assert.ok(basicOnly.length > 0);
  assert.deepEqual(
    desktop.map(({ path }) => path),
    [...staged.desktopMethods(), ...basicOnly].map(({ path }) => path),
  );
  assert.equal(new Set(desktop.map(({ path }) => path)).size, desktop.length);
  // The staged entries are the staged index's own.
  assert.equal(desktop[0], staged.desktopMethods()[0]);
  assert.equal(index.desktopMethods(), desktop);
  assert.equal(index.publicMethods(), publicApi);
});
