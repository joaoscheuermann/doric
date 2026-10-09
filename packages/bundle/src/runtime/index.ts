// Internal browser-safe runtime shared by the host loader, the desktopMain
// process and the client windows. Bundles never import it.

export {
  ActivationFailure,
  type ActivationOptions,
  type ActivationResult,
  activateEnvironment,
  catalogView,
  type PlatformLog,
  principalOptionsFor,
} from './activation.js';
export {
  anySignal,
  type CallFactoryInput,
  createHopCall,
  deadlineOf,
  generationOf,
} from './call.js';
export {
  type CatalogCandidate,
  type CatalogEntry,
  type CatalogSource,
  type EntryState,
  type ResolvedContract,
  type ResolvedEnvironment,
  type ResolvedProvider,
  type ResolveInput,
  resolveEnvironment,
} from './catalog.js';
export {
  type Composition,
  compositionSchema,
  parseComposition,
} from './composition.js';
export {
  type Descriptor,
  type DescriptorEntry,
  type DescriptorKind,
  descriptorEntrySchema,
  descriptorKinds,
  descriptorSchema,
  emptyDescriptor,
  parseDescriptor,
} from './descriptor.js';
export {
  DIAGNOSTIC_ERRORS_PER_BUNDLE,
  DiagnosticsStore,
} from './diagnostics.js';
export {
  type Directory,
  type ProviderListener,
  type ProviderRecord,
  ServiceDirectory,
} from './directory.js';
export {
  createStub,
  type DispatchTarget,
  dispatch,
  isRegistrationConflict,
  isTupleSchema,
  normalizeArguments,
} from './dispatch.js';
export { createHooksFacade } from './facades.js';
export {
  type ContractDocument,
  canonicalJson,
  contractDocument,
  JSON_SCHEMA_DIALECT,
  jsonEqual,
  LOCAL_KEY,
  type LocalCodecKind,
  localCodecKinds,
  localMarker,
  type MemberSchema,
  memberSchema,
  type RecordedContract,
  type SchemaDirection,
  schemaPath,
} from './json-schema.js';
export { LayeredDirectory } from './layered-directory.js';
export {
  type ContractEntry,
  convertV0,
  type LegacyResource,
  type ManifestV0,
  type ManifestV1,
  type ManifestV1Input,
  manifestV0Schema,
  manifestV1Schema,
  parseContractEntry,
  parseManifest,
  type ReadManifest,
  semverRange,
  semverString,
  v0BundleId,
} from './manifest.js';
export {
  type ContractCatalogView,
  type DeclaredProvide,
  emptyCatalogView,
  Principal,
  type PrincipalOptions,
  type ServiceRuntime,
} from './principal.js';
export {
  DisposalScope,
  inertDisposable,
  toDisposable,
} from './scope.js';
export {
  bump,
  type ChangeLevel,
  compare,
  compareVersions,
  formatVersion,
  isRange,
  isVersion,
  parseVersion,
  rangeMajor,
  type SemVer,
  satisfies,
} from './semver.js';
export { createPrincipal } from './services.js';
export { childTrace, newTrace, traceIdOf } from './trace.js';
export { PLATFORM_VERSION } from './version.js';
