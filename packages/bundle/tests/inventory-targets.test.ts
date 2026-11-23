// The contracts of phase 1 against the inventory (spec
// `docs/designs/grpc-processes.md`, phase 1, AC1.1, AC1.4, AC1.5, T1.2, T1.4,
// T1.5; section 8, "Package per contract id";
// `docs/designs/grpc-processes/contract-inventory.md` sections A, B and C):
//
// - T1.2: the target `<contract id>.<Rpc>` of each row of section A is a
//   method of a service in the package `packageOfContractId(<contract id>)`.
// - AC1.1: every contract id that crosses gRPC has exactly one file whose
//   `(doric.platform.v1.contract)` or `(doric.platform.v1.hooks)` id is that
//   id, in the package of that id. The ids include the `api.<resource>/v1`
//   ids the intro of section B names (A60).
// - T1.4: the RPC each row of section B names (a REST route or a Socket.IO
//   namespace) is a method of the service `doric.api.<Service>` of the image,
//   in the package of one of those `api.*` ids.
// - AC1.4: no generated file imports, through a relative path, a file outside
//   the `gen/` directory it is generated into.
// - T1.5: every `buf.validate` rule of every message compiles: validating a default
//   instance answers valid or invalid, never an error.
//
// The image is `buf build --as-file-descriptor-set` of the repository, built
// once with the real binary of `node_modules/.bin`; paths are from the
// repository root, the directory the tests run from.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test, { describe } from 'node:test';

import {
  create,
  createFileRegistry,
  type DescMessage,
  fromBinary,
  getOption,
  hasOption,
} from '@bufbuild/protobuf';
import {
  type FileDescriptorSet,
  FileDescriptorSetSchema,
} from '@bufbuild/protobuf/wkt';
import { createValidator } from '@bufbuild/protovalidate';

import { packageOfContractId } from '../src/build/proto-rules.js';
import {
  Cardinality,
  contract,
  Environment,
  hooks,
} from '../src/contracts/gen/doric/platform/v1/options_pb.js';
import { contractIdPattern, isPlatformContract } from '../src/contracts/ids.js';

const inventoryPath = 'docs/designs/grpc-processes/contract-inventory.md';

// Ids inventory C removes that never cross gRPC between phase 3 and their
// removal, so no `.proto` declares them (spec A59). Every
// other `provides` id of every manifest and every platform id of inventory C
// needs a `.proto`.
const REMOVED_WITHOUT_PROTO: ReadonlySet<string> = new Set([
  'chat.hooks/v2',
  'workspace.hooks/v1',
  'core.hooks/v1',
  'core.commands/v1',
  'notifications.observations/v1',
  'papercraft.cache/v1',
  'doric.window.hooks/v1',
  'doric.network/v1',
  'doric.elements/v1',
]);

