// Node entry: loader, catalog, build tooling and testing helpers.

export {
  BuildError,
  type BuildResult,
  buildBundle,
  runCli,
  stageBundles,
  writeBaseline,
} from './build/cli.js';
export {
  type Baseline,
  baselineSchema,
  type CompareInput,
  type CompareResult,
  compareWithBaseline,
  documentChange,
  memberChange,
} from './build/compare.js';
export {
  platformSchemaDocuments,
  writePlatformSchemas,
} from './build/platform-schemas.js';
export {
  checkRecording,
  RecordingError,
  recordActivation,
} from './build/record.js';
export {
  type ContractDocument,
  contractDocument,
  type RecordedContract,
  schemaPath,
} from './build/schemas.js';
export type {
  SkillRecord,
  SkillRecord as Skill,
  SkillSchemaInput,
} from './contracts/skill.js';
export { SkillSchema } from './contracts/skill.js';
export {
  type HostPlatform,
  type PlatformCallOptions,
  type StartHostOptions,
  startHost,
} from './loader/activate.js';
export {
  type BuildCatalogInput,
  buildCatalog,
  type EmbeddedBundle,
} from './loader/catalog.js';
export {
  discoverBundles,
  type InstalledBundle,
  readInstalledBundle,
} from './loader/discover.js';
export type { LogSink, PlatformLog } from './loader/log.js';
export { catalogSnapshot } from './loader/platform.js';
export {
  CompositionError,
  readComposition,
  readDescriptor,
  readManifest,
} from './loader/read.js';
export {
  discoverSkills,
  type ParsedSkill,
  parseSkillDocument,
  readSkill,
} from './loader/skills.js';
export { ajvValidators } from './process/ajv.js';
export {
  defaultRunnerPath,
  type ExecutionRef,
  forkGeneration,
  type GenerationLease,
  type GenerationManager,
  type GenerationSummary,
  type KernelPlatform,
  type LostGeneration,
  type PublishResult,
  type SpawnedGeneration,
  type StartKernelOptions,
  startKernel,
} from './process/kernel.js';
export { childTransport, parentTransport } from './process/node-transport.js';
export {
  type HostPartition,
  isKernelResident,
  kernelSignature,
  partitionCatalog,
} from './process/partition.js';
export type {
  CatalogEntry,
  Composition,
  Descriptor,
  DescriptorEntry,
  ManifestV0,
  ManifestV1,
  ReadManifest,
  ResolvedEnvironment,
} from './runtime/index.js';
export {
  compositionSchema,
  convertV0,
  descriptorSchema,
  manifestV0Schema,
  manifestV1Schema,
  PLATFORM_VERSION,
  resolveEnvironment,
} from './runtime/index.js';
export {
  AnnouncingDirectory,
  type GenerationInit,
  generationInitSchema,
  type RunnerOptions,
  runGeneration,
  type SerializedCatalogEntry,
} from './runtime/runner.js';
export {
  createTestServices,
  type TestServices,
  type TestServicesOptions,
} from './testing/index.js';
