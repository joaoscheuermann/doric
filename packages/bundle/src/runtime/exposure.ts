// Desktop exposure of contract methods (HR-10). A method is reachable from a
// desktop window only when the active provider declares it, and a contract the
// platform publishes takes its declaration from the platform's specification:
// a provider can refuse exposure there, never add it. Default: not exposed.

import type { MethodSpec } from '../contracts/basic/common.js';
import { basicContractSpec } from '../contracts/basic/index.js';
import { isMethodExposure, type MethodExposure } from '../contracts/expose.js';
import { platformContracts } from '../contracts/platform.js';
import type { JsonObject } from '../contracts/types.js';

/** The top-level key of a contract document that lists its exposed methods. */
export const documentExposureKey = 'x-doric-expose';

/** The method specs the platform publishes for a contract, if it publishes one. */
const publishedMethods = (
  contractId: string,
): Readonly<Record<string, MethodSpec>> | undefined => {
  const basic = basicContractSpec(contractId);

  if (basic !== undefined) {
    return basic.methods;
  }

  return Object.hasOwn(platformContracts, contractId)
    ? platformContracts[contractId as keyof typeof platformContracts].methods
    : undefined;
};

/**
 * The exposure of one method of a provider, from the provider's declaration;
 * for a published contract, from the platform specification instead.
 */
export const exposureOf = (
  contractId: string,
  method: string,
  declared?: { readonly expose?: MethodExposure },
): MethodExposure | undefined => {
  const published = publishedMethods(contractId);

  if (published !== undefined) {
    return Object.hasOwn(published, method)
      ? published[method]?.expose
      : undefined;
  }

  return declared?.expose;
};

/**
 * Whether a desktop window may reach `method` of the provider `spec` (the
 * active provider's record, undefined when there is none).
 */
export const isDesktopExposed = (
  contractId: string,
  method: string,
  spec: { readonly expose?: MethodExposure } | undefined,
): boolean =>
  spec !== undefined && exposureOf(contractId, method, spec) === 'desktop';

/**
 * The first method of a provider that declares an exposure the platform
 * specification of its contract does not give it; undefined when none does.
 */
export const misdeclaredExposure = (
  contractId: string,
  methods: Readonly<Record<string, { readonly expose?: MethodExposure }>>,
): string | undefined => {
  const published = publishedMethods(contractId);

  if (published === undefined) {
    return undefined;
  }

  return Object.keys(methods).find((name) => {
    const expose = methods[name]?.expose;

    return expose !== undefined && expose !== published[name]?.expose;
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The methods a contract document exposes, by name. Throws `TypeError` for a
 * malformed declaration: an entry that names no method of the document or an
 * exposure that is not a known target.
 */
export const documentExposure = (
  document: JsonObject,
): Readonly<Record<string, MethodExposure>> => {
  const declared = document[documentExposureKey];

  if (declared === undefined) {
    return {};
  }

  if (!isRecord(declared)) {
    throw new TypeError(`${documentExposureKey} must be an object.`);
  }

  const defs = isRecord(document.$defs) ? document.$defs : {};
  const exposed: Record<string, MethodExposure> = {};

  for (const [name, target] of Object.entries(declared)) {
    if (!Object.hasOwn(defs, `${name}.input`)) {
      throw new TypeError(
        `${documentExposureKey} names "${name}", which is no method of the contract.`,
      );
    }

    if (!isMethodExposure(target)) {
      throw new TypeError(
        `${documentExposureKey} of "${name}" is not a known exposure.`,
      );
    }

    exposed[name] = target;
  }

  return exposed;
};
