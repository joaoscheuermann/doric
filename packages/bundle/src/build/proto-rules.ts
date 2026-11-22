// The proto check (spec `docs/designs/grpc-processes.md`, section 8, "The
// proto check", A54): the rules for contract `.proto` files that `buf lint`
// does not check. It reads one `FileDescriptorSet` holding every contract of
// the repository and their imports (`buf build --as-file-descriptor-set`),
// since two ids that map to one package are only visible across bundles.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createFileRegistry,
  type DescField,
  type DescFile,
  type DescMessage,
  fromBinary,
  getOption,
  hasOption,
  ScalarType,
} from '@bufbuild/protobuf';
import {
  type FileDescriptorSet,
  FileDescriptorSetSchema,
} from '@bufbuild/protobuf/wkt';

import {
  Cardinality,
  contract,
  Environment,
  HookKind,
  hook,
  hooks,
} from '../contracts/gen/doric/platform/v1/options_pb.js';
import { contractIdPattern, isPlatformContract } from '../contracts/ids.js';

/**
 * Why a descriptor set fails the proto check. One code per rule; the set is
 * closed, and a new rule adds a code.
 */
export type ProtoRuleCode =
  | 'invalid_contract_id' // the option's id fails contractIdPattern (ids.ts:14-15)
  | 'reserved_contract_id' // a bundle's id whose first segment is `platform`
  | 'package_mismatch' // the file's package is not packageOfContractId(id)
  | 'duplicate_package' // two ids map to one package
  | 'duplicate_contract' // two files declare one id
  | 'unspecified_option' // an _UNSPECIFIED value the rules above refuse
  | 'platform_environment' // a doric.* contract that sets environment (A52)
  | 'contract_enum' // an enum field in a contract message
  | 'contract_64bit' // a 64-bit integer field, map keys and values included
  | 'contract_wkt'; // Timestamp, Duration, Int64Value or UInt64Value

/** One refused element of a descriptor set. */
export interface ProtoRuleViolation {
  /** The rule the element breaks. */
  readonly code: ProtoRuleCode;
  /** The file's name in the set: `doric/tools/v1/tools.proto`. */
  readonly file: string;
  /** The full name of the package, message, field or enum. */
  readonly element: string;
  /** A sentence for a person: what is wrong and what the rule asks. */
  readonly message: string;
}

/**
 * The package of a contract id (A51): `<name>/v<major>` maps to
 * `doric.<name>.v<major>`, and a platform id `doric.<name>/v<major>` to
 * `doric.platform.<name>.v<major>`, every `-` of the name replaced by `_`
 * (`core.open-settings/v1` → `doric.core.open_settings.v1`). Pure and total
 * over the ids `contractIdPattern` accepts; the one implementation of the
 * mapping.
 *
 * @throws Error when `contractIdPattern` refuses `id`.
 */
export function packageOfContractId(id: string): string {
  if (!contractIdPattern.test(id)) {
    throw new Error(`${JSON.stringify(id)} is not a contract id`);
  }
  const slash = id.lastIndexOf('/');
  const name = id.slice(0, slash).replaceAll('-', '_');
  const major = id.slice(slash + 1);
  const path = isPlatformContract(id)
    ? `platform.${name.slice('doric.'.length)}`
    : name;
  return `doric.${path}.${major}`;
}

/** The four well-known types that hold a 64-bit integer. */
const wkt64 = new Set([
  'google.protobuf.Timestamp',
  'google.protobuf.Duration',
  'google.protobuf.Int64Value',
  'google.protobuf.UInt64Value',
]);

const scalar64 = new Set<ScalarType>([
  ScalarType.INT64,
  ScalarType.UINT64,
  ScalarType.SINT64,
  ScalarType.FIXED64,
  ScalarType.SFIXED64,
]);

/** A message and its nested messages, map entries excluded, recursively. */
const messagesOf = (messages: readonly DescMessage[]): DescMessage[] =>
  messages.flatMap((message) => [
    message,
    ...messagesOf(message.nestedMessages),
  ]);

