// The proto check (spec `docs/designs/grpc-processes.md`, section 8, "The
// proto check", A51, A52, A54; T1.1, AC1.2): `packageOfContractId` maps a
// contract id to its package, `checkContractDescriptors` refuses each rule of
// section 8 that `buf lint` does not check, the CLI writes the violations of
// an image and sets the exit code, and `buf lint` with the root's `STANDARD`
// rules refuses the names section 8 forbids.
//
// The descriptor sets are built here with `create(FileDescriptorSetSchema)`,
// the contract options set with `setExtension` and the extensions of the
// generated `options_pb`. The CLI is the compiled `proto-rules.js` beside the
// compiled tests; `buf` is the real binary of `node_modules/.bin`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  create,
  type DescFile,
  fromBinary,
  type MessageInitShape,
  setExtension,
  toBinary,
} from '@bufbuild/protobuf';
import {
  type DescriptorProto,
  DescriptorProtoSchema,
  EnumDescriptorProtoSchema,
  type FieldDescriptorProto,
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FieldDescriptorProtoSchema,
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
  type FileDescriptorSet,
  FileDescriptorSetSchema,
  FileOptionsSchema,
  file_google_protobuf_any,
  file_google_protobuf_descriptor,
  file_google_protobuf_duration,
  file_google_protobuf_struct,
  file_google_protobuf_timestamp,
  file_google_protobuf_wrappers,
  MessageOptionsSchema,
} from '@bufbuild/protobuf/wkt';
import { parse, stringify } from 'yaml';

import {
  checkContractDescriptors,
  type ProtoRuleCode,
  type ProtoRuleViolation,
  packageOfContractId,
} from '../src/build/proto-rules.js';
import { file_doric_platform_v1_control } from '../src/contracts/gen/doric/platform/v1/control_pb.js';
import {
  Cardinality,
  ContractOptionSchema,
  contract,
  Environment,
  file_doric_platform_v1_options,
  HookKind,
  HookOptionSchema,
  HooksOptionSchema,
  hook,
  hooks,
} from '../src/contracts/gen/doric/platform/v1/options_pb.js';

const { OPTIONAL: LABEL_OPTIONAL, REPEATED: LABEL_REPEATED } =
  FieldDescriptorProto_Label;
const T = FieldDescriptorProto_Type;

/** A file with every file it imports before it, each once. */
const withImports = (
  file: DescFile,
  seen: Set<string> = new Set(),
): FileDescriptorProto[] => {
  if (seen.has(file.proto.name)) return [];
  seen.add(file.proto.name);
  return [
    ...file.dependencies.flatMap((dependency) => withImports(dependency, seen)),
    file.proto,
  ];
};

/** The files every fixture set holds: the options and the well-known types. */
const baseFiles = (): FileDescriptorProto[] => {
  const seen = new Set<string>();
  return [
    file_google_protobuf_descriptor,
    file_doric_platform_v1_options,
    file_google_protobuf_any,
    file_google_protobuf_duration,
    file_google_protobuf_struct,
    file_google_protobuf_timestamp,
    file_google_protobuf_wrappers,
  ].flatMap((file) => withImports(file, seen));
};

const field = (
  name: string,
  number: number,
  type: FieldDescriptorProto_Type,
  init: MessageInitShape<typeof FieldDescriptorProtoSchema> = {},
): FieldDescriptorProto =>
  create(FieldDescriptorProtoSchema, {
    name,
    number,
    label: LABEL_OPTIONAL,
    type,
    ...init,
  });

/** A field of a message type, `typeName` fully qualified with a leading dot. */
const messageField = (name: string, number: number, typeName: string) =>
  field(name, number, T.MESSAGE, { typeName });

const message = (
  name: string,
  fields: FieldDescriptorProto[],
  init: MessageInitShape<typeof DescriptorProtoSchema> = {},
): DescriptorProto =>
  create(DescriptorProtoSchema, { name, field: fields, ...init });

/** A `map<key, value>` field of `owner`, with its nested entry message. */
const mapField = (
  owner: string,
  name: string,
  number: number,
  entry: string,
  key: FieldDescriptorProto_Type,
  value: FieldDescriptorProto_Type,
): { field: FieldDescriptorProto; entry: DescriptorProto } => ({
  field: field(name, number, T.MESSAGE, {
    label: LABEL_REPEATED,
    typeName: `.${owner}.${entry}`,
  }),
  entry: message(entry, [field('key', 1, key), field('value', 2, value)], {
    options: { mapEntry: true },
  }),
});

