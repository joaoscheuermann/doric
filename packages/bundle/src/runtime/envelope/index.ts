// The RPC envelope between the kernel and a generation process. Browser-safe:
// the host child, the desktop processes and the bridge share it; the Node and
// Electron transports and the ajv validators live outside this folder.

export { type RestoreOptions, restoreCall, toWireCall } from './call-meta.js';
export {
  createErrorClassRegistry,
  decodeError,
  type ErrorClassRegistry,
  encodeError,
} from './errors.js';
export {
  type LinkCloseReason,
  ProcessLink,
  type ProcessLinkOptions,
  type ResolveTarget,
  type Transport,
} from './link.js';
export { createTransportPair, type TransportPair } from './memory.js';
export {
  type AppLifecycleHook,
  appLifecycleHooks,
  type CallMessage,
  type CancelMessage,
  type ControlMessage,
  controlKinds,
  type EndMessage,
  type EnvelopeMessage,
  type EventMessage,
  type InvokeMessage,
  isControlMessage,
  type ReleaseMessage,
  type RemoteProviderDescriptor,
  type ResultMessage,
  remoteProviderDescriptorSchema,
  type SubscribeMessage,
  type UnsubscribeMessage,
  type WireCall,
  type WireError,
  type WireMessage,
  type WireOwnProperty,
  type WireThrown,
  type WireThrownError,
  wireErrorSchema,
  wireMessageSchema,
} from './messages.js';
export {
  announcedKey,
  describeRecord,
  matchesTarget,
  recordKey,
  registerRemote,
  remoteRecord,
} from './remote.js';
export {
  documentMethodSpecs,
  memberSpec,
  type SchemaCheck,
  type SchemaIssue,
  type SchemaValidators,
  validatorSchema,
} from './validators.js';
export {
  type CallbackMode,
  type CodecContext,
  type CodecHost,
  decodeValue,
  documentPlan,
  type ExportTarget,
  encodeValue,
  fixedPlan,
  type LocalKind,
  type MethodPlan,
  planFor,
  RemoteTool,
  type RemoteToolCallView,
  WIRE_KEY,
  type WireValue,
} from './values.js';