/** What a field holds, whether it is a singular, a list or a map value. */
interface FieldType {
  readonly scalars: readonly ScalarType[];
  readonly isEnum: boolean;
  readonly message: DescMessage | undefined;
}

const typeOf = (field: DescField): FieldType => {
  switch (field.fieldKind) {
    case 'scalar':
      return { scalars: [field.scalar], isEnum: false, message: undefined };
    case 'enum':
      return { scalars: [], isEnum: true, message: undefined };
    case 'message':
      return { scalars: [], isEnum: false, message: field.message };
    case 'list':
      return {
        scalars: field.listKind === 'scalar' ? [field.scalar] : [],
        isEnum: field.listKind === 'enum',
        message: field.listKind === 'message' ? field.message : undefined,
      };
    case 'map':
      return {
        scalars: [
          field.mapKey,
          ...(field.mapKind === 'scalar' ? [field.scalar] : []),
        ],
        isEnum: field.mapKind === 'enum',
        message: field.mapKind === 'message' ? field.message : undefined,
      };
  }
};

const byFileThenElement = (a: ProtoRuleViolation, b: ProtoRuleViolation) => {
  for (const key of ['file', 'element', 'code'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
};

/** A valid contract or hooks id, with the file that declares it. */
interface Declared {
  readonly file: DescFile;
  readonly id: string;
}

/**
 * Checks every contract file of `set` — a file with the option
 * `(doric.platform.v1.contract)` or `(doric.platform.v1.hooks)` — and every
 * message their fields reach, in any file of the set, against the rules of
 * section 8 that `buf lint` does not check. It does not descend into
 * `google.protobuf.*`: the four types of `contract_wkt` are refused, and
 * `Value`, `Struct`, `ListValue` and `Any` pass.
 *
 * Expects a self-contained set, each file's imports in it, as `buf build`
 * writes it; throws when the set cannot be read as one file registry. Does
 * not modify `set`.
 *
 * @returns Every violation, sorted by file, then element; empty when the set
 *   passes.
 */
export function checkContractDescriptors(
  set: FileDescriptorSet,
): readonly ProtoRuleViolation[] {
  const registry = createFileRegistry(set);
  const violations: ProtoRuleViolation[] = [];
  const report = (
    code: ProtoRuleCode,
    file: DescFile,
    element: string,
    message: string,
  ) => violations.push({ code, file: file.proto.name, element, message });

  const contractFiles: DescFile[] = [];
  const declared: Declared[] = [];
  for (const file of registry.files) {
    const isContract = hasOption(file, contract);
    const isHooks = hasOption(file, hooks);
    if (!isContract && !isHooks) continue;
    contractFiles.push(file);
    const pkg = file.proto.package;
    const ids: string[] = [];
    if (isContract) {
      const option = getOption(file, contract);
      ids.push(option.id);
      if (option.cardinality === Cardinality.UNSPECIFIED) {
        report(
          'unspecified_option',
          file,
          pkg,
          `contract ${JSON.stringify(option.id)} has no cardinality; set CARDINALITY_ONE or CARDINALITY_MANY`,
        );
      }
      if (isPlatformContract(option.id)) {
        if (option.environment !== Environment.UNSPECIFIED) {
          report(
            'platform_environment',
            file,
            pkg,
            `platform contract ${JSON.stringify(option.id)} sets an environment; a doric.* contract states none`,
          );
        }
      } else if (option.environment === Environment.UNSPECIFIED) {
        report(
          'unspecified_option',
          file,
          pkg,
          `contract ${JSON.stringify(option.id)} has no environment; set ENVIRONMENT_HOST or ENVIRONMENT_CLIENT`,
        );
      }
    }
    if (isHooks) ids.push(getOption(file, hooks).id);
    for (const id of ids) {
      if (!contractIdPattern.test(id)) {
        report(
          'invalid_contract_id',
          file,
          pkg,
          `${JSON.stringify(id)} is not a contract id <name>/v<major> of lowercase segments`,
        );
        continue;
      }
      declared.push({ file, id });
      if (!isPlatformContract(id) && id.split(/[./]/)[0] === 'platform') {
        report(
          'reserved_contract_id',
          file,
          pkg,
          `${JSON.stringify(id)} starts with the reserved segment platform`,
        );
      }
      const expected = packageOfContractId(id);
      if (pkg !== expected) {
        report(
          'package_mismatch',
          file,
          pkg,
          `the package of ${JSON.stringify(id)} is ${expected}, not ${pkg}`,
        );
      }
    }
    for (const message of messagesOf(file.messages)) {
      if (
        hasOption(message, hook) &&
        getOption(message, hook).kind === HookKind.UNSPECIFIED
      ) {
        report(
          'unspecified_option',
          file,
          message.typeName,
          `hook input ${message.typeName} has no kind; set a HookKind other than HOOK_KIND_UNSPECIFIED`,
        );
      }
    }
  }

  const filesById = new Map<string, DescFile[]>();
  const idsByPackage = new Map<string, Set<string>>();
  for (const { file, id } of declared) {
    filesById.set(id, [...(filesById.get(id) ?? []), file]);
    const pkg = packageOfContractId(id);
    idsByPackage.set(pkg, (idsByPackage.get(pkg) ?? new Set()).add(id));
  }
  for (const [id, files] of filesById) {
    if (files.length < 2) continue;
    for (const file of files) {
      report(
        'duplicate_contract',
        file,
        file.proto.package,
        `${JSON.stringify(id)} is declared by ${files.length} files; declare it once`,
      );
    }
  }
  for (const { file, id } of declared) {
    const pkg = packageOfContractId(id);
    const ids = idsByPackage.get(pkg) ?? new Set();
    if (ids.size < 2) continue;
    const others = [...ids].filter((other) => other !== id);
    report(
      'duplicate_package',
      file,
      file.proto.package,
      `${JSON.stringify(id)} maps to ${pkg}, as ${others.map((other) => JSON.stringify(other)).join(', ')} does`,
    );
  }

  const seen = new Set<string>();
  const pending = contractFiles.flatMap((file) => messagesOf(file.messages));
  for (let message = pending.pop(); message; message = pending.pop()) {
    if (seen.has(message.typeName)) continue;
    seen.add(message.typeName);
    for (const field of message.fields) {
      const element = `${message.typeName}.${field.name}`;
      const type = typeOf(field);
      if (type.isEnum) {
        report(
          'contract_enum',
          message.file,
          element,
          `${element} is an enum; a contract message holds a closed set as a string`,
        );
      }
      if (type.scalars.some((scalar) => scalar64.has(scalar))) {
        report(
          'contract_64bit',
          message.file,
          element,
          `${element} holds a 64-bit integer; use a 32-bit integer, a double or a string`,
        );
      }
      const target = type.message;
      if (target === undefined) continue;
      if (wkt64.has(target.typeName)) {
        report(
          'contract_wkt',
          message.file,
          element,
          `${element} is a ${target.typeName}, which holds a 64-bit integer; use a string or a number`,
        );
      } else if (!target.typeName.startsWith('google.protobuf.')) {
        pending.push(target);
      }
    }
  }

  return violations.sort(byFileThenElement);
}

/**
 * The CLI: reads the binary `FileDescriptorSet` at `path`, writes each
 * violation to stderr as `<file>: <element>: <code>: <message>`, and returns
 * the exit code, 1 when there is a violation and 0 otherwise.
 */
const runCli = async (path: string): Promise<number> => {
  const set = fromBinary(FileDescriptorSetSchema, await readFile(path));
  const violations = checkContractDescriptors(set);
  for (const { file, element, code, message } of violations) {
    process.stderr.write(`${file}: ${element}: ${code}: ${message}\n`);
  }
  return violations.length > 0 ? 1 : 0;
};

const here = fileURLToPath(import.meta.url);

if (process.argv[1] !== undefined && resolve(process.argv[1]) === here) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 1) {
      throw new Error('usage: proto-rules <file-descriptor-set>');
    }
    process.exitCode = await runCli(args[0] as string);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
