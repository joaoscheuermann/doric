import {
  AppHooksV1,
  type Disposable,
  DoricStartupV1,
  HooksV1,
  type Services,
} from 'bundle/contracts';

import { dockerSandboxSettings, type Environment } from './sandbox.js';

/**
 * The start step of the `docker` sandbox pool (M3): the stage `sandbox_pool`,
 * then the pool's settings as the host logged them before the bundle move.
 * The pool itself is built at activation; these lines describe it.
 */
export const logSandboxPool = (
  services: Pick<Services, 'use'>,
  environment: Environment,
): Disposable => {
  const settings = dockerSandboxSettings(environment);

  return services
    .use(HooksV1)
    .use(AppHooksV1)
    .onHostStartHook(async (_input, call) => {
      const startup = services.use(DoricStartupV1);

      await startup.stage('sandbox_pool');
      await startup.log(
        {
          level: 'info',
          fields: { sandboxProviderName: 'docker' },
          message: 'Configuring sandbox pool',
        },
        call,
      );
      await startup.log(
        {
          level: 'info',
          fields: {
            sandboxProviderName: 'docker',
            sandboxImage: settings.image,
            sandboxResources: settings.resources,
            ...settings.limits,
            networkMode: 'egress',
            sshEnabled: settings.ssh,
            dockerSocketShared: settings.dockerSocket,
          },
          message: 'Sandbox pool configured',
        },
        call,
      );
    });
};
