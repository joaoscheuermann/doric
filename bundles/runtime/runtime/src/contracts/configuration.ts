/*
 * host-config/v1 moved to its owner, the `host-config` bundle. The value types
 * stay importable from here as types only, so a consumer that names a
 * configuration keeps compiling; the ref and its methods come from
 * `host-config/contracts`.
 */
export type {
  ConfigReplaceResult,
  Configuration,
  ConfigurationModel,
  ConfigurationProvider,
  ConfigurationValue,
  DoricConfiguration,
} from 'host-config/contracts';
