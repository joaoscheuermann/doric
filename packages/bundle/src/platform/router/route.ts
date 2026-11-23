// Steps 2 to 4 of a call between bundles (spec `docs/designs/grpc-processes.md`,
// section 3, "Calls between bundles"): which contract a path names, whether
// the caller declared it, and which instance serves it. Pure; the relay
// (`calls.ts`) waits for the instance and carries the call.

import { ContractError } from '../../contracts/error.js';
import { providerHeader, targetHeader } from '../../contracts/metadata.js';
import type { ResolvedEnvironment } from '../../runtime/catalog.js';
import {
  type Part,
  parseContractEntry,
  partLists,
} from '../../runtime/manifest.js';
import { PLATFORM_VERSION } from '../../runtime/version.js';
import type { CatalogIndex, MethodInfo } from '../catalog-index.js';
import {
  type InstanceKey,
  type InstanceRecord,
  instanceKey,
} from './instances.js';

/**
 * What one part of a bundle declares, by contract id (`tools/v1`), as step 3
 * checks it: the part's `requires` and `optional` lists, and the bundle's
 * `provides`.
 */
export interface PartDeclarations {
  readonly requires: ReadonlySet<string>;
  readonly optional: ReadonlySet<string>;
  readonly provides: ReadonlySet<string>;
}

/**
 * What the router reads of the resolved catalog to route a call. The answers
 * may change between two calls (a publish swaps the resolution); a call reads
 * them once, at its steps 3 and 4.
 */
export interface CallRoutes {
  /**
   * The declarations of `part` of `bundleId`: a bundle process's calls are
   * checked against `host`, a window's (through the gateway) against
   * `client`. `undefined` for a bundle the resolution does not schedule.
   */
  declarationsOf(bundleId: string, part: Part): PartDeclarations | undefined;
  /**
   * The bundles that provide `contractId` in the resolution, in its order: at
   * most one for a `one` contract. Empty for a contract nobody provides, or
   * whose providers are quarantined or disabled.
   */
  providersOf(contractId: string): readonly string[];
  /**
   * The bundles whose `host` part lists `contractId` under `requires` or
   * `optional`, in the resolution's order: the bundles a `ProviderChanged`
   * for the contract goes to (section 4). Empty for a contract no scheduled
   * bundle's host part lists.
   */
  consumersOf(contractId: string): readonly string[];
}

/**
 * The routes of a host resolution: `declarationsOf` answers, for a
 * `scheduled` entry, the contract ids of `partLists(manifest, part)` (a v1
 * manifest's bundle-wide lists for either part) and of its `provides`;
 * `providersOf` answers `resolved.contracts[].providers` in order;
 * `consumersOf` answers the `scheduled` entries, in order, whose `host`
 * `requires` or `optional` holds the contract id. Pure;
 * the answer does not follow later changes of `resolved`.
 */
export const callRoutesOf = (resolved: ResolvedEnvironment): CallRoutes => {
  const declarations = new Map<
    string,
    Readonly<Record<Part, PartDeclarations>>
  >(
    resolved.entries.flatMap((entry) => {
      const { manifest } = entry;

      if (entry.state !== 'scheduled' || manifest === undefined) {
        return [];
      }

      const provides = new Set(
        manifest.provides.flatMap((ref) => parseContractEntry(ref)?.id ?? []),
      );
      const of = (part: Part): PartDeclarations => {
        const lists = partLists(manifest, part);

        return {
          requires: new Set(lists.requires.map(({ id }) => id)),
          optional: new Set(lists.optional),
          provides,
        };
      };

      return [[entry.id, { host: of('host'), client: of('client') }]];
    }),
  );
  const providers = new Map(
    resolved.contracts.map((contract) => [
      contract.id,
      contract.providers.map(({ bundleId }) => bundleId),
    ]),
  );

  return {
    declarationsOf: (bundleId, part) => declarations.get(bundleId)?.[part],
    providersOf: (contractId) => providers.get(contractId) ?? [],
    consumersOf: (contractId) =>
      [...declarations].flatMap(([bundleId, { host }]) =>
        host.requires.has(contractId) || host.optional.has(contractId)
          ? [bundleId]
          : [],
      ),
  };
};

/**
 * Where step 4 sends a call:
 * - `platform`: a `doric.*` contract the host serves in process; no instance;
 * - `provider`: the active instance of `bundleId`, the provider the catalog
 *   resolved for a `one` contract or the one `doric-provider` named for a
 *   `many` contract;
 * - `target`: the instance `doric-target` named, for a handler service.
 */
export type CallRoute =
  | { readonly kind: 'platform'; readonly method: MethodInfo }
  | {
      readonly kind: 'provider';
      readonly method: MethodInfo;
      readonly bundleId: string;
    }
  | {
      readonly kind: 'target';
      readonly method: MethodInfo;
      readonly target: InstanceKey;
    };

/**
 * The caller of every call through the gateway (section 11, "The caller"):
 * the platform `doric` at the platform version, generation 0, today's bridge
 * principal. Not in the instance table and never revoked; its key,
 * `doric/0/0`, is the `from` that {@link CallRelay.inFlight} and
 * {@link CallRelay.onCallEnded} report for a gateway call.
 */
export const gatewayCaller: InstanceRecord = Object.freeze({
  bundleId: 'doric',
  version: PLATFORM_VERSION,
  generation: 0,
  incarnation: 0,
  state: 'active',
});