interface FileSpec {
  readonly name: string;
  readonly package: string;
  /** The `(doric.platform.v1.contract)` option; absent for a plain file. */
  readonly contract?: MessageInitShape<typeof ContractOptionSchema>;
  /** The `(doric.platform.v1.hooks)` id; absent for a file without hooks. */
  readonly hooksId?: string;
  readonly messages?: readonly DescriptorProto[];
  readonly enums?: MessageInitShape<
    typeof FileDescriptorProtoSchema
  >['enumType'];
  readonly dependency?: readonly string[];
}

const fileOf = (spec: FileSpec): FileDescriptorProto => {
  const options = create(FileOptionsSchema);
  if (spec.contract !== undefined) {
    setExtension(
      options,
      contract,
      create(ContractOptionSchema, spec.contract),
    );
  }
  if (spec.hooksId !== undefined) {
    setExtension(
      options,
      hooks,
      create(HooksOptionSchema, { id: spec.hooksId }),
    );
  }
  return create(FileDescriptorProtoSchema, {
    name: spec.name,
    package: spec.package,
    syntax: 'proto3',
    dependency: [
      'doric/platform/v1/options.proto',
      'google/protobuf/any.proto',
      'google/protobuf/duration.proto',
      'google/protobuf/struct.proto',
      'google/protobuf/timestamp.proto',
      'google/protobuf/wrappers.proto',
      ...(spec.dependency ?? []),
    ],
    messageType: [...(spec.messages ?? [])],
    enumType: spec.enums ?? [],
    options,
  });
};

const setOf = (...files: FileDescriptorProto[]): FileDescriptorSet =>
  create(FileDescriptorSetSchema, { file: [...baseFiles(), ...files] });

/** A contract option that passes: cardinality and a bundle's environment set. */
const hostContract = (id: string) => ({
  id,
  cardinality: Cardinality.ONE,
  environment: Environment.HOST,
});

/** A contract file of one message with one string field: a passing file. */
const validContract = (dir: string, id: string, pkg: string) =>
  fileOf({
    name: `doric/${dir}/v1/${dir.split('/').at(-1)}.proto`,
    package: pkg,
    contract: hostContract(id),
    messages: [message('Thing', [field('name', 1, T.STRING)])],
  });

const located = (violations: readonly ProtoRuleViolation[]) =>
  violations.map(({ code, file, element }) => ({ code, file, element }));

const ofCode = (
  violations: readonly ProtoRuleViolation[],
  code: ProtoRuleCode,
) => located(violations.filter((violation) => violation.code === code));

describe('packageOfContractId', () => {
  test('maps <name>/v<major> to doric.<name>.v<major>', () => {
    assert.equal(packageOfContractId('log/v1'), 'doric.log.v1');
  });

  test('maps a platform id doric.<name>/v<major> to doric.platform.<name>.v<major>', () => {
    assert.equal(packageOfContractId('doric.log/v1'), 'doric.platform.log.v1');
    assert.equal(
      packageOfContractId('doric.window.lifecycle/v1'),
      'doric.platform.window.lifecycle.v1',
    );
  });

  test('replaces every - of the name by _', () => {
    assert.equal(
      packageOfContractId('core.open-settings/v1'),
      'doric.core.open_settings.v1',
    );
  });

  test('throws on an id contractIdPattern refuses, and only on one', () => {
    assert.throws(() => packageOfContractId('Log/v1'), Error);
    assert.doesNotThrow(() => packageOfContractId('log/v1'));
  });
});

