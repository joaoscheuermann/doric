// Two "processes" joined by the in-memory envelope transport: a kernel side
// and a generation side, each with its own directory, runtime and principals.
// Only the process boundary is simulated (structured clone, async delivery).

import { Ajv2020 } from 'ajv/dist/2020.js';

import { definePlatformService } from '../../src/contracts/define.js';
import {
  type AnyServiceDefinition,
  type CatalogSnapshot,
  type DiagnosticReport,
  DoricCatalogV1,
  DoricDiagnosticsV1,
  defineMethod,
  type JsonObject,
} from '../../src/contracts/index.js';
import { platformContracts } from '../../src/contracts/platform.js';
import {
  createErrorClassRegistry,
  createTransportPair,
  describeRecord,
  type ErrorClassRegistry,
  ProcessLink,
  registerRemote,
  type SchemaValidators,
  type Transport,
  type TransportPair,
  type WireMessage,
} from '../../src/runtime/envelope/index.js';
import {
  createPrincipal,
  emptyCatalogView,
  type Principal,
  ServiceDirectory,
  type ServiceRuntime,
} from '../../src/runtime/index.js';

/** JSON Schema 2020-12 validation as the host process does it (ajv). */
export const ajvValidators = (): SchemaValidators => {
  const ajv = new Ajv2020({
    strict: false,
    validateFormats: false,
    allErrors: false,
  });
  const cache = new Map<string, ReturnType<typeof ajv.compile>>();

  return {
    compile: (schema: JsonObject) => {
      const key = JSON.stringify(schema);
      let validate = cache.get(key);

      if (validate === undefined) {
        validate = ajv.compile(schema);
        cache.set(key, validate);
      }

      const compiled = validate;

      return (value) =>
        compiled(value)
          ? []
          : (compiled.errors ?? []).map((error) => ({
              path: error.instancePath
                .split('/')
                .slice(1)
                .map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
              message: error.message ?? 'is invalid',
            }));
    },
  };
};

export interface Side {
  readonly name: 'kernel' | 'generation';
  readonly runtime: ServiceRuntime;
  readonly directory: ServiceDirectory;
  readonly link: ProcessLink;
  readonly reports: DiagnosticReport[];
  readonly controller: AbortController;
  principal(bundleId: string): Principal;
  /** Announces a local provider of this side to the other side. */
  expose(contractId: string, bundleId?: string): void;
}

export interface Processes {
  readonly kernel: Side;
  readonly generation: Side;
  readonly transports: TransportPair;
  /** Every message the generation side sent, as the kernel received it. */
  readonly sentByGeneration: WireMessage[];
  /** Every message the kernel sent. */
  readonly sentByKernel: WireMessage[];
}

const recording = (transport: Transport, into: WireMessage[]): Transport => ({
  send: (message) => {
    transport.send(message);
    into.push(structuredClone(message));
  },
  onMessage: (listener) => transport.onMessage(listener),
  onClose: (listener) => transport.onClose(listener),
  close: () => transport.close(),
});

export interface ProcessesOptions {
  /** The generation of the generation process (default 2). */
  readonly generation?: number;
  /** The caller generation its runtime stamps (default: the generation). */
  readonly callerGeneration?: number;
  readonly errors?: ErrorClassRegistry;
}

