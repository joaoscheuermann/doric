import { activateDockerSandbox } from './sandbox.js';

/**
 * Provides `sandbox/v1` over a Docker sandbox pool configured from the
 * `DORIC_SANDBOX_*` environment; deactivation disposes the pool.
 */
export const activate = activateDockerSandbox();
