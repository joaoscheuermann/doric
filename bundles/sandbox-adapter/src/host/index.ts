import { activateSandboxAdapter } from './adapter.js';

/**
 * Provides `sandbox/v1` over the Docker (default) or Firecracker sandbox
 * pool configured from `DORIC_SANDBOX_*`; deactivation disposes the pool.
 */
export const activate = activateSandboxAdapter();