export const processes = (options: ProcessesOptions = {}): Processes => {
  const generation = options.generation ?? 2;
  const transports = createTransportPair();
  const validators = ajvValidators();
  const sentByGeneration: WireMessage[] = [];
  const sentByKernel: WireMessage[] = [];
  const sides: Partial<Record<'kernel' | 'generation', Side>> = {};
  const build = (name: 'kernel' | 'generation', transport: Transport): Side => {
    const directory = new ServiceDirectory();
    const controller = new AbortController();
    const reports: DiagnosticReport[] = [];
    const principals = new Map<string, Principal>();
    const runtime: ServiceRuntime = {
      directory,
      catalog: emptyCatalogView,
      environment: 'host',
      generation:
        name === 'kernel' ? 1 : (options.callerGeneration ?? generation),
      operationGeneration: name === 'kernel' ? 0 : generation,
      generationSignal: controller.signal,
      report: (entry) => reports.push(entry),
    };
    const link = new ProcessLink({
      transport,
      side: name,
      generation,
      validators,
      errors: options.errors ?? createErrorClassRegistry(),
      resolve: ({ contract, provider }) =>
        directory
          .providers(contract)
          .find(
            (record) =>
              record.origin !== 'remote' &&
              (provider === undefined || record.bundleId === provider),
          ),
      principalOf: (bundleId) => principals.get(bundleId),
      report: (entry) => reports.push(entry),
    });
    const side: Side = {
      name,
      runtime,
      directory,
      link,
      reports,
      controller,
      principal: (bundleId) => {
        let principal = principals.get(bundleId);

        if (principal === undefined) {
          principal = createPrincipal(runtime, {
            bundleId,
            version: '1.0.0',
            provides: 'any',
            requires: 'any',
          });
          principals.set(bundleId, principal);
        }

        return principal;
      },
      expose: (contractId, bundleId) => {
        const record = directory
          .providers(contractId)
          .find(
            (entry) => bundleId === undefined || entry.bundleId === bundleId,
          );

        if (record === undefined) {
          throw new Error(`No local provider of ${contractId}.`);
        }

        const other = sides[name === 'kernel' ? 'generation' : 'kernel'];

        registerRemote(
          (other as Side).link,
          (other as Side).directory,
          describeRecord(record),
        );
      },
    };

    sides[name] = side;

    return side;
  };
  const kernel = build('kernel', recording(transports.left, sentByKernel));
  const child = build(
    'generation',
    recording(transports.right, sentByGeneration),
  );

  return {
    kernel,
    generation: child,
    transports,
    sentByGeneration,
    sentByKernel,
  };
};

/** A catalog snapshot for the platform providers of a test kernel. */
export const snapshot = (
  order: readonly string[],
  provides: Readonly<Record<string, readonly string[]>> = {},
): CatalogSnapshot => ({
  generation: 2,
  composition: { core: 'mincore', enabled: [...order], providers: {} },
  bundles: order.map((id) => ({
    id,
    version: '1.0.0',
    state: 'active' as const,
    manifest: {
      manifestVersion: 1 as const,
      id,
      version: '1.0.0',
      engines: { doric: '^1.0.0' },
      provides: [...(provides[id] ?? [])],
      requires: [],
    },
    reasons: [],
  })),
  order: [...order],
  contracts: [],
});

/** Kernel platform providers the minimal core reads (catalog, diagnostics). */
export const platformProviders = (
  kernel: Side,
  catalog: CatalogSnapshot,
): void => {
  const doric = kernel.principal('doric');
  const specs = platformContracts['doric.diagnostics/v1'].methods;

  doric.unchecked.provide(
    definePlatformService(DoricCatalogV1, {
      get: defineMethod({
        input: platformContracts['doric.catalog/v1'].methods.get.input,
        output: platformContracts['doric.catalog/v1'].methods.get.output,
        execute: () => catalog,
      }),
    }) as AnyServiceDefinition,
  );
  doric.unchecked.provide(
    definePlatformService(DoricDiagnosticsV1, {
      get: defineMethod({
        input: specs.get.input,
        output: specs.get.output,
        execute: () => ({
          generation: 2,
          mode: 'normal' as const,
          issues: [],
          bundles: [],
          errors: [],
          consumers: {},
        }),
      }),
      report: defineMethod({
        input: specs.report.input,
        output: specs.report.output,
        execute: (entry: DiagnosticReport) => {
          kernel.reports.push(entry);
        },
      }),
    }) as AnyServiceDefinition,
  );
};

/** Lets every queued envelope message be delivered and answered. */
export const flush = async (rounds = 20): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};
