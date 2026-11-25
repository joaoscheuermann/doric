// A `Services` stand-in for stories: each contract id maps to a fixture API.
// `whenAvailable` answers at once for the contracts the story serves and
// never for the others, as a window without that provider would.
//
// Since S65d the client part asks for the generated `ResourcesService`
// descriptor rather than the `resources/v1` contract id. A descriptor resolves
// to its contract id (`getOption(file, contractOption).id`) and answers the
// `Resources` fixture as the generated client, so a story keeps describing
// today's `Resources` API.

import {
  create,
  type DescService,
  getOption,
  hasOption,
} from '@bufbuild/protobuf';
import type { Client } from '@connectrpc/connect';
import type {
  AnyServiceRef,
  ApiOf,
  Cleanup,
  ProviderInfo,
  Services,
} from 'bundle/contracts';
import { contract as contractOption } from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';

import {
  ContainerResourcesSchema,
  HostResponseSchema,
  ProjectResponseSchema,
  type ResourcesService,
} from '../../src/contracts/gen/doric/resources/v1/resources_pb.js';
import type { Resources } from '../../src/contracts/index.js';

const provider: ProviderInfo = { bundleId: 'stories', version: '0.0.0' };

/** A generated service descriptor, as `use` tells it from a `ref`. */
const isDescService = (value: unknown): value is DescService =>
  typeof value === 'object' &&
  value !== null &&
  (value as { readonly kind?: unknown }).kind === 'service' &&
  typeof (value as { readonly typeName?: unknown }).typeName === 'string';

/** The contract id a `ref` or a generated service descriptor declares. */
const contractIdOf = (contract: unknown): string | undefined => {
  if (isDescService(contract)) {
    return hasOption(contract.file, contractOption)
      ? getOption(contract.file, contractOption).id
      : undefined;
  }
  return (contract as { readonly id?: string } | undefined)?.id;
};

/**
 * `resources/v1` as today's `Resources` fixture answers it, over the generated
 * client a client part reaches: today's readings become the messages the host
 * sends.
 */
const resourcesClientOf = (api: Resources): Client<typeof ResourcesService> =>
  ({
    host: async () => create(HostResponseSchema, await api.host()),
    project: async () => {
      const result = await api.project();

      return result.status === 'ready'
        ? create(ProjectResponseSchema, {
            status: result.status,
            value: create(ContainerResourcesSchema, result.value),
          })
        : create(ProjectResponseSchema, { status: result.status });
    },
  }) as unknown as Client<typeof ResourcesService>;

/** The API a contract answers: a descriptor's `resources/v1` fixture as a client. */
const apiOf = (apis: Readonly<Record<string, unknown>>, contract: unknown) => {
  const id = contractIdOf(contract);
  if (id === undefined) return undefined;
  const api = apis[id];
  return isDescService(contract) && id === 'resources/v1' && api !== undefined
    ? resourcesClientOf(api as Resources)
    : api;
};

export const fakeServices = (
  apis: Readonly<Record<string, unknown>>,
): Services => ({
  provide: () => ({ dispose: () => undefined }),
  use: <R extends AnyServiceRef>(contract: R): ApiOf<R> => {
    const api = apiOf(apis, contract);
    if (api === undefined) {
      throw new Error(
        `No story provider serves ${contractIdOf(contract) ?? 'this contract'}.`,
      );
    }
    return api as ApiOf<R>;
  },
  whenAvailable: <R extends AnyServiceRef>(
    contract: R,
    // biome-ignore lint/suspicious/noConfusingVoidType: the `Services` callback shape
    callback: (api: ApiOf<R>, provider: ProviderInfo) => void | Cleanup,
  ) => {
    const api = apiOf(apis, contract);
    const cleanup =
      api === undefined ? undefined : callback(api as ApiOf<R>, provider);
    return {
      dispose: () => {
        if (typeof cleanup === 'function') cleanup();
      },
    };
  },
});
