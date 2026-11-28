// The basic `HOST` contracts as a fallback of a staged catalog index (S62d3,
// contracts `s62d.md` §2.7; spec revision 6.31, the `withBasicContracts` open
// item).

import { createFileRegistry, type DescFile } from '@bufbuild/protobuf';
// Through the package's own path, as the generated files import one another:
// `storage.backend/v1` imports `storage/v1` so, and a relative import would
// load a second `storage/v1` file of the same name.
import { file_doric_events_v1_events } from 'bundle/contracts/gen/doric/events/v1/events_pb.js';
import { file_doric_hooks_v1_hooks } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { file_doric_log_v1_log } from 'bundle/contracts/gen/doric/log/v1/log_pb.js';
import { file_doric_models_provider_v1_provider } from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import { file_doric_models_v1_models } from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import { file_doric_secrets_backend_v1_backend } from 'bundle/contracts/gen/doric/secrets/backend/v1/backend_pb.js';
import { file_doric_secrets_v1_secrets } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { file_doric_settings_v1_settings } from 'bundle/contracts/gen/doric/settings/v1/settings_pb.js';
import { file_doric_skills_v1_skills } from 'bundle/contracts/gen/doric/skills/v1/skills_pb.js';
import { file_doric_storage_backend_v1_backend } from 'bundle/contracts/gen/doric/storage/backend/v1/backend_pb.js';
import { file_doric_storage_kv_v1_kv } from 'bundle/contracts/gen/doric/storage/kv/v1/kv_pb.js';
import { file_doric_storage_v1_storage } from 'bundle/contracts/gen/doric/storage/v1/storage_pb.js';
import { file_doric_storage_v2_storage } from 'bundle/contracts/gen/doric/storage/v2/storage_pb.js';
import { file_doric_tools_v1_tools } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';

import { type CatalogIndex, createCatalogIndex } from './catalog-index.js';

/**
 * The descriptor files of the basic `HOST` contracts `packages/bundle`
 * defines: one file per id of `basicContracts` whose environments include
 * `host` (14 today: `hooks/v1`, `log/v1`, `tools/v1`, `skills/v1`,
 * `settings/v1`, `secrets/v1`, `secrets.backend/v1`, `storage/v1`,
 * `storage.backend/v1`, `storage.kv/v1`, `storage/v2`, `events/v1`,
 * `models/v1`, `models.provider/v1`), in that order. No bundle's
 * `descriptors.binpb` holds the ones its own files do not import, though
 * bundles provide them. Frozen.
 */
export const basicHostContractFiles: readonly DescFile[] = Object.freeze([
  file_doric_hooks_v1_hooks,
  file_doric_log_v1_log,
  file_doric_tools_v1_tools,
  file_doric_skills_v1_skills,
  file_doric_settings_v1_settings,
  file_doric_secrets_v1_secrets,
  file_doric_secrets_backend_v1_backend,
  file_doric_storage_v1_storage,
  file_doric_storage_backend_v1_backend,
  file_doric_storage_kv_v1_kv,
  file_doric_storage_v2_storage,
  file_doric_events_v1_events,
  file_doric_models_v1_models,
  file_doric_models_provider_v1_provider,
]);

/**
 * `index`, falling back to {@link basicHostContractFiles} for what it lacks;
 * a file of `index` wins where both hold one:
 * - `method`, `service`, `contract`: `index`'s answer, else the basic one;
 * - `desktopMethods()`: `index`'s, then the basic methods exposed to
 *   `DESKTOP` whose path `index` lacks; the same array on every call;
 * - `publicMethods()`: `index`'s (no basic contract is `api.*`);
 * - `registry`: the basic files and `index`'s, `index`'s winning a name.
 * Throws the `TypeError` of `createCatalogIndex` only if the basic files
 * themselves break a rule of the index (never for the shipped files). Pure.
 */
export const withBasicContracts = (index: CatalogIndex): CatalogIndex => {
  const basic = createCatalogIndex(basicHostContractFiles);
  const desktop = [
    ...index.desktopMethods(),
    ...basic
      .desktopMethods()
      .filter(({ path }) => index.method(path) === undefined),
  ];

  return {
    method: (path) => index.method(path) ?? basic.method(path),
    service: (fullName) => index.service(fullName) ?? basic.service(fullName),
    contract: (id) => index.contract(id) ?? basic.contract(id),
    desktopMethods: () => desktop,
    // No basic contract is part of the public API (`api.*`).
    publicMethods: () => index.publicMethods(),
    registry: createFileRegistry(basic.registry, index.registry),
  };
};