describe('checkContractDescriptors: one violation per code', () => {
  test('invalid_contract_id: the option id fails contractIdPattern', () => {
    const violations = checkContractDescriptors(
      setOf(
        fileOf({
          name: 'doric/bad/v1/bad.proto',
          package: 'doric.bad.v1',
          contract: hostContract('Bad/v1'),
        }),
      ),
    );
    assert.deepEqual(ofCode(violations, 'invalid_contract_id'), [
      {
        code: 'invalid_contract_id',
        file: 'doric/bad/v1/bad.proto',
        element: 'doric.bad.v1',
      },
    ]);
  });

  test("reserved_contract_id: a bundle's id whose first segment is platform", () => {
    const violations = checkContractDescriptors(
      setOf(
        fileOf({
          name: 'doric/platform/log/v1/log.proto',
          package: 'doric.platform.log.v1',
          contract: hostContract('platform.log/v1'),
        }),
      ),
    );
    assert.deepEqual(ofCode(violations, 'reserved_contract_id'), [
      {
        code: 'reserved_contract_id',
        file: 'doric/platform/log/v1/log.proto',
        element: 'doric.platform.log.v1',
      },
    ]);
  });

  test('package_mismatch: the package is not the one the id maps to', () => {
    const violations = checkContractDescriptors(
      setOf(
        fileOf({
          name: 'doric/tool/v1/tool.proto',
          package: 'doric.tool.v1',
          contract: hostContract('tools/v1'),
        }),
      ),
    );
    assert.deepEqual(ofCode(violations, 'package_mismatch'), [
      {
        code: 'package_mismatch',
        file: 'doric/tool/v1/tool.proto',
        element: 'doric.tool.v1',
      },
    ]);
  });

  test('duplicate_package: two ids map to one package', () => {
    // `platform.log/v1` and `doric.log/v1` both map to doric.platform.log.v1.
    const files = [
      'doric/platform/log/v1/bundle.proto',
      'doric/platform/log/v1/platform.proto',
    ];
    const violations = checkContractDescriptors(
      setOf(
        fileOf({
          name: files[0] as string,
          package: 'doric.platform.log.v1',
          contract: hostContract('platform.log/v1'),
        }),
        fileOf({
          name: files[1] as string,
          package: 'doric.platform.log.v1',
          contract: { id: 'doric.log/v1', cardinality: Cardinality.ONE },
        }),
      ),
    );
    const found = ofCode(violations, 'duplicate_package');
    assert.ok(found.length >= 1, 'a duplicate_package violation');
    for (const violation of found) {
      assert.ok(files.includes(violation.file), violation.file);
      assert.equal(violation.element, 'doric.platform.log.v1');
    }
  });

  test('duplicate_contract: two files declare one id', () => {
    const files = ['doric/tools/v1/a.proto', 'doric/tools/v1/b.proto'];
    const violations = checkContractDescriptors(
      setOf(
        ...files.map((name) =>
          fileOf({
            name,
            package: 'doric.tools.v1',
            contract: hostContract('tools/v1'),
          }),
        ),
      ),
    );
    const found = ofCode(violations, 'duplicate_contract');
    assert.ok(found.length >= 1, 'a duplicate_contract violation');
    for (const violation of found) {
      assert.ok(files.includes(violation.file), violation.file);
      assert.equal(violation.element, 'doric.tools.v1');
    }
  });

  test("unspecified_option: cardinality, a bundle's environment and a hook kind", () => {
    const hookOptions = create(MessageOptionsSchema);
    setExtension(
      hookOptions,
      hook,
      create(HookOptionSchema, { name: 'onSend', kind: HookKind.UNSPECIFIED }),
    );
    const violations = checkContractDescriptors(
      setOf(
        fileOf({
          name: 'doric/a/v1/a.proto',
          package: 'doric.a.v1',
          contract: {
            id: 'a/v1',
            cardinality: Cardinality.UNSPECIFIED,
            environment: Environment.HOST,
          },
        }),
        fileOf({
          name: 'doric/b/v1/b.proto',
          package: 'doric.b.v1',
          contract: {
            id: 'b/v1',
            cardinality: Cardinality.ONE,
            environment: Environment.UNSPECIFIED,
          },
        }),
        fileOf({
          name: 'doric/c/hooks/v1/hooks.proto',
          package: 'doric.c.hooks.v1',
          hooksId: 'c.hooks/v1',
          messages: [
            message('OnSendInput', [field('text', 1, T.STRING)], {
              options: hookOptions,
            }),
          ],
        }),
      ),
    );
    assert.deepEqual(ofCode(violations, 'unspecified_option'), [
      {
        code: 'unspecified_option',
        file: 'doric/a/v1/a.proto',
        element: 'doric.a.v1',
      },
      {
        code: 'unspecified_option',
        file: 'doric/b/v1/b.proto',
        element: 'doric.b.v1',
      },
      {
        code: 'unspecified_option',
        file: 'doric/c/hooks/v1/hooks.proto',
        element: 'doric.c.hooks.v1.OnSendInput',
      },
    ]);
  });

  test('platform_environment: a doric.* contract that sets environment', () => {
    const violations = checkContractDescriptors(
      setOf(
        fileOf({
          name: 'doric/platform/log/v1/log.proto',
          package: 'doric.platform.log.v1',
          contract: hostContract('doric.log/v1'),
        }),
      ),
    );
    assert.deepEqual(ofCode(violations, 'platform_environment'), [
      {
        code: 'platform_environment',
        file: 'doric/platform/log/v1/log.proto',
        element: 'doric.platform.log.v1',
      },
    ]);
  });

  test('contract_enum: an enum field in a contract message', () => {
    const violations = checkContractDescriptors(
      setOf(
        fileOf({
          name: 'doric/paint/v1/paint.proto',
          package: 'doric.paint.v1',
          contract: hostContract('paint/v1'),
          enums: [
            create(EnumDescriptorProtoSchema, {
              name: 'Color',
              value: [
                { name: 'COLOR_UNSPECIFIED', number: 0 },
                { name: 'COLOR_RED', number: 1 },
              ],
            }),
          ],
          messages: [
            message('Stroke', [
              field('color', 1, T.ENUM, { typeName: '.doric.paint.v1.Color' }),
            ]),
          ],
        }),
      ),
    );
    assert.deepEqual(ofCode(violations, 'contract_enum'), [
      {
        code: 'contract_enum',
        file: 'doric/paint/v1/paint.proto',
        element: 'doric.paint.v1.Stroke.color',
      },
    ]);
  });

  test('contract_64bit: a map key, a map value and a message in another file', () => {
    const owner = 'doric.counts.v1.Counts';
    const byId = mapField(owner, 'by_id', 1, 'ByIdEntry', T.INT64, T.STRING);
    const totals = mapField(
      owner,
      'totals',
      2,
      'TotalsEntry',
      T.STRING,
      T.UINT64,
    );
    const violations = checkContractDescriptors(
      setOf(
        // Not a contract file; its message is reached from one.
        fileOf({
          name: 'doric/shared/v1/shared.proto',
          package: 'doric.shared.v1',
          messages: [message('Inner', [field('n', 1, T.FIXED64)])],
        }),
        fileOf({
          name: 'doric/counts/v1/counts.proto',
          package: 'doric.counts.v1',
          contract: hostContract('counts/v1'),
          dependency: ['doric/shared/v1/shared.proto'],
          messages: [
            message(
              'Counts',
              [
                byId.field,
                totals.field,
                messageField('inner', 3, '.doric.shared.v1.Inner'),
              ],
              { nestedType: [byId.entry, totals.entry] },
            ),
          ],
        }),
      ),
    );
    assert.deepEqual(ofCode(violations, 'contract_64bit'), [
      {
        code: 'contract_64bit',
        file: 'doric/counts/v1/counts.proto',
        element: 'doric.counts.v1.Counts.by_id',
      },
      {
        code: 'contract_64bit',
        file: 'doric/counts/v1/counts.proto',
        element: 'doric.counts.v1.Counts.totals',
      },
      {
        code: 'contract_64bit',
        file: 'doric/shared/v1/shared.proto',
        element: 'doric.shared.v1.Inner.n',
      },
    ]);
  });

  test('contract_wkt: Timestamp, Duration, Int64Value and UInt64Value', () => {
    const violations = checkContractDescriptors(
      setOf(
        fileOf({
          name: 'doric/clock/v1/clock.proto',
          package: 'doric.clock.v1',
          contract: hostContract('clock/v1'),
          messages: [
            message('Tick', [
              messageField('at', 1, '.google.protobuf.Timestamp'),
              messageField('every', 2, '.google.protobuf.Duration'),
              messageField('signed', 3, '.google.protobuf.Int64Value'),
              messageField('unsigned', 4, '.google.protobuf.UInt64Value'),
            ]),
          ],
        }),
      ),
    );
    // The check does not descend into google.protobuf.*: no contract_64bit.
    assert.deepEqual(located(violations), [
      {
        code: 'contract_wkt',
        file: 'doric/clock/v1/clock.proto',
        element: 'doric.clock.v1.Tick.at',
      },
      {
        code: 'contract_wkt',
        file: 'doric/clock/v1/clock.proto',
        element: 'doric.clock.v1.Tick.every',
      },
      {
        code: 'contract_wkt',
        file: 'doric/clock/v1/clock.proto',
        element: 'doric.clock.v1.Tick.signed',
      },
      {
        code: 'contract_wkt',
        file: 'doric/clock/v1/clock.proto',
        element: 'doric.clock.v1.Tick.unsigned',
      },
    ]);
  });

  test('every violation carries a message for a person', () => {
    const violations = checkContractDescriptors(
      setOf(
        fileOf({
          name: 'doric/tool/v1/tool.proto',
          package: 'doric.tool.v1',
          contract: hostContract('tools/v1'),
          messages: [message('Thing', [field('size', 1, T.INT64)])],
        }),
      ),
    );
    assert.ok(violations.length >= 2);
    for (const violation of violations) {
      assert.equal(typeof violation.message, 'string');
      assert.ok(violation.message.trim().length > 0, violation.code);
    }
  });
});