/** `buf build --as-file-descriptor-set` of the repository. */
const buildImage = async (): Promise<FileDescriptorSet> => {
  const dir = await mkdtemp(join(tmpdir(), 'inventory-targets-'));
  try {
    const image = join(dir, 'image.binpb');
    const build = spawnSync(
      resolve('node_modules/.bin/buf'),
      ['build', '--as-file-descriptor-set', '-o', image],
      { encoding: 'utf8' },
    );
    assert.equal(build.status, 0, build.stderr);
    return fromBinary(FileDescriptorSetSchema, await readFile(image));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const image = await buildImage();
const registry = createFileRegistry(image);
const files = [...registry.files];
const inventory = await readFile(inventoryPath, 'utf8');

/** The text of a `## <letter>. …` section of the inventory. */
const sectionOf = (letter: string): string => {
  const start = inventory.indexOf(`\n## ${letter}. `);
  assert.notEqual(start, -1, `the inventory has a section ${letter}`);
  const end = inventory.indexOf('\n## ', start + 1);
  return inventory.slice(start, end === -1 ? undefined : end);
};

/** The cells of a markdown table row, outer pipes removed. */
const cellsOf = (row: string): string[] =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

interface InventoryRow {
  readonly row: number;
  readonly contract: string;
  readonly method: string;
  readonly target: string;
}

const sectionARows: InventoryRow[] = sectionOf('A')
  .split('\n')
  .filter((line) => /^\|\s*\d+\s*\|/.test(line))
  .map((line) => {
    const cells = cellsOf(line);
    return {
      row: Number(cells[0]),
      contract: (cells[1] ?? '').replaceAll('`', ''),
      method: (cells[2] ?? '').replaceAll('`', ''),
      target: cells.slice(5).join('|'),
    };
  });

const rowsByNumber = new Map(sectionARows.map((row) => [row.row, row]));

/** The `<contract id>.<Rpc>` a target names, or why it names none. */
type Target =
  | { readonly kind: 'rpc'; readonly id: string; readonly rpc: string }
  | { readonly kind: 'removed' }
  | { readonly kind: 'unparsed' };

const targetPattern =
  /^`([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*\/v[1-9][0-9]*)\.([A-Z][A-Za-z0-9]*)/;

const targetOf = (row: InventoryRow, seen: Set<number> = new Set()): Target => {
  if (/^Removed\b/.test(row.target)) return { kind: 'removed' };
  const same = /^As row (\d+)\b/.exec(row.target);
  if (same !== null) {
    const other = rowsByNumber.get(Number(same[1]));
    if (other === undefined || seen.has(other.row)) return { kind: 'unparsed' };
    seen.add(row.row);
    return targetOf(other, seen);
  }
  // Rows 69 and 96 name their phase-3 target first.
  const text = row.target.replace(/^Phase \d+:\s*/, '');
  const match = targetPattern.exec(text);
  if (match === null) return { kind: 'unparsed' };
  return { kind: 'rpc', id: match[1] as string, rpc: match[2] as string };
};

describe('T1.2: every target of inventory section A is an rpc of the image', () => {
  test('section A has rows', () => {
    assert.ok(sectionARows.length >= 115, `${sectionARows.length} rows`);
  });

  for (const row of sectionARows) {
    const target = targetOf(row);
    if (target.kind === 'removed') continue;
    const name =
      target.kind === 'rpc'
        ? `row ${row.row} (${row.contract} ${row.method}): ${target.id}.${target.rpc}`
        : `row ${row.row} (${row.contract} ${row.method}): target`;
    test(name, () => {
      assert.equal(
        target.kind,
        'rpc',
        `row ${row.row} names neither a target nor a removal: ${row.target.slice(0, 120)}`,
      );
      if (target.kind !== 'rpc') return;
      const pkg = packageOfContractId(target.id);
      const services = files
        .filter((file) => file.proto.package === pkg)
        .flatMap((file) => file.services);
      const methods = services.flatMap((service) =>
        service.methods.map((method) => `${service.typeName}.${method.name}`),
      );
      assert.ok(
        services.some((service) =>
          service.methods.some((method) => method.name === target.rpc),
        ),
        `no service of package ${pkg} has the rpc ${target.rpc}; ` +
          `the package's rpcs: ${JSON.stringify(methods)}`,
      );
    });
  }
});

/** The text of section B before its first table: the intro naming the ids. */
const sectionBIntro = (): string => {
  const section = sectionOf('B');
  const table = section.indexOf('\n|');
  return table === -1 ? section : section.slice(0, table);
};

/** The `api.<resource>/v<n>` ids the intro of section B names (A60). */
const apiIdsOfSectionB = (): string[] => [
  ...new Set(
    [...sectionBIntro().matchAll(/`(api\.[a-z0-9-]+\/v[1-9][0-9]*)`/g)].map(
      (match) => match[1] as string,
    ),
  ),
];

interface PublicApiRow {
  /** The service as the table names it, under `doric.api.`. */
  readonly service: string;
  readonly rpc: string;
  /** The REST route or Socket.IO namespace the rpc replaces. */
  readonly replaces: string;
  /** The table's Kind (`unary`, `server streaming`, …) as a descriptor `methodKind`. */
  readonly kind: string;
}

/** The rows of section B's route table that name a service; `none` rows stay HTTP. */
const sectionBRows: PublicApiRow[] = sectionOf('B')
  .split('\n')
  .filter((line) => /^\|\s*`[a-z][a-z0-9_]*\.v[1-9][0-9]*\.[A-Z]/.test(line))
  .map((line) => {
    const cells = cellsOf(line);
    return {
      service: (cells[0] ?? '').replaceAll('`', ''),
      rpc: (cells[1] ?? '').replaceAll('`', ''),
      replaces: (cells[3] ?? '').replaceAll('`', ''),
      kind: (cells[2] ?? '').replaceAll('`', '').replace(/\s+/g, '_'),
    };
  });

