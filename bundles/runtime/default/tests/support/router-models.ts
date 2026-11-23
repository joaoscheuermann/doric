import type { MessageInitShape } from '@bufbuild/protobuf';
import type { HandlerContext } from '@connectrpc/connect';
import { ContractError, type ModelKindDescriptor } from 'bundle/contracts';
import type {
  ProviderRequestOptions,
  StreamRequestSchema as ProviderStreamRequestSchema,
  ProviderMessage as WireMessage,
} from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import { ModelsService } from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import type { ServiceEntry } from 'bundle/host';
import type { LlmProvider } from 'llms';
import { serveProviderKind } from 'llms/rpc';
import type { ConfigurationValue } from 'runtime/contracts';

import type { RoutedOptions, SessionState } from './router.js';
import { type Enter, fakeOf } from './router-fakes.js';
import { itemsOf } from './router-wire.js';

const fakeKind: ModelKindDescriptor = {
  id: 'fake',
  label: 'Fake',
  description: 'A scripted provider kind.',
  fields: [],
  lists: ['models'],
};

/**
 * `models/v1` relaying `Stream`/`Complete` to `serveProviderKind` over `options.provider`, recording each request's
 * messages in `wireMessages` and its signal in `modelSignals`.
 */
export const modelsFake = (
  options: RoutedOptions,
  configuration: ConfigurationValue,
  session: SessionState,
  enter: Enter,
  wireMessages: WireMessage[][],
  modelSignals: AbortSignal[],
): ServiceEntry => {
  const provider = serveProviderKind(
    {
      kind: fakeKind,
      advertised: true,
      catalogCapacity: false,
      icons: ({ models }) => ({ models: models.map(() => null) }),
      build: () => options.provider as LlmProvider,
    },
    {
      readAttachment: async function* (id) {
        const attachment = session.attachments.get(id);
        if (attachment === undefined) throw new Error(`No attachment ${id}.`);
        yield {
          item: {
            case: 'head' as const,
            value: {
              attachment: {
                mediaType: attachment.mediaType,
                name: attachment.name,
              },
            },
          },
        };
        yield {
          item: { case: 'chunk' as const, value: new Uint8Array([1, 2, 3]) },
        };
      },
    },
  );
  type ModelItems = AsyncIterable<{
    readonly item:
      | {
          readonly case: 'header';
          readonly value: {
            readonly providerId: string;
            readonly options?: ProviderRequestOptions;
          };
        }
      | { readonly case: 'message'; readonly value: WireMessage }
      | { readonly case: undefined; readonly value?: undefined };
  }>;
  /** A `models/v1` completion's items as `models.provider/v1` takes them. */
  const forward = async (
    method: string,
    requests: ModelItems,
    context: HandlerContext,
  ) => {
    const items: MessageInitShape<typeof ProviderStreamRequestSchema>[] = [];
    const messages: WireMessage[] = [];
    let providerId = '';

    for await (const { item } of requests) {
      if (item.case === 'header') {
        providerId = item.value.providerId;
        items.push({
          item: {
            case: 'header',
            value: {
              target: { providerId, values: {} },
              ...(item.value.options === undefined
                ? {}
                : { options: item.value.options }),
            },
          },
        });
      } else if (item.case === 'message') {
        messages.push(item.value);
        items.push({ item: { case: 'message', value: item.value } });
      }
    }

    wireMessages.push(messages);
    modelSignals.push(context.signal);
    enter(ModelsService, method, context, { providerId });

    return items;
  };

  return fakeOf(ModelsService, {
    resolve: (
      request: { providerId: string; model: string; effort?: string },
      context: HandlerContext,
    ) => {
      const value = {
        providerId: request.providerId,
        model: request.model,
        ...(request.effort === undefined ? {} : { effort: request.effort }),
      };
      enter(ModelsService, 'resolve', context, value);
      if (options.resolve !== undefined) options.resolve(value);
      else if (
        !configuration.providers.some(({ id }) => id === request.providerId)
      ) {
        throw new ContractError(
          'model_unavailable',
          'Configured provider is unavailable.',
        );
      }
      return value;
    },
    inputModalities: (
      request: { providerId?: string; model: string },
      context: HandlerContext,
    ) => {
      enter(ModelsService, 'inputModalities', context, {
        providerId: request.providerId,
        model: request.model,
      });
      return options.inputModalities === undefined
        ? { known: false }
        : { known: true, inputModalities: [...options.inputModalities] };
    },
    stream: async function* (requests: ModelItems, context: HandlerContext) {
      const items = await forward('stream', requests, context);
      for await (const { providerStreamEvent } of provider.stream(
        itemsOf(items) as never,
        context,
      )) {
        yield { providerStreamEvent };
      }
    },
    complete: async (requests: ModelItems, context: HandlerContext) => {
      const items = await forward('complete', requests, context);
      const { providerFinished } = await provider.complete(
        itemsOf(items) as never,
        context,
      );
      return { providerFinished };
    },
  });
};
