// The client SDK (spec `docs/designs/grpc-processes.md`, section 10): what a
// client part imports from `bundle/client`. Browser-safe.

export { maxMessageBytes } from '../../contracts/metadata.js';
export { fromConnectError } from '../../contracts/status.js';
export {
  type ResumeRequests,
  reopenResumable,
  resumableDelays,
} from '../../runtime/resumable.js';
export {
  type ClientPart,
  type ClientUseOptions,
  createClientPart,
} from './client.js';
export {
  type ClientPartTransportOptions,
  createClientPartTransport,
} from './transport.js';