describe('T1.4: every service of inventory section B exists in the image with its kind', () => {
  test('T1.4 section B names the eight api ids and each has a row', () => {
    const apiIds = apiIdsOfSectionB();
    assert.equal(apiIds.length, 8, JSON.stringify(apiIds));
    const rowPackages = new Set(
      sectionBRows.map((row) => {
        const full = `doric.api.${row.service}`;
        return full.slice(0, full.lastIndexOf('.'));
      }),
    );
    for (const id of apiIds) {
      assert.ok(
        rowPackages.has(packageOfContractId(id)),
        `no row of section B for ${id}`,
      );
    }
  });

  for (const row of sectionBRows) {
    const fullName = `doric.api.${row.service}`;
    test(`T1.4 ${row.replaces}: ${fullName}.${row.rpc}`, () => {
      const pkg = fullName.slice(0, fullName.lastIndexOf('.'));
      const id = apiIdsOfSectionB().find(
        (apiId) => packageOfContractId(apiId) === pkg,
      );
      assert.ok(
        id !== undefined,
        `no api id of section B's intro maps to ${pkg}`,
      );
      const service = files
        .filter((file) => file.proto.package === pkg)
        .flatMap((file) => file.services)
        .find((candidate) => candidate.typeName === fullName);
      const packageRpcs = files
        .filter((file) => file.proto.package === pkg)
        .flatMap((file) => file.services)
        .flatMap((candidate) =>
          candidate.methods.map(
            (method) => `${candidate.typeName}.${method.name}`,
          ),
        );
      assert.ok(
        service !== undefined,
        `the image has no service ${fullName}; the package's rpcs: ${JSON.stringify(packageRpcs)}`,
      );
      assert.ok(
        service.methods.some((method) => method.name === row.rpc),
        `${fullName} has no rpc ${row.rpc}; the package's rpcs: ${JSON.stringify(packageRpcs)}`,
      );
      const method = service.methods.find(
        (candidate) => candidate.name === row.rpc,
      );
      assert.equal(
        method?.methodKind,
        row.kind,
        `${fullName}.${row.rpc} is ${method?.methodKind}; section B's Kind says ${row.kind}`,
      );
    });
  }

  for (const id of apiIdsOfSectionB()) {
    test(`T1.4 ${id} declares cardinality ONE and environment HOST`, () => {
      const declaring = files.filter(
        (file) =>
          hasOption(file, contract) && getOption(file, contract).id === id,
      );
      assert.ok(
        declaring.length > 0,
        `no file of the image declares contract ${id}`,
      );
      for (const file of declaring) {
        const option = getOption(file, contract);
        assert.equal(
          option.cardinality,
          Cardinality.ONE,
          `${file.name} declares ${id} with cardinality ${Cardinality[option.cardinality]}`,
        );
        assert.equal(
          option.environment,
          Environment.HOST,
          `${file.name} declares ${id} with environment ${Environment[option.environment]}`,
        );
      }
    });
  }
});

