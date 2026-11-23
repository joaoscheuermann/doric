// The host SDK (spec `docs/designs/grpc-processes.md`, section 10): what a
// host part's `main.ts` imports from `bundle`.

export {
  type ResumeRequests,
  reopenResumable,
  resumableDelays,
} from '../../runtime/resumable.js';
export type { HostAssets } from './assets.js';
export type {
  BundleInstance,
  GenerationChangedEvent,
  HostContext,
  HostGenerations,
  HostInstances,
  HostRegistrations,
  HostServices,
  LiveGeneration,
  PeerSignalEvent,
  TrackedRegistration,
  TrackOptions,
  UseOptions,
} from './context.js';
export {
  EXIT_HOST_GONE,
  EXIT_STOPPED,
  HostGoneError,
  type HostGoneReason,
} from './control.js';
export {
  type RegistrationConflictCode,
  type RegistrationEntry,
  RegistrationTable,
  type RegistrationTableOptions,
  type StampedCaller,
  stampedCallerOf,
} from './registrations.js';
export {
  type BundleDefinition,
  type RunningBundle,
  runBundle,
  type ServiceEntries,
  type ServiceEntry,
  type StartBundleOptions,
  startBundle,
} from './run.js';
