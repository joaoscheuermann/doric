/*
 * The seams the kernel's integration harness and this bundle's tests drive: the
 * configuration schema and its defaults, the configuration store and service,
 * and the credential service over `secrets/v1`. None of them is a host entry.
 */
export {
  type ConfigInput,
  ConfigInputSchema,
  type DoricConfig,
  defaultConfig,
  providerCredentials,
} from './host/config/schema.js';
export {
  type ConfigService,
  createConfigService,
} from './host/config/service.js';
export { type ConfigStore, createConfigStore } from './host/config/store.js';
export { type Credential, publicCredential } from './host/credentials/kind.js';
export {
  credentialById,
  credentialByKind,
} from './host/credentials/resolve.js';
export {
  type CredentialService,
  createCredentialService,
  MissingKeyError,
} from './host/credentials/service.js';
