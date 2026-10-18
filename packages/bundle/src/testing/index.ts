import type { Call, CallScope } from '../contracts/call.js';
import type { Services } from '../contracts/context.js';
import type { AnyServiceDefinition } from '../contracts/define.js';
import type { DiagnosticReport } from '../contracts/platform.js';
import { createHopCall } from '../runtime/call.js';
import { ServiceDirectory } from '../runtime/directory.js';
import { emptyCatalogView, type ServiceRuntime } from '../runtime/principal.js';
import { createPrincipal } from '../runtime/services.js';

export interface TestServices {
  /** Services of the bundle under test; requires enforcement is disabled. */
  readonly services: Services;
  /** A hop Call into the bundle under test (caller `test`). */
  call(scope?: CallScope, signal?: AbortSignal): Call;
  /** Failures the runtime reported (handler failures, disposal errors). */
  readonly reports: readonly DiagnosticReport[];
  dispose(): Promise<void>;
}

export interface TestServicesOptions {
  readonly bundle: { readonly id: string; readonly version?: string };
  /** Service definitions provided by a fake `test-provider` bundle. */
  readonly provide?: readonly AnyServiceDefinition[];
}

/** In-process services for bundle unit tests, without a catalog or loader. */
export const createTestServices = (
  options: TestServicesOptions,
): TestServices => {
  const controller = new AbortController();
  const reports: DiagnosticReport[] = [];
  const runtime: ServiceRuntime = {
    directory: new ServiceDirectory(),
    catalog: emptyCatalogView,
    environment: 'host',
    generation: 1,
    generationSignal: controller.signal,
    report: (entry) => {
      reports.push(entry);
    },
  };
  const provider = createPrincipal(runtime, {
    bundleId: 'test-provider',
    version: '0.0.0',
    provides: 'any',
    requires: 'any',
  });

  for (const definition of options.provide ?? []) {
    provider.services.provide(definition);
  }

  const principal = createPrincipal(runtime, {
    bundleId: options.bundle.id,
    version: options.bundle.version ?? '0.0.0',
    provides: 'any',
    requires: 'any',
  });

  return {
    services: principal.services,
    call: (scope, signal) =>
      createHopCall({
        caller: { bundleId: 'test', version: '0.0.0', generation: 1 },
        ...(scope === undefined ? {} : { useScope: scope }),
        ...(signal === undefined ? {} : { arg: { signal } }),
        generationSignal: controller.signal,
      }),
    reports,
    dispose: async () => {
      await principal.scope.dispose();
      principal.close();
      await provider.scope.dispose();
      provider.close();
      controller.abort();
    },
  };
};

export {
  createMinimalHooks,
  type MinimalHooksOptions,
} from './minimal-hooks.js';
export {
  MINIMAL_CORE_TEXT,
  type MinimalUiCore,
  minimalUiCore,
} from './minimal-ui-core.js';