describe('checkContractDescriptors: what passes', () => {
  test("control.proto's uint64 fields: not a contract file", () => {
    const set = create(FileDescriptorSetSchema, {
      file: [
        ...withImports(file_doric_platform_v1_control),
        ...baseFiles().filter(
          (file) =>
            !withImports(file_doric_platform_v1_control).some(
              (other) => other.name === file.name,
            ),
        ),
        validContract('things', 'things/v1', 'doric.things.v1'),
      ],
    });
    assert.deepEqual(located(checkContractDescriptors(set)), []);
  });

  test('google.protobuf.Value, Struct, ListValue and Any in a contract message', () => {
    const violations = checkContractDescriptors(
      setOf(
        fileOf({
          name: 'doric/loose/v1/loose.proto',
          package: 'doric.loose.v1',
          contract: hostContract('loose/v1'),
          messages: [
            message('Payload', [
              messageField('value', 1, '.google.protobuf.Value'),
              messageField('struct', 2, '.google.protobuf.Struct'),
              messageField('list', 3, '.google.protobuf.ListValue'),
              messageField('any', 4, '.google.protobuf.Any'),
            ]),
          ],
        }),
      ),
    );
    assert.deepEqual(located(violations), []);
  });

  test('a doric.* contract without environment', () => {
    const violations = checkContractDescriptors(
      setOf(
        fileOf({
          name: 'doric/platform/catalog/v1/catalog.proto',
          package: 'doric.platform.catalog.v1',
          contract: { id: 'doric.catalog/v1', cardinality: Cardinality.ONE },
          messages: [message('Entry', [field('id', 1, T.STRING)])],
        }),
      ),
    );
    assert.deepEqual(located(violations), []);
  });

  test('violations are sorted by file, then element', () => {
    // Declared out of order: the zeta file first, each message's fields
    // backwards.
    const violations = checkContractDescriptors(
      setOf(
        fileOf({
          name: 'doric/zeta/v1/zeta.proto',
          package: 'doric.zeta.v1',
          contract: hostContract('zeta/v1'),
          messages: [
            message('Z', [field('b', 1, T.INT64), field('a', 2, T.INT64)]),
          ],
        }),
        fileOf({
          name: 'doric/alpha/v1/alpha.proto',
          package: 'doric.alpha.v1',
          contract: hostContract('alpha/v1'),
          messages: [
            message('A', [field('d', 1, T.UINT64), field('c', 2, T.UINT64)]),
          ],
        }),
      ),
    );
    assert.deepEqual(
      violations.map(({ file, element }) => `${file} ${element}`),
      [
        'doric/alpha/v1/alpha.proto doric.alpha.v1.A.c',
        'doric/alpha/v1/alpha.proto doric.alpha.v1.A.d',
        'doric/zeta/v1/zeta.proto doric.zeta.v1.Z.a',
        'doric/zeta/v1/zeta.proto doric.zeta.v1.Z.b',
      ],
    );
  });
});

