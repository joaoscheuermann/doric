// The window's Connect path to the host, faked for the settings window's
// tests (slice S65c; spec `docs/designs/grpc-processes.md`, section 13, "The
// window to main"): a `window.doric.connect` (`DoricConnectApi`) whose
// requests go to a Connect router, as main's relay forwards them to the host.
// Through it the window's own `windowHostClients` (S64) answers the settings
// part's `services.use(<X>Service)`, so the calls cross Connect's binary
// protocol (the same fake as chat's `tests/client/support/host-connect.ts`;
// each bundle keeps its own copy, `bundles/AGENTS.md`).
//
// The router serves `HostConfigService`, `ModelsService` (Kinds, Kind,
// Catalog, Icons), `ToolsService.Catalog` and `SecretsService` (List, Create,
// Update, Delete), each but the `absent` contracts: each request is read as
// today's input, recorded as the envelope named it (`<contract>.<method>`, a
// tuple method's input as its tuple) and handed to the test's
// `<contract>.<method>` answer; the answer, in today's shapes, is written as
// the proto response with the host's codec (`runtime/contracts`' `encode`).
// A method without an answer answers the empty response.

import { Buffer } from 'node:buffer';

import {
  create,
  type DescMessage,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
// biome-ignore-start lint/correctness/noUndeclaredDependencies: test-only imports; `@connectrpc/connect` is a root dependency, and group E edits no package.json (contract groupE §8 Q13)
import {
  type ConnectRouter,
  createConnectRouter,
  type HandlerContext,
} from '@connectrpc/connect';
import { createUniversalHandlerClient } from '@connectrpc/connect/protocol';
// biome-ignore-end lint/correctness/noUndeclaredDependencies: as above
import {
  ContractError,
  type ContractErrorCode,
  toConnectError,
} from 'bundle/contracts';
import {
  CatalogResponseSchema,
  IconsRequestSchema,
  IconsResponseSchema,
  KindResponseSchema,
  KindsResponseSchema,
  ModelsService,
} from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import {
  CreateRequestSchema,
  CreateResponseSchema,
  CredentialUpdateSchema,
  DeleteResponseSchema,
  ListResponseSchema,
  SecretsService,
  UpdateResponseSchema,
} from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import {
  CatalogResponseSchema as ToolCatalogResponseSchema,
  ToolsService,
} from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import type {
  BridgeCallEnvelope,
  ConnectReply,
  DoricConnectApi,
} from 'desktop/client';
import {
  CurrentResponseSchema,
  HostConfigService,
  ReplaceResponseSchema,
} from 'host-config/contracts/gen/doric/host_config/v1/host_config_pb.js';
import { decode, encode } from 'runtime/contracts';

/** What the host answers for one `<contract>.<method>`, in today's shapes. */
export type HostAnswer = (input: unknown) => unknown;

/** The header the client SDK names the calling part with. */
const clientPartHeader = 'doric-client-part';

/** A failure the test's answer threw, as the Connect error the host sends. */
const connectFailure = (error: unknown): unknown => {
  if (error instanceof ContractError) return toConnectError(error);
  const failure = error as { code?: string; message?: string } | undefined;
  return toConnectError(
    new ContractError(
      (failure?.code ?? 'internal') as ContractErrorCode,
      failure?.message ?? 'failed',
    ),
  );
};

let callIds = 0;

/**
 * The host behind the window's `doric:connect`: each call it serves is
 * appended to `calls` as the envelope named it, then answered by
 * `host[<contract>.<method>]`. The contracts in `absent` are not served
 * (`UNIMPLEMENTED`).
 */
export const serveHostConnect = (input: {
  readonly host: Readonly<Record<string, HostAnswer>>;
  readonly calls: BridgeCallEnvelope[];
  readonly absent: ReadonlySet<string>;
}): DoricConnectApi => {
  /**
   * Records one call, runs its answer and writes `wrap(answer)` as the
   * message of `schema`; no answer is the empty message.
   */
  const unary = async <D extends DescMessage>(
    contract: string,
    method: string,
    callInput: unknown,
    context: HandlerContext,
    schema: D,
    wrap: (answer: unknown) => unknown = (answer) => answer,
  ): Promise<MessageShape<D>> => {
    callIds += 1;
    input.calls.push({
      id: `connect-${String(callIds)}`,
      contract,
      method,
      input: callInput,
      bundleId: context.requestHeader.get(clientPartHeader),
      deadline: 0,
      traceparent: '',
    });
    const answer = input.host[`${contract}.${method}`];
    try {
      if (answer === undefined) return create(schema);
      return encode(schema, wrap(await answer(callInput)));
    } catch (error) {
      throw connectFailure(error);
    }
  };

  const routes = (router: ConnectRouter) => {
    if (!input.absent.has('host-config/v1'))
      router.service(HostConfigService, {
        current: (_request, context) =>
          unary(
            'host-config/v1',
            'current',
            [],
            context,
            CurrentResponseSchema,
            (answer) => ({ doricConfiguration: answer }),
          ),
        replace: ({ input: value }, context) =>
          unary(
            'host-config/v1',
            'replace',
            value === undefined ? undefined : toJson(ValueSchema, value),
            context,
            ReplaceResponseSchema,
          ),
      });
    if (!input.absent.has('models/v1'))
      router.service(ModelsService, {
        kinds: (_request, context) =>
          unary(
            'models/v1',
            'kinds',
            [],
            context,
            KindsResponseSchema,
            (answer) => ({ kinds: answer }),
          ),
        kind: ({ id }, context) =>
          unary(
            'models/v1',
            'kind',
            [id],
            context,
            KindResponseSchema,
            (answer) =>
              answer === undefined || answer === null
                ? {}
                : { modelKindDescriptor: answer },
          ),
        catalog: ({ kind, configuration }, context) =>
          unary(
            'models/v1',
            'catalog',
            { kind, configuration: { ...configuration } },
            context,
            CatalogResponseSchema,
            (answer) => ({ catalogResult: answer }),
          ),
        icons: (request, context) =>
          unary(
            'models/v1',
            'icons',
            decode(IconsRequestSchema, request),
            context,
            IconsResponseSchema,
            (answer) => {
              const icons = answer as {
                readonly answers?: readonly {
                  readonly models: readonly (string | null)[];
                }[];
              };
              // An icon-less model travels as `""`, as the core sends it.
              return {
                ...icons,
                answers: (icons.answers ?? []).map((each) => ({
                  ...each,
                  models: each.models.map((name) => name ?? ''),
                })),
              };
            },
          ),
      });
    if (!input.absent.has('tools/v1'))
      router.service(ToolsService, {
        catalog: (_request, context) =>
          unary(
            'tools/v1',
            'catalog',
            [],
            context,
            ToolCatalogResponseSchema,
            (answer) => ({ entries: answer }),
          ),
      });
    if (!input.absent.has('secrets/v1'))
      router.service(SecretsService, {
        list: (_request, context) =>
          unary(
            'secrets/v1',
            'list',
            [],
            context,
            ListResponseSchema,
            (answer) => ({ credentials: answer }),
          ),
        create: (request, context) =>
          unary(
            'secrets/v1',
            'create',
            decode(CreateRequestSchema, request),
            context,
            CreateResponseSchema,
            (answer) => ({ credentialDescription: answer }),
          ),
        update: ({ ref, update }, context) =>
          unary(
            'secrets/v1',
            'update',
            [
              { id: ref?.id ?? '' },
              update === undefined
                ? {}
                : decode(CredentialUpdateSchema, update),
            ],
            context,
            UpdateResponseSchema,
            (answer) => ({ credentialDescription: answer }),
          ),
        delete: ({ credentialRef }, context) =>
          unary(
            'secrets/v1',
            'delete',
            { id: credentialRef?.id ?? '' },
            context,
            DeleteResponseSchema,
            (answer) => ({ result: answer }),
          ),
      });
  };

  const router = createConnectRouter();
  routes(router);
  const handle = createUniversalHandlerClient(router.handlers);

  return {
    request: async ({ path, headers, body }): Promise<ConnectReply> => {
      const unaryAnswer = await handle({
        url: `http://doric.window${path}`,
        method: 'POST',
        header: new Headers(headers as [string, string][]),
        body: (async function* () {
          yield body;
        })(),
        signal: new AbortController().signal,
      });
      const parts: Uint8Array[] = [];
      if (unaryAnswer.body !== undefined)
        for await (const part of unaryAnswer.body) parts.push(part);
      return {
        status: unaryAnswer.status,
        headers: [...unaryAnswer.header] as [string, string][],
        body: new Uint8Array(Buffer.concat(parts)),
      };
    },
  };
};
