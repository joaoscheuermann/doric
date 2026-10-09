import type { MethodSpecs } from '../../contracts/basic/common.js';
import { basicContractSpec } from '../../contracts/basic/index.js';
import type { Call } from '../../contracts/call.js';
import { platformContracts } from '../../contracts/platform.js';
import type { JsonObject } from '../../contracts/types.js';
import type { Directory, ProviderRecord } from '../directory.js';
import { contractDocument } from '../json-schema.js';
import type { ProcessLink } from './link.js';
import type { RemoteProviderDescriptor } from './messages.js';
import { documentMethodSpecs } from './validators.js';
import {
  type CodecContext,
  decodeValue,
  documentPlan,
  encodeValue,
  fixedPlan,
  localOnly,
  type MethodPlan,
} from './values.js';

export type { RemoteProviderDescriptor } from './messages.js';

const isPlatformSpec = (id: string): id is keyof typeof platformContracts =>
  Object.hasOwn(platformContracts, id);

/** The descriptor another process needs to call a local provider record. */
export const describeRecord = (
  record: ProviderRecord,
): RemoteProviderDescriptor => ({
  contractId: record.contractId,
  bundleId: record.bundleId,
  version: record.version,
  contractVersion: record.contractVersion,
  environment: record.environment,
  cardinality: record.cardinality,
  schema:
    basicContractSpec(record.contractId) !== undefined
      ? { kind: 'basic' }
      : isPlatformSpec(record.contractId)
        ? { kind: 'platform' }
        : {
            kind: 'document',
            document: contractDocument({
              id: record.contractId,
              environment: record.environment,
              cardinality: record.cardinality,
              kind: 'service',
              methods: record.methods,
            }).document,
          },
});

const methodsOf = (
  link: ProcessLink,
  descriptor: RemoteProviderDescriptor,
): MethodSpecs => {
  const { contractId, schema } = descriptor;

  switch (schema.kind) {
    case 'basic': {
      const spec = basicContractSpec(contractId);

      if (spec === undefined) {
        throw new TypeError(`"${contractId}" is not a basic contract.`);
      }

      return spec.methods;
    }
    case 'platform':
      if (!isPlatformSpec(contractId)) {
        throw new TypeError(`"${contractId}" is not a platform contract.`);
      }

      return platformContracts[contractId].methods;
    case 'document':
      return documentMethodSpecs(link.validators, schema.document);
  }
};

const defs = (document: JsonObject): JsonObject =>
  typeof document.$defs === 'object' &&
  document.$defs !== null &&
  !Array.isArray(document.$defs)
    ? (document.$defs as JsonObject)
    : {};

/**
 * A provider of the other process, behind the same record seam `dispatch`
 * uses: the sender validated the input with the record's specs (JSON Schema
 * for bundle-defined contracts), this record encodes it, sends it and decodes
 * the result.
 */
export const remoteRecord = (
  link: ProcessLink,
  descriptor: RemoteProviderDescriptor,
): ProviderRecord => {
  const methods = methodsOf(link, descriptor);
  const plans = new Map<string, MethodPlan>();
  const planOf = (method: string): MethodPlan => {
    let plan = plans.get(method);

    if (plan === undefined) {
      const { schema } = descriptor;

      plan =
        schema.kind === 'document'
          ? documentPlan(
              `${descriptor.contractId} ${method}`,
              defs(schema.document)[`${method}.input`],
              defs(schema.document)[`${method}.output`],
            )
          : (fixedPlan(descriptor.contractId, method) ?? {
              refused: `${descriptor.contractId} ${method}`,
            });
      plans.set(method, plan);
    }

    return plan;
  };

  return Object.freeze({
    contractId: descriptor.contractId,
    bundleId: descriptor.bundleId,
    version: descriptor.version,
    contractVersion: descriptor.contractVersion,
    environment: descriptor.environment,
    cardinality: descriptor.cardinality,
    methods,
    origin: 'remote' as const,
    invoke: (method: string, input: unknown, call: Call): unknown => {
      const plan = planOf(method);

      if (plan.refused !== undefined) {
        throw localOnly(plan.refused);
      }

      const exports: string[] = [];
      const context: CodecContext = { host: link, call, exports };
      const prepared = plan.prepare === undefined ? input : plan.prepare(input);
      const target = {
        contract: descriptor.contractId,
        method,
        input:
          plan.input === undefined
            ? prepared
            : encodeValue(prepared, plan.input, context),
        provider: descriptor.bundleId,
      };

      if (plan.oneway === true) {
        link.oneway(target, call);

        return undefined;
      }

      if (plan.optimistic === true) {
        return link.optimistic(call.caller.bundleId, target, call, exports);
      }

      return link.request(target, call).then((output) => {
        const decoded =
          plan.output === undefined ? output : decodeValue(output, context);

        return plan.finish === undefined
          ? decoded
          : plan.finish(decoded, input);
      });
    },
  });
};

/**
 * Registers a remote provider in a directory until it is withdrawn or the
 * link closes. Returns the withdraw function.
 */
export const registerRemote = (
  link: ProcessLink,
  directory: Directory,
  descriptor: RemoteProviderDescriptor,
): (() => void) => {
  const unregister = directory.register(remoteRecord(link, descriptor));
  const off = link.onClose(() => unregister());

  return () => {
    off();
    unregister();
  };
};
