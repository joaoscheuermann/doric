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

const recordKeys = new WeakMap<ProviderRecord, string>();
let nextRecordKey = 0;

/**
 * The stable key of a local provider record in this process: one bundle may
 * register several records of a `many` contract, and the other process names
 * the one it calls by this key.
 */
export const recordKey = (record: ProviderRecord): string => {
  let key = recordKeys.get(record);

  if (key === undefined) {
    nextRecordKey += 1;
    key = String(nextRecordKey);
    recordKeys.set(record, key);
  }

  return key;
};

/** The local record a call names: by key when it has one, else by bundle. */
export const matchesTarget = (
  record: ProviderRecord,
  target: { readonly provider?: string; readonly record?: string },
): boolean =>
  record.origin !== 'remote' &&
  (target.provider === undefined || record.bundleId === target.provider) &&
  (target.record === undefined || recordKeys.get(record) === target.record);

/** How a process keys the providers it announced or registered remotely. */
export const announcedKey = (descriptor: {
  readonly contractId: string;
  readonly bundleId: string;
  readonly key?: string;
}): string =>
  `${descriptor.contractId}\u0000${descriptor.bundleId}\u0000${descriptor.key ?? ''}`;

/** The descriptor another process needs to call a local provider record. */
export const describeRecord = (
  record: ProviderRecord,
): RemoteProviderDescriptor => ({
  contractId: record.contractId,
  bundleId: record.bundleId,
  key: recordKey(record),
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
        ...(descriptor.key === undefined ? {} : { record: descriptor.key }),
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
