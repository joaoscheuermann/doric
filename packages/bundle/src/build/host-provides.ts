// What a bundle's host part provides beyond its dry-activation recording
// (spec `docs/designs/grpc-processes.md`, A61, A63, A70): the contracts its
// static `services` list serves and the `provides` ids whose `.proto` marks a
// hooks, event, settings or storage-type contract; for a native host part
// (A30), the `provides` ids served by a contract-role service.

import { hasOption } from '@bufbuild/protobuf';

import { basicContractSpec } from '../contracts/basic/index.js';
import {
  event as eventOption,
  settings as settingsOption,
  storage_type as storageTypeOption,
} from '../contracts/gen/doric/platform/v1/options_pb.js';
import type { CatalogIndex, ContractInfo } from '../platform/catalog-index.js';
import type { DescriptorEntry, DescriptorKind } from '../runtime/descriptor.js';
import { type Manifest, parseContractEntry } from '../runtime/manifest.js';
import type { StaticServiceEntry } from './cli.js';
import type { RecordedContract } from './schemas.js';

/**
 * A contract the host part provides without recording it during the dry
 * activation (spec A61, A63, A70): read from the part's static `services`
 * list or from the `.proto` of a `provides` id.
 */
export interface HostProvide {
  /** The contract id, `<name>/v<major>` (`api.threads/v1`). */
  readonly id: string;
  /**
   * `service` for a contract served by its own (contract-role) service;
   * `hooks`, `event`, `settings` or `storage-type` for a contract whose
   * `.proto` marks it so and that no service of it serves.
   */
  readonly kind: Exclude<DescriptorKind, 'command'>;
  /** The contract's cardinality in its `.proto` (`'one'` for a hooks file). */
  readonly cardinality: DescriptorEntry['cardinality'];
  /**
   * Where the build found it, for messages: the `location` of the first
   * `services` entry naming the contract's own service
   * (`src/host/main.ts:12`), or the contract's `.proto` file name
   * (`doric/comments/added/v1/added.proto`).
   */
  readonly source: string;
  /** The version `provides` declares for `id`; `undefined` when it does not list it. */
  readonly declared: string | undefined;
}

/**
 * The contracts a bundle's host part provides beyond its recording, for a
 * manifest of any version (A70).
 *
 * Answers, without duplicates (first occurrence wins):
 *
 * 1. in the order of `services`, the contract of each entry whose service
 *    is in `index` with role `contract` and whose contract's environment is
 *    `HOST` or `HOOKS`, listed in `provides` or not (`declared` tells);
 * 2. then, in the order of `manifest.provides`, each listed id that `index`
 *    knows as a `HOST` or `HOOKS` contract, that 1 did not answer, whose
 *    file declares no contract-role service, and whose kind is `hooks`
 *    (`HOOKS`) or, by the first message option its file carries, `event`,
 *    `settings` or `storage-type`.
 *
 * Leaves out every id that `recorded` holds in environment `host` (the
 * recording already provides it) or `desktopMain` (B2: the desktop part's
 * contract gets no host entry; `chat.composer/v1` while `chat` is
 * version 1), except a basic contract whose fixed table lists both `host`
 * and `desktopMain` (`hooks/v1`, `log/v1`, `settings/v1`): each environment
 * has its own provider of it, so `core`'s desktopMain recording leaves its
 * host service its host entry. Ignores handler services, services of
 * `CLIENT` or `PLATFORM` contracts, and entries that name no service of
 * `index` (the version 2 environment check reports those). A `provides`
 * entry that does not parse is skipped.
 *
 * Pure and deterministic; never throws.
 */
