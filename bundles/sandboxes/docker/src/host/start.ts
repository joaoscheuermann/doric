import {
  type HandlerRegistration,
  type HookHandlers,
  type HostContext,
  onHostStart,
} from 'bundle/host';

import { dockerSandboxSettings, type Environment } from './sandbox.js';

/**
 * Registers this instance's `onHostStartHook` handler (`onHostStart(hooks, context, step)`), with the settings read now
 * from `environment` (`dockerSandboxSettings` / `firecrackerSandboxSettings`; a malformed `DORIC_SANDBOX_*` value
 * throws here, as the binding does). The step, under the run's call:
 * `stage('sandbox_pool')`; `log('info', 'Configuring sandbox pool', { sandboxProviderName })`;
 * `log('info', 'Sandbox pool configured', { sandboxProviderName, sandboxImage, sandboxResources, minIdle,
 * maxSandboxes, maxCreateAttempts, networkMode: 'egress', sshEnabled[, dockerSocketShared] })`,
 * `dockerSocketShared` for `docker` only. A startup call's rejection fails the handler, so
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
