// T3.14 (AC3.15, A53): a window's import map maps, for each bundle of its
// generation, `<id>/contracts` and the prefix `<id>/contracts/gen/`, so a
// generated module loads once whether reached by its bare specifier or
// relatively from `<id>/contracts`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  generationImportMap,
  type ImportMap,
} from '../src/platform/protocol/import-map';

const platform = 'doric://app/platform';

const base: ImportMap = {
  imports: {
    react: `${platform}/react@19.0.0/index.js`,
    'bundle/contracts': `${platform}/bundle@1.0.0/contracts.js`,
    '@bufbuild/protobuf': `${platform}/@bufbuild/protobuf@2.17.0/index.js`,
    'bundle/contracts/gen/google/rpc/status_pb.js': `${platform}/bundle@1.0.0/contracts/gen/google/rpc/status_pb.js`,
  },
};

const artifacts = [
  { id: 'core', version: '1.3.0', entry: 'contracts/index.js' },
  { id: 'files', version: '2.0.0', entry: 'contracts/index.js' },
];

describe('generationImportMap', () => {
  test('maps <id>/contracts/gen/ to the bundle folder of each artifact, beside <id>/contracts and the platform entries', () => {
    const { imports } = generationImportMap(base, artifacts);

    assert.deepEqual(imports, {
      ...base.imports,
      'core/contracts': 'doric://app/bundles/core@1.3.0/contracts/index.js',
      'core/contracts/gen/': 'doric://app/bundles/core@1.3.0/contracts/gen/',
      'files/contracts': 'doric://app/bundles/files@2.0.0/contracts/index.js',
      'files/contracts/gen/': 'doric://app/bundles/files@2.0.0/contracts/gen/',
    });
  });

  test('maps only <id>/contracts/gen/ for a bundle that ships generated code without a contracts entry', () => {
    const { imports } = generationImportMap(base, [
      { id: 'transport', version: '1.0.0' },
    ]);

    assert.equal(
      imports['transport/contracts/gen/'],
      'doric://app/bundles/transport@1.0.0/contracts/gen/',
    );
    assert.equal('transport/contracts' in imports, false);
  });

  test('resolves a generated file to one URL, by the prefix and relatively from <id>/contracts', () => {
    const { imports } = generationImportMap(base, artifacts);
    const contracts = imports['files/contracts'];
    const prefix = imports['files/contracts/gen/'];

    assert.ok(contracts !== undefined && prefix !== undefined);
    assert.equal(
      new URL('./gen/doric/files/v1/files_pb.js', contracts).href,
      `${prefix}doric/files/v1/files_pb.js`,
    );
  });

  test('leaves base unmodified and passes the platform bundle/contracts/gen entries through', () => {
    const before = structuredClone(base.imports);
    const { imports } = generationImportMap(base, [
      ...artifacts,
      { id: 'transport', version: '1.0.0' },
    ]);

    assert.deepEqual(base.imports, before);
    assert.equal(
      imports['bundle/contracts/gen/google/rpc/status_pb.js'],
      base.imports['bundle/contracts/gen/google/rpc/status_pb.js'],
    );
    assert.equal('bundle/contracts/gen/' in imports, false);
  });
});