export const hostProvides = (input: {
  readonly manifest: Manifest;
  readonly recorded: readonly RecordedContract[];
  readonly services: readonly StaticServiceEntry[];
  readonly index: CatalogIndex;
}): readonly HostProvide[] => {
  const { manifest, recorded, services, index } = input;
  const declared = new Map<string, string>();

  for (const entry of manifest.provides) {
    const parsed = parseContractEntry(entry);

    if (parsed !== undefined && !declared.has(parsed.id)) {
      declared.set(parsed.id, parsed.spec);
    }
  }

  const answered = new Set(
    recorded
      .filter(
        ({ id, environment }) =>
          environment === 'host' ||
          (environment === 'desktopMain' && !inHostAndDesktopMain(id)),
      )
      .map(({ id }) => id),
  );
  const provides: HostProvide[] = [];

  for (const entry of services) {
    const descriptor = index.registry
      .getFile(entry.protoFile)
      ?.services.find((candidate) => candidate.name === entry.service);
    const info =
      descriptor === undefined ? undefined : index.service(descriptor.typeName);

    if (
      info === undefined ||
      info.role !== 'contract' ||
      !isHostContract(info.contract) ||
      answered.has(info.contract.id)
    ) {
      continue;
    }

    answered.add(info.contract.id);
    provides.push({
      id: info.contract.id,
      kind: 'service',
      cardinality: info.contract.cardinality,
      source: entry.location,
      declared: declared.get(info.contract.id),
    });
  }

  for (const [id, version] of declared) {
    const contract = index.contract(id);

    if (
      contract === undefined ||
      !isHostContract(contract) ||
      answered.has(id) ||
      hasContractService(contract, index)
    ) {
      continue;
    }

    const kind = protoKind(contract);

    if (kind === undefined) {
      continue;
    }

    provides.push({
      id,
      kind,
      cardinality: contract.cardinality,
      source: contract.file.proto.name,
      declared: version,
    });
  }

  return provides;
};

/**
 * What a native host part provides (spec §14, A30): it has no recording and
 * no static `services` list, so its manifest's `provides` says it all.
 *
 * Answers, in the order of `manifest.provides` and without duplicates (first
 * occurrence wins), each listed id that `index` knows as a `HOST` contract
 * whose file declares a contract-role service: `kind: 'service'`, the
 * contract's cardinality in its `.proto`, `source` the `.proto` file name
 * (`doric/storage/kv/v1/kv.proto`) and `declared` the listed version. Leaves
 * out every other id (unknown to `index`, of another environment, or whose
 * file declares no contract-role service), so `checkRecording` reports it as
 * provided by no part. A `provides` entry that does not parse is skipped.
 *
 * Pure and deterministic; never throws.
 */
export const nativeProvides = (input: {
  readonly manifest: Manifest;
  readonly index: CatalogIndex;
}): readonly HostProvide[] => {
  const { manifest, index } = input;
  const answered = new Set<string>();
  const provides: HostProvide[] = [];

  for (const entry of manifest.provides) {
    const parsed = parseContractEntry(entry);

    if (parsed === undefined || answered.has(parsed.id)) {
      continue;
    }

    answered.add(parsed.id);
    const contract = index.contract(parsed.id);

    if (
      contract === undefined ||
      contract.environment !== 'HOST' ||
      !hasContractService(contract, index)
    ) {
      continue;
    }

    provides.push({
      id: parsed.id,
      kind: 'service',
      cardinality: contract.cardinality,
      source: contract.file.proto.name,
      declared: parsed.spec,
    });
  }

  return provides;
};

/** Whether `id` is a basic contract the fixed table puts in `host` and `desktopMain`. */
const inHostAndDesktopMain = (id: string): boolean => {
  const environments = basicContractSpec(id)?.environments ?? [];

  return environments.includes('host') && environments.includes('desktopMain');
};

const isHostContract = (contract: ContractInfo): boolean =>
  contract.environment === 'HOST' || contract.environment === 'HOOKS';

/** Whether `contract`'s file declares a contract-role service. */
const hasContractService = (
  contract: ContractInfo,
  index: CatalogIndex,
): boolean =>
  contract.file.services.some(
    (service) => index.service(service.typeName)?.role === 'contract',
  );

/**
 * The kind of a contract no service serves: `hooks` for a hooks file, else
 * by the first message of its file that carries the option `event`,
 * `settings` or `storage_type`; `undefined` when none does.
 */
const protoKind = (contract: ContractInfo): HostProvide['kind'] | undefined => {
  if (contract.environment === 'HOOKS') {
    return 'hooks';
  }

  for (const message of contract.file.messages) {
    if (hasOption(message, eventOption)) {
      return 'event';
    }

    if (hasOption(message, settingsOption)) {
      return 'settings';
    }

    if (hasOption(message, storageTypeOption)) {
      return 'storage-type';
    }
  }

  return undefined;
};