/** The `provides` ids of every bundle manifest, versions removed. */
const manifestIds = async (): Promise<Map<string, string[]>> => {
  const ids = new Map<string, string[]>();
  for (const group of await readdir('bundles', { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = join('bundles', group.name);
    for (const bundle of await readdir(groupDir, { withFileTypes: true })) {
      if (!bundle.isDirectory()) continue;
      const path = join(groupDir, bundle.name, 'manifest.json');
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      const manifest = JSON.parse(text) as { provides?: readonly string[] };
      for (const entry of manifest.provides ?? []) {
        const id = entry.replace(/@.*$/, '');
        ids.set(id, [...(ids.get(id) ?? []), path]);
      }
    }
  }
  return ids;
};

/** The platform ids section C names in code spans. */
const platformIdsOfSectionC = (): string[] =>
  [...sectionOf('C').matchAll(/`([^`]+)`/g)]
    .map((match) => match[1] as string)
    .filter((id) => contractIdPattern.test(id) && isPlatformContract(id));

const requiredIds = async (): Promise<string[]> => {
  const ids = new Set([
    ...(await manifestIds()).keys(),
    ...platformIdsOfSectionC(),
    ...apiIdsOfSectionB(),
  ]);
  return [...ids].filter((id) => !REMOVED_WITHOUT_PROTO.has(id)).sort();
};

/** Each contract or hooks id the image's files declare, with its files. */
const declaredIds = (): Map<string, { name: string; package: string }[]> => {
  const declared = new Map<string, { name: string; package: string }[]>();
  for (const file of files) {
    const ids: string[] = [];
    if (hasOption(file, contract)) ids.push(getOption(file, contract).id);
    if (hasOption(file, hooks)) ids.push(getOption(file, hooks).id);
    for (const id of ids) {
      declared.set(id, [
        ...(declared.get(id) ?? []),
        { name: file.proto.name, package: file.proto.package },
      ]);
    }
  }
  return declared;
};

const required = await requiredIds();
const declared = declaredIds();

describe('AC1.1: every id that crosses gRPC has one .proto in its package', () => {
  test('the required ids hold the manifests and the platform', () => {
    assert.ok(required.includes('files/v1'));
    assert.ok(required.includes('doric.catalog/v1'));
    for (const id of REMOVED_WITHOUT_PROTO) assert.ok(!required.includes(id));
  });

  test('the required ids hold the api ids of section B', () => {
    const apiIds = apiIdsOfSectionB();
    assert.equal(apiIds.length, 8, JSON.stringify(apiIds));
    for (const id of apiIds) assert.ok(required.includes(id), id);
  });

  for (const id of required) {
    test(id, () => {
      const declaring = declared.get(id) ?? [];
      assert.equal(
        declaring.length,
        1,
        `${declaring.length} files declare ${id}: ${JSON.stringify(declaring)}`,
      );
      assert.equal(declaring[0]?.package, packageOfContractId(id));
    });
  }
});

const skippedDirs = new Set([
  'node_modules',
  '.git',
  '.nx',
  'dist',
  'dist-tests',
  'tmp',
  'coverage',
]);

/** Every `src/contracts/gen` directory under `root`. */
const genDirs = async (root: string): Promise<string[]> => {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skippedDirs.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (path.endsWith(join('src', 'contracts', 'gen'))) {
        found.push(path);
        continue;
      }
      await walk(path);
    }
  };
  await walk(root);
  return found.sort();
};

/** Every `.ts` file under `dir`. */
const tsFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
};

const importSpecifiers = (source: string): string[] =>
  [
    ...source.matchAll(
      /(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)["']([^"']+)["']/g,
    ),
  ].map((match) => match[1] as string);

const gens = (
  await Promise.all(['bundles', 'packages', 'benchmarks', 'app'].map(genDirs))
).flat();

describe('AC1.4: no generated file imports a relative path outside its gen/', () => {
  test('the repository has generated directories', () => {
    assert.ok(
      gens.includes(join('packages', 'bundle', 'src', 'contracts', 'gen')),
    );
  });

  for (const gen of gens) {
    const project = gen.slice(0, -join('src', 'contracts', 'gen').length - 1);
    test(project, async (context) => {
      const generated = await tsFiles(gen);
      if (generated.length === 0) {
        context.skip(`no generated .ts files under ${gen}`);
        return;
      }
      const leaving: string[] = [];
      for (const file of generated) {
        const source = await readFile(file, 'utf8');
        for (const specifier of importSpecifiers(source)) {
          if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
            continue;
          }
          const target = relative(gen, resolve(dirname(file), specifier));
          if (target === '..' || target.startsWith(`..${sep}`)) {
            leaving.push(`${file}: ${specifier}`);
          }
        }
      }
      assert.deepEqual(leaving, []);
    });
  }
});

/** A message and its nested messages, recursively. */
const messagesOf = (messages: readonly DescMessage[]): DescMessage[] =>
  messages.flatMap((message) => [
    message,
    ...messagesOf(message.nestedMessages),
  ]);

describe('T1.5: every buf.validate rule of the image compiles', () => {
  const messages = files.flatMap((file) => messagesOf(file.messages));

  test('the image has messages', () => {
    assert.ok(messages.length > 0);
  });

  test('validating a default instance of each message answers valid or invalid', () => {
    const validator = createValidator({ registry });
    const errors: string[] = [];
    for (const message of messages) {
      try {
        const result = validator.validate(message, create(message));
        if (result.kind === 'error') {
          errors.push(
            `${message.typeName}: ${result.error.name}: ${result.error.message}`,
          );
        }
      } catch (error) {
        errors.push(`${message.typeName}: threw: ${String(error)}`);
      }
    }
    assert.deepEqual(errors, []);
  });
});
