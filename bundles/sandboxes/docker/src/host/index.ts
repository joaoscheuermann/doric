import { activateDockerSandbox } from './sandbox.js';

/**
 * Provides `sandbox/v1` over a Docker sandbox pool configured from
 * `DORIC_SANDBOX_IMAGE` and `DORIC_SANDBOX_SSH`; deactivation disposes the
 * pool.
 */
export const activate = activateDockerSandbox();
