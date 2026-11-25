// A host resolution for the tests of calls between bundles (spec
// `docs/designs/grpc-processes.md`, section 3, steps 3 and 4): bundles that
// provide, require, list under `optional` and declare nothing, with real
// contracts of `src/contracts/gen`, resolved by the real catalog.

import {
  type CatalogCandidate,
  type ManifestV2Input,
  manifestV1Schema,
  manifestV2Schema,
  type ResolvedEnvironment,
  resolveEnvironment,
} from '../../src/runtime/index.js';
import { type ContractShape, descriptorFor, manifest } from './fixtures.js';

/** The lists of a version 2 manifest. */
interface BundleLists {
  readonly provides?: readonly string[];
  readonly host?: {
    readonly requires?: readonly string[];
    readonly optional?: readonly string[];
  };
  readonly client?: {
    readonly requires?: readonly string[];
    readonly optional?: readonly string[];
  };
}

const many: Readonly<Record<string, ContractShape>> = {
  'models.provider/v1': { cardinality: 'many' },
};

const candidateV1 = (
  id: string,
  provides: readonly string[],
): CatalogCandidate => {
  const source = manifest(id, { provides });

  return {
    id,
    source: { kind: 'installed', dir: `/bundles/${id}` },
    manifest: manifestV1Schema.parse(source),
    descriptor: descriptorFor(source),
    errors: [],
  };
};

const candidateV2 = (id: string, lists: BundleLists): CatalogCandidate => {
  const provides = [...(lists.provides ?? [])];
  const source: ManifestV2Input = {
    manifestVersion: 2,
    id,
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
    provides,
    host: {
      requires: [...(lists.host?.requires ?? [])],
      optional: [...(lists.host?.optional ?? [])],
    },
    client: {
      requires: [...(lists.client?.requires ?? [])],
      optional: [...(lists.client?.optional ?? [])],
    },
  };

  return {
    id,
    source: { kind: 'installed', dir: `/bundles/${id}` },
    manifest: manifestV2Schema.parse(source),
    descriptor: descriptorFor(manifest(id, { provides }), many),
    errors: [],
  };
};

/**
 * The host resolution every call test routes with:
 *
 * - `core` (manifest v1): provides `hooks/v1`, `tools/v1`, `skills/v1`;
 * - `settings`: provides `settings/v1` (`one`); its host part lists
 *   `models.provider/v1` under `optional`;
 * - `alpha` and `beta`: provide `models.provider/v1` (`many`), in that order;
 * - `app`: its host part requires `settings/v1` and lists
 *   `models.provider/v1` and `events/v1` (provided by nobody) under
 *   `optional`; its client part requires `tools/v1`;
 * - `web`: only its client part requires `settings/v1`;
 * - `stranger`: declares nothing;
 * - `broken`: requires `missing/v1`, which nobody provides: quarantined.
 */
export const resolveCallHost = (): ResolvedEnvironment => {
  const candidates = [
    candidateV1('core', [
      'hooks/v1@1.0.0',
      'tools/v1@1.0.0',
      'skills/v1@1.0.0',
    ]),
    candidateV2('settings', {
      provides: ['settings/v1@1.0.0'],
      host: { optional: ['models.provider/v1'] },
    }),
    candidateV2('alpha', { provides: ['models.provider/v1@1.0.0'] }),
    candidateV2('beta', { provides: ['models.provider/v1@1.0.0'] }),
    candidateV2('app', {
      host: {
        requires: ['settings/v1@^1.0.0'],
        optional: ['models.provider/v1', 'events/v1'],
      },
      client: { requires: ['tools/v1@^1.0.0'] },
    }),
    candidateV2('web', { client: { requires: ['settings/v1@^1.0.0'] } }),
    candidateV2('stranger', {}),
    candidateV2('broken', { host: { requires: ['missing/v1@^1.0.0'] } }),
  ];

  return resolveCandidates(candidates);
};

/**
 * The host resolution of the registration replay tests (section 4, "When a
 * provider changes"):
 *
 * - `core` (manifest v1): provides `hooks/v1`, `tools/v1`, `skills/v1`;
 * - `app`, `other` and `idle`: their host part requires `tools/v1`;
 * - `silent`: its host part lists `tools/v1` under `optional`;
 *
 * so each of the four is a consumer `ProviderChanged` reaches.
 */
export const resolveReplayHost = (): ResolvedEnvironment =>
  resolveCandidates([
    candidateV1('core', [
      'hooks/v1@1.0.0',
      'tools/v1@1.0.0',
      'skills/v1@1.0.0',
    ]),
    ...['app', 'other', 'idle'].map((id) =>
      candidateV2(id, { host: { requires: ['tools/v1@^1.0.0'] } }),
    ),
    candidateV2('silent', { host: { optional: ['tools/v1'] } }),
  ]);

/**
 * The host resolution of the snapshot size test (section 3, "Size", item 2):
 *
 * - `core` (manifest v1): provides `hooks/v1`, `tools/v1`, `skills/v1`;
 * - `threads`: provides `fixture.threads/v1` (`one`), the run-time contract
 *   of `watch-thread-contract.ts`;
 * - `app`: its host part requires `fixture.threads/v1`.
 */
export const resolveSnapshotHost = (): ResolvedEnvironment =>
  resolveCandidates([
    candidateV1('core', [
      'hooks/v1@1.0.0',
      'tools/v1@1.0.0',
      'skills/v1@1.0.0',
    ]),
    candidateV2('threads', { provides: ['fixture.threads/v1@1.0.0'] }),
    candidateV2('app', {
      host: { requires: ['fixture.threads/v1@^1.0.0'] },
    }),
  ]);

/**
 * The host resolution of the log queue tests (A7, slice S42):
 *
 * - `core` (manifest v1): provides `log/v1` and `secrets/v1`;
 * - `app`: provides `settings/v1`; its host part lists `log/v1` and
 *   `secrets/v1` under `optional`;
 * - `caller`: its host part requires `settings/v1`;
 * - `stranger`: declares nothing.
 */
export const resolveLogHost = (): ResolvedEnvironment =>
  resolveCandidates([
    candidateV1('core', ['log/v1@1.0.0', 'secrets/v1@1.2.0']),
    candidateV2('app', {
      provides: ['settings/v1@1.0.0'],
      host: { optional: ['log/v1', 'secrets/v1'] },
    }),
    candidateV2('caller', { host: { requires: ['settings/v1@^1.0.0'] } }),
    candidateV2('stranger', {}),
  ]);

/**
 * The host resolution of the SDK's own skill registration (S62d3 addendum 2,
 * SK-2):
 *
 * - `core` (manifest v1): provides `hooks/v1`, `tools/v1`, `skills/v1@1.3.0`;
 * - `app` and `other`: their host part requires `skills/v1@^1.3.0`, so
 *   `ProviderChanged` for `skills/v1` reaches them.
 */
export const resolveSkillsHost = (): ResolvedEnvironment =>
  resolveCandidates([
    candidateV1('core', [
      'hooks/v1@1.0.0',
      'tools/v1@1.0.0',
      'skills/v1@1.3.0',
    ]),
    ...['app', 'other'].map((id) =>
      candidateV2(id, { host: { requires: ['skills/v1@^1.3.0'] } }),
    ),
  ]);

const resolveCandidates = (
  candidates: readonly CatalogCandidate[],
): ResolvedEnvironment =>
  resolveEnvironment(
    {
      candidates: [...candidates],
      composition: {
        core: 'core',
        enabled: candidates.map(({ id }) => id),
        providers: {},
      },
      platformVersion: '1.0.0',
      generation: 1,
    },
    'host',
  );
