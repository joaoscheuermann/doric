// The catalog index from serialized descriptor sets (spec
// `docs/designs/grpc-processes.md`, section 8, "Descriptors"):
// `catalogIndexFromDescriptors` answers what `createCatalogIndex` answers
// over the same `.proto` files, and refuses sets it cannot hold.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { clone, create } from '@bufbuild/protobuf';
import {
  DescriptorProtoSchema,
  FileDescriptorProtoSchema,
} from '@bufbuild/protobuf/wkt';
import {
  Cardinality,
  Environment,
} from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';
import { file_doric_tools_v1_tools } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';

import {
  catalogIndexFromDescriptors,
  createCatalogIndex,
} from '../../src/platform/catalog-index.js';
import {
  closure,
  contractProto,
  demoProto,
  descFileOf,
  setOf,
  setOfProtos,
  summarize,
} from '../support/descriptor-sets.js';

const throwsTypeError = (
  run: () => unknown,
  check: (message: string) => void,
) =>
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof TypeError, String(error));
    check(error.message);

    return true;
  });

const otherProto = (id: string) =>
  contractProto({
    name: 'other/v1/other.proto',
    package: 'other.v1',
    contract: {
      id,
      cardinality: Cardinality.MANY,
      environment: Environment.HOST,
    },
  });

describe('catalogIndexFromDescriptors', () => {
  test('a set of generated files answers what createCatalogIndex answers over them', () => {
    const index = catalogIndexFromDescriptors([
      setOf(file_doric_tools_v1_tools),
    ]);
    const catalog = index.method('/doric.tools.v1.ToolsService/Catalog');

    assert.equal(catalog?.contract.id, 'tools/v1');
    assert.equal(catalog?.contract.environment, 'HOST');
    assert.equal(catalog?.expose, 'DESKTOP');
    assert.equal(
      index.method('/doric.tools.v1.ToolHandlerService/Execute')?.role,
      'handler',
    );
    assert.deepEqual(
      summarize(index),
      summarize(createCatalogIndex([file_doric_tools_v1_tools])),
    );
  });

  test('a fixture contract reads its options: cardinality, environment, role, expose, resumable, kind', () => {
    const index = catalogIndexFromDescriptors([setOf(descFileOf(demoProto()))]);
    const watch = index.method('/demo.v1.DemoService/Watch');

    assert.deepEqual(
      [
        index.contract('demo.api/v1')?.cardinality,
        index.contract('demo.api/v1')?.environment,
        index.contract('demo.api/v1')?.file.proto.name,
      ],
      ['one', 'HOST', 'demo/v1/demo.proto'],
    );
    assert.equal(index.service('demo.v1.DemoHandlerService')?.role, 'handler');
    assert.equal(index.service('demo.v1.DemoService')?.role, 'contract');
    assert.deepEqual(
      [watch?.kind, watch?.resumable, watch?.expose],
      ['server_stream', true, 'NONE'],
    );
    assert.deepEqual(
      index.desktopMethods().map((entry) => entry.path),
      ['/demo.v1.DemoService/Ping'],
    );
  });

  test('desktopMethods follow the order of the sets, then of each set', () => {
    const demo = descFileOf(demoProto());
    const desktop = (sets: readonly Uint8Array[]) =>
      catalogIndexFromDescriptors(sets)
        .desktopMethods()
        .map((entry) => entry.path);

    assert.deepEqual(desktop([setOf(file_doric_tools_v1_tools), setOf(demo)]), [
      '/doric.tools.v1.ToolsService/Catalog',
      '/demo.v1.DemoService/Ping',
    ]);
    assert.deepEqual(desktop([setOf(demo), setOf(file_doric_tools_v1_tools)]), [
      '/demo.v1.DemoService/Ping',
      '/doric.tools.v1.ToolsService/Catalog',
    ]);
    // One set: the order of its `file` list.
    assert.deepEqual(
      desktop([
        setOfProtos([
          ...closure(file_doric_tools_v1_tools).map((file) => file.proto),
          demo.proto,
        ]),
      ]),
      ['/doric.tools.v1.ToolsService/Catalog', '/demo.v1.DemoService/Ping'],
    );
  });

  test("a file's imports are resolved among the files of all the sets", () => {
    const files = closure(file_doric_tools_v1_tools);
    const imports = files.slice(0, -1).map((file) => file.proto);
    const tools = files[files.length - 1]?.proto;

    assert.equal(tools?.name, 'doric/tools/v1/tools.proto');

    const index = catalogIndexFromDescriptors([
      setOfProtos(imports),
      setOfProtos([tools as NonNullable<typeof tools>]),
    ]);

    assert.equal(index.contract('tools/v1')?.environment, 'HOST');
  });

  test('a file in several sets with equal descriptors counts once', () => {
    const index = catalogIndexFromDescriptors([
      setOf(file_doric_tools_v1_tools),
      setOf(file_doric_tools_v1_tools),
    ]);

    assert.deepEqual(
      summarize(index),
      summarize(createCatalogIndex([file_doric_tools_v1_tools])),
    );
  });

  test('a file in several sets with different descriptors throws a TypeError naming it', () => {
    const changed = clone(
      FileDescriptorProtoSchema,
      file_doric_tools_v1_tools.proto,
    );

    changed.messageType.push(create(DescriptorProtoSchema, { name: 'Extra' }));

    throwsTypeError(
      () =>
        catalogIndexFromDescriptors([
          setOf(file_doric_tools_v1_tools),
          setOfProtos([changed]),
        ]),
      (message) =>
        assert.ok(message.includes('doric/tools/v1/tools.proto'), message),
    );
  });

  test('bytes that are not a binary FileDescriptorSet throw a TypeError naming the set', () => {
    // Field 1 (`file`), length-delimited, announcing 5 bytes of which one follows.
    const truncated = new Uint8Array([0x0a, 0x05, 0x01]);

    throwsTypeError(
      () =>
        catalogIndexFromDescriptors([
          setOf(file_doric_tools_v1_tools),
          truncated,
        ]),
      (message) => assert.ok(message.startsWith('descriptor set 1:'), message),
    );
  });

  test('an import that no set holds throws a TypeError naming the file', () => {
    throwsTypeError(
      () =>
        catalogIndexFromDescriptors([setOfProtos([otherProto('other/v1')])]),
      (message) => assert.ok(message.includes('other/v1/other.proto'), message),
    );
  });

  test('a rule of createCatalogIndex across sets throws its TypeError naming the file', () => {
    throwsTypeError(
      () =>
        catalogIndexFromDescriptors([
          setOf(file_doric_tools_v1_tools),
          setOf(descFileOf(otherProto('tools/v1'))),
        ]),
      (message) => assert.ok(message.includes('other/v1/other.proto'), message),
    );
  });

  test('no sets, or sets without files, answer an empty index', () => {
    for (const sets of [[], [new Uint8Array(0)], [setOfProtos([])]]) {
      const index = catalogIndexFromDescriptors(sets);

      assert.deepEqual(summarize(index), {
        files: [],
        services: [],
        desktop: [],
      });
      assert.equal(index.contract('tools/v1'), undefined);
    }
  });
});
