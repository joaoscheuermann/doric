// `core`'s `models/v1` over the router (spec `docs/designs/grpc-processes.md`,
// phase 3, slice S41b): relays to the provider bundles of
// `models.provider/v1`.

import { ConnectError, type ServiceImpl } from '@connectrpc/connect';
import {
  type Call,
  ContractError,
  callOf,
  fromConnectError,
} from 'bundle/contracts';
import type {
  Model,
  ModelKindDescriptor,
  ProviderMessage,
  ProviderRequestOptions,
  ProviderTarget,
} from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import type {
  ModelCallHeader,
  ModelIconRequest,
  ModelsService,
} from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import { isModelIconName, modelIconSvg } from 'llms';

import type { CoreBinding, CoreCatalog } from '../binding.js';
import { preparedOf } from './configuration.js';
import { capacityCandidate, positiveCapacity } from './capacity.js';
import { iconAnswerOf, PROVIDER_ICONS_DEADLINE_MS } from './icons.js';
import type { ConfiguredProvider } from './providers.js';

const PROVIDER_CONTRACT = 'models.provider/v1';

/** One provider bundle's kind, as its `Kind`, `Advertised` and `CatalogCapacity` read. */
interface KindRead {
  readonly bundleId: string;
  readonly kind: ModelKindDescriptor;
  readonly advertised: boolean;
  readonly catalogCapacity: boolean;
}

/** A configured provider's bundle and target, read for one request. */
interface Routed {
  readonly bundleId: string;
  readonly target: Omit<ProviderTarget, '$typeName' | '$unknown'>;
}

const unavailable = () =>
  new ContractError('unavailable', 'Configured provider is unavailable.');

/** A provider bundle's error as the caller's `ContractError`. */
const relayedError = (error: unknown): unknown =>
  error instanceof ConnectError ? fromConnectError(error) : error;

/** The keys of the kind's `secret` fields. */
const secretKeys = (kind: ModelKindDescriptor): readonly string[] =>
  kind.fields.filter((field) => field.kind === 'secret').map(({ key }) => key);



/**
 * `models/v1` 1.5.0 over the provider bundles of `models.provider/v1`.
 *
 * Kinds. The kinds are those of the host providers of `models.provider/v1`
 * in `bind().catalog(call).providers('models.provider/v1')` order, each
 * read from its bundle with `Kind`, `Advertised` and `CatalogCapacity`
 * (`bind().provider(bundleId)`). A bundle whose `Kind` or `Advertised`
 * fails is left out of that call's answer and read again by the next one;
 * a failed `CatalogCapacity` counts as `false`. A successful read is kept
 * per bundle id and bundle version (the snapshot's `bundleVersion`). Two
 * bundles with one kind id: the first in order serves it.
 *
 * Configuration. `Prepare` records the providers of a configuration as
 * today (`preparedOf`): a stored snapshot (`revision`) becomes the active
 * set, a bare configuration a candidate. It makes no provider call and
 * builds nothing (the provider bundle builds on first use). It fails with
 * `invalid_input` when the configuration lists no providers or a provider
 * is malformed, and with `unavailable` `Unknown provider kind: <kind>` when
 * no provider bundle reports a configured kind; then it changes nothing.
 *
 * Targets. A configured provider's target is `ProviderTarget{ providerId,
 * values: its configuration without the kind's `secret` fields, secret? }`.
 * When one of the kind's `secret` fields names a credential (the first it
 * names), `secret` is `secretOf(<that id>, call)`, or `''` when none is
 * stored. It is read at every request, so a rotation reaches the next
 * request. Without such a field there is no `secret`. A `providerId` that
 * the active set does not list, or whose kind no provider bundle reports,
 * fails with `unavailable` "Configured provider is unavailable.". `core`
 * keeps no built provider and no cache keyed by values or secret.
 *
 * Each RPC: a provider bundle's error reaches the caller with its code,
 * message and details (`fromConnectError`); every call to a provider bundle
 * carries the calling call's deadline, scope, trace and signal. Every RPC
 * fails with `unavailable` until `activate` ran. The secret never appears
 * in a log, a diagnostic or an error.
 */