/** One call as steps 2 to 4 read it. */
export interface RouteRequest {
  /** The authenticated caller (step 1). */
  readonly caller: InstanceRecord;
  /**
   * The part whose lists step 3 checks: `host` for a bundle process,
   * `client` for a gateway call that names its client part.
   */
  readonly part: Part;
  /**
   * The bundle whose `part` lists step 3 checks (D34):
   *
   * - undefined: the caller's bundle, as for every call that reaches the
   *   router listener;
   * - a bundle id: the client part a gateway call's `doric-client-part`
   *   names; the caller stays {@link gatewayCaller};
   * - `null`: a gateway call without `doric-client-part`, which has no lists
   *   to check: step 3 lets every method of a contract service through,
   *   since the gateway relays only the methods it serves.
   *
   * Whatever its value, a method of a handler service answers `not_owner`
   * for a caller whose bundle does not provide the contract, so a gateway
   * call never reaches one.
   */
  readonly declaredBy?: string | null;
  /** The gRPC path, `/<service full name>/<method name>`. */
  readonly path: string;
  /** The request headers; only `doric-provider` and `doric-target` are read. */
  readonly header: Headers;
}

export interface RouteEnv {
  readonly index: CatalogIndex;
  readonly routes: CallRoutes;
  /** The full names of the services the host serves in process. */
  readonly platformServices: ReadonlySet<string>;
}

/**
 * Decides steps 2 to 4 of a call, without waiting and without an instance's
 * state. Throws a `ContractError`, checked in this order:
 *
 * 2. `unknown_contract`: `path` is not a method of the index, or is a method
 *    of a `doric.*` contract the host does not serve in process
 *    (`platformServices`).
 * 3. `undeclared_requirement`: the contract is not `doric.*`, and the `part`
 *    of the declaring bundle (`declaredBy`, the caller's bundle when
 *    undefined) neither requires nor lists it under `optional`, nor does
 *    that bundle provide it (also when `declarationsOf` answers
 *    `undefined`, as for a bundle the resolution does not schedule). With
 *    `declaredBy: null` nothing is checked. For a method of a handler
 *    service (`role: 'handler'`) instead: `not_owner` unless the caller's
 *    bundle provides the contract that declares the service and the request
 *    has `doric-target`.
 * 4. For a contract of cardinality `many`: `invalid_input` without
 *    `doric-provider`, `unknown_provider` when it names a bundle not among
 *    `providersOf`. For a `one` contract: `unavailable` when `providersOf` is
 *    empty; `doric-provider` is ignored. For a handler service:
 *    `invalid_input` when `doric-target` is not
 *    `<bundleId>/<generation>/<incarnation>`.
 *
 * A `doric.*` contract the host serves answers `platform` after step 3.
 * Pure.
 */
export const routeCall = (request: RouteRequest, env: RouteEnv): CallRoute => {
  const method = env.index.method(request.path);
  const contractId = method?.contract.id;

  if (
    method === undefined ||
    contractId === undefined ||
    (contractId.startsWith('doric.') &&
      !env.platformServices.has(method.service.typeName))
  ) {
    throw new ContractError(
      'unknown_contract',
      `No contract serves ${request.path}.`,
    );
  }

  if (contractId.startsWith('doric.')) {
    return { kind: 'platform', method };
  }

  if (method.role === 'handler') {
    const own = env.routes.declarationsOf(
      request.caller.bundleId,
      request.part,
    );
    const target = request.header.get(targetHeader);

    if (own?.provides.has(contractId) !== true || target === null) {
      throw new ContractError(
        'not_owner',
        `Only a provider of ${contractId} calls ${method.service.typeName}, with ${targetHeader}.`,
      );
    }

    return { kind: 'target', method, target: parseTarget(target) };
  }

  if (request.declaredBy !== null) {
    const bundleId = request.declaredBy ?? request.caller.bundleId;
    const declared = env.routes.declarationsOf(bundleId, request.part);

    if (
      declared === undefined ||
      !(
        declared.requires.has(contractId) ||
        declared.optional.has(contractId) ||
        declared.provides.has(contractId)
      )
    ) {
      throw new ContractError(
        'undeclared_requirement',
        `The ${request.part} part of ${bundleId} does not declare ${contractId}.`,
      );
    }
  }

  const providers = env.routes.providersOf(contractId);

  if (method.contract.cardinality === 'one') {
    const [provider] = providers;

    if (provider === undefined) {
      throw new ContractError(
        'unavailable',
        `No bundle provides ${contractId}.`,
      );
    }

    return { kind: 'provider', method, bundleId: provider };
  }

  const provider = request.header.get(providerHeader);

  if (provider === null) {
    throw new ContractError(
      'invalid_input',
      `A call to ${contractId} names its provider in ${providerHeader}.`,
    );
  }

  if (!providers.includes(provider)) {
    throw new ContractError(
      'unknown_provider',
      `${provider} does not provide ${contractId}.`,
    );
  }

  return { kind: 'provider', method, bundleId: provider };
};

/** The key a `doric-target` names; `invalid_input` when malformed. */
const parseTarget = (target: string): InstanceKey => {
  const match = /^([^/]+)\/(\d+)\/(\d+)$/.exec(target);

  if (match?.[1] === undefined) {
    throw new ContractError(
      'invalid_input',
      `${targetHeader} is not <bundleId>/<generation>/<incarnation>: ${target}.`,
    );
  }

  return instanceKey({
    bundleId: match[1],
    generation: Number(match[2]),
    incarnation: Number(match[3]),
  });
};
