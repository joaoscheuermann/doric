// Public contracts of the `core` bundle. They are typed references only; the
// definitions live in the core's parts. The model catalog fill is the one
// helper: the host configuration runs it over `models/v1.catalog`.

export {
  type CatalogReader,
  executionProfile,
  type FillConfiguration,
  type FillModel,
  type FillProvider,
  readModelProperties,
} from '../host/models/catalog.js';
export {
  type CoreCommands,
  CoreCommandsV1,
  coreCommandsExecuteInput,
  coreCommandsMethods,
  OpenSettingsCommandV1,
  openSettingsInput,
} from './commands.js';
export { CoreHooksV1, onBeforeOpenWindowHook } from './hooks.js';
export {
  settingsGenerationId,
  settingsGenerationType,
  settingsType,
} from './storage.js';
