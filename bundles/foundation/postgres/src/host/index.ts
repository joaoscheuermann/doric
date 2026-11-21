import { activatePostgres } from './postgres.js';

/**
 * Provides `storage.backend/v1` and `secrets.backend/v1`. Activation performs
 * no I/O: the client is created and connected on first use from
 * `DORIC_DATABASE_URL`, and the deactivation cleanup disconnects it.
 */
export const activate = activatePostgres();
