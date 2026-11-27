import type { Configuration } from 'runtime/contracts';

import type { ApiAnswer, RouteInput } from '../answer.js';
import { ok, refused } from '../input.js';
import type { TransportPorts } from '../ports.js';

type Op<V> = (input: RouteInput) => Promise<ApiAnswer<V>>;

/** The Doric configuration as `GET /config` answers it. */
export type DoricConfigurationView = Awaited<
  ReturnType<Configuration['current']>
>;

/**
 * The `/config` route bodies over the ports. The configuration holds no secret
 * of its own: it names credentials by id, so what it answers is what it
 * accepts. `host-config/v1` validates the body (the schema needs the provider
 * kind catalog), and answers an invalid one with the message the route sent
 * before.
 */
export const configOperations = ({
  configuration,
}: Pick<TransportPorts, 'configuration'>): {
  /** `GET /config`. */
  readonly current: Op<DoricConfigurationView>;
  /** `PUT /config` (body = the configuration). */
  readonly replace: Op<DoricConfigurationView>;
} => ({
  current: async () => ok(await configuration.current()),
  replace: async ({ body }) => {
    try {
      const result = await configuration.replace(body);

      if (result.status === 'replaced') return ok(result.config);

      if (result.status === 'invalid') {
        return refused({
          status: 422,
          code: 'invalid_config',
          message: result.message,
        });
      }
    } catch {
      // Any other failure of the replacement is the activation's, as before.
    }

    return refused({
      status: 503,
      code: 'configuration_rejected',
      message: 'The Doric configuration could not be activated.',
    });
  },
});