const cli = fileURLToPath(
  new URL('../src/build/proto-rules.js', import.meta.url),
);
const buf = resolve('node_modules/.bin/buf');

const withTemp = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'proto-rules-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe('the proto-rules CLI', () => {
  test('exits with 1 and writes <file>: <element>: <code>: <message> for a violation', async () => {
    await withTemp(async (dir) => {
      const image = join(dir, 'image.binpb');
      const set = setOf(
        fileOf({
          name: 'doric/sizes/v1/sizes.proto',
          package: 'doric.sizes.v1',
          contract: hostContract('sizes/v1'),
          messages: [message('Size', [field('bytes', 1, T.INT64)])],
        }),
      );
      await writeFile(image, toBinary(FileDescriptorSetSchema, set));
      const run = spawnSync(process.execPath, [cli, image], {
        encoding: 'utf8',
      });
      assert.equal(run.status, 1, run.stderr);
      const lines = run.stderr.split('\n').filter((line) => line !== '');
      assert.equal(lines.length, 1, run.stderr);
      assert.match(
        lines[0] as string,
        /^doric\/sizes\/v1\/sizes\.proto: doric\.sizes\.v1\.Size\.bytes: contract_64bit: \S.*$/,
      );
    });
  });

  test('exits with 0 on buf build --as-file-descriptor-set of the repository', async () => {
    await withTemp(async (dir) => {
      const image = join(dir, 'image.binpb');
      const build = spawnSync(
        buf,
        ['build', '--as-file-descriptor-set', '-o', image],
        { encoding: 'utf8' },
      );
      assert.equal(build.status, 0, build.stderr);
      const set = fromBinary(FileDescriptorSetSchema, await readFile(image));
      assert.ok(
        set.file.some((file) => file.name === 'doric/files/v1/files.proto'),
        'the image holds the repository contracts',
      );
      assert.deepEqual(located(checkContractDescriptors(set)), []);
      const run = spawnSync(process.execPath, [cli, image], {
        encoding: 'utf8',
      });
      assert.equal(run.stderr, '');
      assert.equal(run.status, 0);
    });
  });
});

