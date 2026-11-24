import {
  AppHooksV1,
  type Disposable,
  DoricStartupV1,
  HooksV1,
  type Services,
} from 'bundle/contracts';
import {
  type HandlerRegistration,
  type HookHandlers,
  type HostContext,
  onHostStart,
} from 'bundle/host';

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

/**
 * Registers this instance's `onHostStartHook` handler (`onHostStart(hooks, context, step)`), with the settings read now
 * from `environment` (`dockerSandboxSettings` / `firecrackerSandboxSettings`; a malformed `DORIC_SANDBOX_*` value
 * throws here, as the binding does). The step, under the run's call:
 * `stage('sandbox_pool')`; `log('info', 'Configuring sandbox pool', { sandboxProviderName })`;
 * `log('info', 'Sandbox pool configured', { sandboxProviderName, sandboxImage, sandboxResources, minIdle,
 * maxSandboxes, maxCreateAttempts, networkMode: 'egress', sshEnabled[, dockerSocketShared] })` — the fields
 * `logSandboxPool` logs today, `dockerSocketShared` for `docker` only. A startup call's rejection fails the handler, so
 * the run and the host's start. Resolves and rejects as `onHostStart` (`hooks/v1.Register`'s error).
 */
export const registerSandboxPoolStep = (
  hooks: HookHandlers,
  context: Pick<HostContext, 'registrations' | 'services'>,
  environment: Environment,
): Promise<HandlerRegistration> => {
  const settings = dockerSandboxSettings(environment);

  return onHostStart(hooks, context, async (startup) => {
    await startup.stage('sandbox_pool');
    await startup.log('info', 'Configuring sandbox pool', {
      sandboxProviderName: 'docker',
    });
    await startup.log('info', 'Sandbox pool configured', {
      sandboxProviderName: 'docker',
      sandboxImage: settings.image,
      sandboxResources: settings.resources,
      ...settings.limits,
      networkMode: 'egress',
      sshEnabled: settings.ssh,
      dockerSocketShared: settings.dockerSocket,
    });
  });
};