export const createModelsService = (
  bind: () => CoreBinding,
  secrets: {
    secretOf(id: string, call: Call): Promise<string | undefined>;
  },
  options?: {
    /** Per-bundle `Icons` deadline, ms; default `PROVIDER_ICONS_DEADLINE_MS` (1000). */
    readonly iconsDeadlineMs?: number;
  },
): { readonly implementation: ServiceImpl<typeof ModelsService> } => {
  const iconsDeadlineMs =
    options?.iconsDeadlineMs ?? PROVIDER_ICONS_DEADLINE_MS;
  /** The kind reads, per catalog snapshot and bundle; a failed read is not kept. */
  const reads = new WeakMap<
    CoreCatalog,
    Map<string, Promise<KindRead | undefined>>
  >();
  /** The providers of the stored configuration last prepared. */
  let active: readonly ConfiguredProvider[] | undefined;

  /** One bundle's kind read, shared by the calls of its snapshot. */
  const readOf = (
    binding: CoreBinding,
    kept: Map<string, Promise<KindRead | undefined>>,
    bundleId: string,
    call: Call,
  ): Promise<KindRead | undefined> => {
    const cached = kept.get(bundleId);

    if (cached !== undefined) {
      return cached;
    }

    const client = binding.provider(bundleId);
    const callOptions = { signal: call.signal };
    const read = Promise.all([
      client.kind({}, callOptions),
      client.advertised({}, callOptions),
      client.catalogCapacity({}, callOptions).then(
        ({ catalogCapacity }) => catalogCapacity,
        () => false,
      ),
    ]).then(
      ([{ modelKindDescriptor }, { advertised }, catalogCapacity]) =>
        modelKindDescriptor === undefined
          ? undefined
          : {
              bundleId,
              kind: modelKindDescriptor,
              advertised,
              catalogCapacity,
            },
      () => undefined,
    );

    kept.set(bundleId, read);
    void read.then((result) => {
      if (result === undefined && kept.get(bundleId) === read) {
        kept.delete(bundleId);
      }
    });

    return read;
  };

  /** The kinds `call`'s catalog reports, in provider order. */
  const kindsOf = async (
    binding: CoreBinding,
    call: Call,
  ): Promise<readonly KindRead[]> => {
    const catalog = await binding.catalog(call);
    let kept = reads.get(catalog);

    if (kept === undefined) {
      kept = new Map();
      reads.set(catalog, kept);
    }

    const all = await Promise.all(
      catalog
        .providers(PROVIDER_CONTRACT)
        .map((bundleId) => readOf(binding, kept, bundleId, call)),
    );

    return all.filter((read): read is KindRead => read !== undefined);
  };

  /** The first bundle in order that reports kind `id`. */
  const findKind = async (
    binding: CoreBinding,
    id: string,
    call: Call,
  ): Promise<KindRead | undefined> =>
    (await kindsOf(binding, call)).find(({ kind }) => kind.id === id);

  /** A configured provider's kind and values without its secret fields. */
  const configuredOf = async (
    binding: CoreBinding,
    providerId: string,
    call: Call,
  ): Promise<
    | {
        readonly provider: ConfiguredProvider;
        readonly read: KindRead;
        readonly values: Record<string, string>;
      }
    | undefined
  > => {
    const provider = active?.find(({ id }) => id === providerId);

    if (provider === undefined) {
      return undefined;
    }

    const read = await findKind(binding, provider.kind, call);

    if (read === undefined) {
      return undefined;
    }

    const secret = new Set(secretKeys(read.kind));
    const values = Object.fromEntries(
      Object.entries(provider.configuration).filter(
        ([key]) => !secret.has(key),
      ),
    );

    return { provider, read, values };
  };

  /** The bundle and the target of configured provider `providerId`. */
  const routedOf = async (
    binding: CoreBinding,
    providerId: string,
    call: Call,
  ): Promise<Routed> => {
    const configured = await configuredOf(binding, providerId, call);

    if (configured === undefined) {
      throw unavailable();
    }

    const { provider, read, values } = configured;
    // The first secret field the provider names is its credential.
    const credential = secretKeys(read.kind)
      .map((key) => provider.configuration[key])
      .find((id): id is string => id !== undefined);
    const secret =
      credential === undefined
        ? undefined
        : ((await secrets.secretOf(credential, call)) ?? '');

    return {
      bundleId: read.bundleId,
      target: {
        providerId,
        values,
        ...(secret === undefined ? {} : { secret }),
      },
    };
  };

  /**
   * The model's entry in the `Models` of exactly one candidate: the
   * configured providers of a capacity kind that are `providerId`, or,
   * without one, list the model. `undefined` otherwise; never throws.
   */
  const catalogModel = async (
    binding: CoreBinding,
    request: { readonly providerId?: string; readonly model: string },
    call: Call,
  ): Promise<Model | undefined> => {
    try {
      const capacityKinds = new Set(
        (await kindsOf(binding, call))
          .filter(({ catalogCapacity }) => catalogCapacity)
          .map(({ kind }) => kind.id),
      );
      const candidate = capacityCandidate(capacityKinds, active ?? [], request);

      if (candidate === undefined) {
        return undefined;
      }

      const { bundleId, target } = await routedOf(binding, candidate.id, call);
      const { models } = await binding
        .provider(bundleId)
        .models({ target }, { signal: call.signal });

      return models.find(({ id }) => id === request.model);
    } catch {
      return undefined;
    }
  };

  /** One `Icons` request's answer; none for every failure. */
  const iconsOf = async (
    binding: CoreBinding,
    request: ModelIconRequest,
    call: Call,
  ): Promise<{ provider?: string; models: string[] }> => {
    const none = { models: request.models.map(() => '') };

    try {
      let kind: KindRead | undefined;
      let configuration: Record<string, string>;

      if (request.providerId !== undefined) {
        const configured = await configuredOf(
          binding,
          request.providerId,
          call,
        );

        if (configured === undefined) {
          return none;
        }

        kind = configured.read;
        configuration = configured.values;
      } else {
        kind = await findKind(binding, request.kind ?? '', call);
        configuration = request.configuration;
      }

      if (kind === undefined) {
        return none;
      }

      const { modelIconChoice } = await binding
        .provider(kind.bundleId)
        .icons(
          { configuration, models: request.models },
          { signal: call.signal, timeoutMs: iconsDeadlineMs },
        );
      const answer = iconAnswerOf(modelIconChoice, request.models.length);

      if (answer === undefined) {
        return none;
      }

      const models = answer.models.map((name) => name ?? '');

      return answer.provider === undefined
        ? { models }
        : { provider: answer.provider, models };
    } catch {
      return none;
    }
  };

  /**
   * The items of a `Complete` or `Stream` call: the first must be the
   * header, which gives the provider's bundle; then each message as it
   * arrives. `refusal` records a later item that ends the relay.
   */
  const relayOf = async (
    binding: CoreBinding,
    requests: AsyncIterable<{
      item:
        | { case: 'header'; value: ModelCallHeader }
        | { case: 'message'; value: ProviderMessage }
        | { case: undefined; value?: undefined };
    }>,
    call: Call,
  ) => {
    const iterator = requests[Symbol.asyncIterator]();
    const first = await iterator.next();

    if (first.done === true || first.value.item.case !== 'header') {
      throw new ContractError(
        'invalid_input',
        'A completion starts with its header.',
      );
    }

    const header = first.value.item.value;
    const { bundleId, target } = await routedOf(
      binding,
      header.providerId,
      call,
    );
    const state: { refusal?: ContractError } = {};
    const options: ProviderRequestOptions | undefined = header.options;

    async function* items() {
      yield {
        item: {
          case: 'header' as const,
          value: { target, ...(options === undefined ? {} : { options }) },
        },
      };

      for (
        let next = await iterator.next();
        next.done !== true;
        next = await iterator.next()
      ) {
        const { item } = next.value;

        if (item.case === 'header') {
          state.refusal = new ContractError(
            'invalid_input',
            'A completion has one header.',
          );
          throw state.refusal;
        }

        if (item.case === 'message') {
          yield { item: { case: 'message' as const, value: item.value } };
        }
      }
    }

    return {
      client: binding.provider(bundleId),
      items: items(),
      failure: (error: unknown) => state.refusal ?? relayedError(error),
    };
  };

  const implementation: ServiceImpl<typeof ModelsService> = {
    resolve: async ({ providerId, model, effort }, context) => {
      const call = callOf(context);
      const binding = bind();

      if ((await configuredOf(binding, providerId, call)) === undefined) {
        throw unavailable();
      }

      return { providerId, model, ...(effort === undefined ? {} : { effort }) };
    },
    kinds: async (_request, context) => ({
      kinds: (await kindsOf(bind(), callOf(context)))
        .filter(({ advertised }) => advertised)
        .map(({ kind }) => kind),
    }),
    kind: async ({ id }, context) => {
      const read = await findKind(bind(), id, callOf(context));

      return read === undefined ? {} : { modelKindDescriptor: read.kind };
    },
    catalog: async ({ kind, configuration }, context) => {
      const call = callOf(context);
      const binding = bind();
      const read = await findKind(binding, kind, call);

      // A kind no bundle reports keeps no catalog.
      if (read === undefined) {
        return { catalogResult: { status: 'absent', models: [] } };
      }

      const [field] = secretKeys(read.kind);
      const id = field === undefined ? undefined : configuration[field];
      const secret =
        id === undefined ? undefined : await secrets.secretOf(id, call);

      try {
        const { catalogResult } = await binding.provider(read.bundleId).catalog(
          {
            configuration,
            ...(secret === undefined ? {} : { secret }),
          },
          { signal: call.signal },
        );

        return {
          catalogResult: catalogResult ?? { status: 'failed', models: [] },
        };
      } catch {
        // Never the endpoint, the credential or the response.
        const own = binding.own(call);
        const traceId = call.trace.traceparent.split('-')[1];

        await binding
          .writeLog(
            {
              level: 'warn',
              message: 'Model catalog could not be read',
              fields: { kind },
              bundleId: own.caller.bundleId,
              version: own.caller.version,
              generation: own.caller.generation,
              environment: 'host',
              scope: { ...call.scope },
              ...(traceId === undefined ? {} : { traceId }),
            },
            call,
          )
          .catch(() => undefined);

        return { catalogResult: { status: 'failed', models: [] } };
      }
    },
    prepare: async ({ configuration }, context) => {
      const call = callOf(context);
      const binding = bind();
      let prepared: ReturnType<typeof preparedOf>;

      try {
        prepared = preparedOf(configuration ?? {});
      } catch (error) {
        throw new ContractError(
          'invalid_input',
          error instanceof Error ? error.message : String(error),
        );
      }

      const kinds = await kindsOf(binding, call);

      for (const provider of prepared.providers) {
        if (!kinds.some(({ kind }) => kind.id === provider.kind)) {
          throw new ContractError(
            'unavailable',
            `Unknown provider kind: ${provider.kind}`,
          );
        }
      }

      // A bare configuration is only checked: nothing is built, so the
      // stored snapshot that follows becomes the active set by itself.
      if (prepared.revision !== undefined) {
        active = prepared.providers;
      }

      return {};
    },
    contextWindow: async (request, context) => {
      const call = callOf(context);
      const capacity = positiveCapacity(
        (await catalogModel(bind(), request, call))?.contextWindow,
      );

      return capacity === undefined ? {} : { contextWindow: capacity };
    },
    inputModalities: async (request, context) => {
      const call = callOf(context);
      const listed = (await catalogModel(bind(), request, call))
        ?.inputModalities;

      return listed !== undefined && listed.length > 0
        ? { known: true, inputModalities: listed }
        : { known: false, inputModalities: [] };
    },
    icons: async ({ requests }, context) => {
      const call = callOf(context);
      const binding = bind();
      const answers = await Promise.all(
        requests.map((request) => iconsOf(binding, request, call)),
      );
      const used = new Set(
        answers.flatMap(({ provider, models }) =>
          [provider, ...models].filter(
            (name): name is string => name !== undefined && name !== '',
          ),
        ),
      );

      return {
        svgs: Object.fromEntries(
          [...used].flatMap((name) =>
            isModelIconName(name) ? [[name, modelIconSvg(name)]] : [],
          ),
        ),
        answers,
      };
    },
    complete: async (requests, context) => {
      const call = callOf(context);
      const binding = bind();
      const relay = await relayOf(binding, requests, call);

      try {
        const { providerFinished } = await relay.client.complete(relay.items, {
          signal: call.signal,
        });

        return providerFinished === undefined ? {} : { providerFinished };
      } catch (error) {
        throw relay.failure(error);
      }
    },
    stream: async function* (requests, context) {
      const call = callOf(context);
      const binding = bind();
      const relay = await relayOf(binding, requests, call);

      try {
        const events = relay.client
          .stream(relay.items, { signal: call.signal })
          [Symbol.asyncIterator]();
        let next = events.next();

        for (let event = await next; event.done !== true; event = await next) {
          // The next event is asked for before this one reaches the caller,
          // so the provider call runs on (and sees a cancel) while the
          // caller reads. A pull the caller abandons is not awaited.
          next = events.next();
          void next.catch(() => undefined);

          const { providerStreamEvent } = event.value;

          yield providerStreamEvent === undefined
            ? {}
            : { providerStreamEvent };
        }
      } catch (error) {
        throw relay.failure(error);
      }
    },
    embedding: async ({ providerId, request }, context) => {
      const call = callOf(context);
      const binding = bind();
      const { bundleId, target } = await routedOf(binding, providerId, call);

      try {
        const { providerEmbeddingFinished } = await binding
          .provider(bundleId)
          .embedding(
            { target, ...(request === undefined ? {} : { request }) },
            { signal: call.signal },
          );

        return providerEmbeddingFinished === undefined
          ? {}
          : { providerEmbeddingFinished };
      } catch (error) {
        throw relayedError(error);
      }
    },
    rerank: async ({ providerId, request }, context) => {
      const call = callOf(context);
      const binding = bind();
      const { bundleId, target } = await routedOf(binding, providerId, call);

      try {
        const { providerRerankFinished } = await binding
          .provider(bundleId)
          .rerank(
            { target, ...(request === undefined ? {} : { request }) },
            { signal: call.signal },
          );

        return providerRerankFinished === undefined
          ? {}
          : { providerRerankFinished };
      } catch (error) {
        throw relayedError(error);
      }
    },
    models: async ({ providerId }, context) => {
      const call = callOf(context);
      const binding = bind();
      const { bundleId, target } = await routedOf(binding, providerId, call);

      try {
        const { models } = await binding
          .provider(bundleId)
          .models({ target }, { signal: call.signal });

        return { models };
      } catch (error) {
        throw relayedError(error);
      }
    },
    validateModel: async ({ providerId, model }, context) => {
      const call = callOf(context);
      const binding = bind();
      const { bundleId, target } = await routedOf(binding, providerId, call);

      try {
        const answer = await binding
          .provider(bundleId)
          .validateModel({ target, model }, { signal: call.signal });

        return answer.model === undefined ? {} : { model: answer.model };
      } catch (error) {
        throw relayedError(error);
      }
    },
  };

  return { implementation };
};