interface BufConfig {
  readonly lint?: Record<string, unknown>;
  readonly modules?: readonly { readonly lint?: unknown }[];
}

const rootBufConfig = async (): Promise<BufConfig> =>
  parse(await readFile('buf.yaml', 'utf8')) as BufConfig;

/** The rule ids `buf lint` reports for one fixture under the root's `lint`. */
const lintRules = async (
  fixture: string,
): Promise<{ status: number | null; rules: string[] }> => {
  const { lint } = await rootBufConfig();
  return withTemp(async (dir) => {
    await writeFile(join(dir, 'buf.yaml'), stringify({ version: 'v2', lint }));
    // The fixture's package is fixture.v1, so PACKAGE_DIRECTORY_MATCH holds.
    await mkdir(join(dir, 'fixture', 'v1'), { recursive: true });
    await copyFile(
      join('packages/bundle/tests/fixtures/buf-lint', fixture, 'x.proto'),
      join(dir, 'fixture', 'v1', 'x.proto'),
    );
    const run = spawnSync(buf, ['lint', '--error-format', 'json'], {
      cwd: dir,
      encoding: 'utf8',
    });
    const rules = run.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => (JSON.parse(line) as { type: string }).type);
    return { status: run.status, rules };
  });
};

describe("buf lint with the root's rules", () => {
  for (const [fixture, rule] of [
    ['service-suffix', 'SERVICE_SUFFIX'],
    ['empty-response', 'RPC_RESPONSE_STANDARD_NAME'],
    ['shared-request', 'RPC_REQUEST_RESPONSE_UNIQUE'],
    ['enum-zero', 'ENUM_ZERO_VALUE_SUFFIX'],
  ] as const) {
    test(`refuses ${fixture} with ${rule}`, async () => {
      const { status, rules } = await lintRules(fixture);
      assert.notEqual(status, 0);
      assert.ok(rules.includes(rule), `${rule} in ${rules.join(', ')}`);
    });
  }

  test('the root buf.yaml has no except and no ignore', async () => {
    const config = await rootBufConfig();
    assert.deepEqual(config.lint?.use, ['STANDARD']);
    for (const key of ['except', 'ignore', 'ignore_only']) {
      assert.equal(config.lint?.[key], undefined, `lint.${key}`);
    }
    for (const module of config.modules ?? []) {
      assert.equal(module.lint, undefined, 'a module-level lint section');
    }
  });
});
