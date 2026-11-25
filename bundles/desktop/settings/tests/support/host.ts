// The host contracts the settings adapter reaches, as fakes with the
// contracts' own shapes: the boundary of these tests is the contract, so each
// fake answers what the host's provider would and records what it was asked.
// From slice S65c the adapter reaches them over Connect — `HostConfigService`,
// `ModelsService`, `ToolsService` and `SecretsService` — through a fake
// `HostClients` (`./connect.ts`): a test still answers in today's shapes,
// each request is read back as today's input and each answer written as the
// wire's message with the host's codec (`runtime/contracts`' `encode` and
// `decode`).

import {
  type DescMessage,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import {
  type CatalogResult,
  ContractError,
  type CredentialCreate,
  type CredentialDescription,
  type CredentialRef,
  type CredentialUpdate,
  type ModelIconAnswers,
  type ModelIconRequest,
  type ModelKindDescriptor,
  type ToolCatalogEntry,
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
import {
  CurrentResponseSchema,
  HostConfigService,
  ReplaceResponseSchema,
} from 'host-config/contracts/gen/doric/host_config/v1/host_config_pb.js';
import type {
  ConfigReplaceResult,
  DoricConfiguration,
} from 'runtime/contracts';
import { decode, encode } from 'runtime/contracts';

import {
  createSettingsApi,
  type SettingsApi,
} from '../../src/client/api/settings-api.js';
import {
  connectFailure,
  fakeClientServices,
  fakeHostClients,
  type HostCall,
} from './connect.js';

export interface FakeHost {
  current?: () => DoricConfiguration | Promise<DoricConfiguration>;
  replace?: (
    input: unknown,
  ) => ConfigReplaceResult | Promise<ConfigReplaceResult>;
  kinds?: () => readonly ModelKindDescriptor[];
  /**
   * The kinds as an older or foreign host sends them, past the descriptor
   * schema of this platform, which no provider here may answer: the adapter
   * reads them as sent, and only its own checks meet them. Over Connect a
   * kind is a `ModelKindDescriptor` message, so a `site` that is not an
   * object (`'x'`) cannot travel and arrives absent.
   */
  foreignKinds?: () => readonly unknown[];
  kind?: (id: string) => ModelKindDescriptor | undefined;
  catalog?: (input: {
    kind: string;
    configuration: Readonly<Record<string, string>>;
  }) => CatalogResult;
  icons?: (input: {
    readonly requests: readonly ModelIconRequest[];
  }) => ModelIconAnswers;
  tools?: () => readonly ToolCatalogEntry[];
  list?: () => readonly CredentialDescription[];
  create?: (input: CredentialCreate) => CredentialDescription;
  update?: (
    ref: CredentialRef,
    input: CredentialUpdate,
  ) => CredentialDescription;
  delete?: (ref: CredentialRef) => 'deleted' | 'missing' | 'referenced';
}

const unanswered = (): never => {
  throw new Error('The fake host was not given this answer.');
};

/**
 * Runs `answer` and writes today's answer as the message of `schema`; a
 * failure fails the call as the host sends it (`connectFailure`).
 */
const answered = async <D extends DescMessage>(
  schema: D,
  answer: () => unknown,
): Promise<MessageShape<D>> => {
  try {
    return encode(schema, await answer());
  } catch (error) {
    throw connectFailure(error);
  }
};

/** A request message as today's JSON. */
const json = <D extends DescMessage>(
  schema: D,
  message: MessageShape<D>,
): Record<string, unknown> =>
  decode(schema, message) as Record<string, unknown>;

/** A foreign kind as the wire carries it: a `site` that is not an object is dropped. */
const wireKind = (kind: unknown): unknown => {
  const { site, ...rest } = kind as { readonly site?: unknown };

  return typeof site === 'object' && site !== null ? { ...rest, site } : rest;
};

/**
 * The host services of `host`, over Connect: `HostConfigService`,
 * `ModelsService` (Kinds, Kind, Catalog, Icons), `ToolsService.Catalog` and
 * `SecretsService` (List, Create, Update, Delete). An icon-less model travels
 * as `""`, as the core's `Icons` sends it.
 */
export const settingsHostClients = (host: FakeHost) =>
  fakeHostClients((router) => {
    router.service(HostConfigService, {
      current: () =>
        answered(CurrentResponseSchema, async () => ({
          doricConfiguration: await (host.current ?? unanswered)(),
        })),
      replace: ({ input }) =>
        answered(ReplaceResponseSchema, () =>
          (host.replace ?? unanswered)(
            input === undefined ? undefined : toJson(ValueSchema, input),
          ),
        ),
    });
    router.service(ModelsService, {
      kinds: () =>
        answered(KindsResponseSchema, () => ({
          kinds:
            host.foreignKinds === undefined
              ? [...(host.kinds ?? unanswered)()]
              : host.foreignKinds().map(wireKind),
        })),
      kind: ({ id }) =>
        answered(KindResponseSchema, () => {
          const kind = (host.kind ?? unanswered)(id);

          return kind === undefined ? {} : { modelKindDescriptor: kind };
        }),
      catalog: ({ kind, configuration }) =>
        answered(CatalogResponseSchema, () => ({
          catalogResult: (host.catalog ?? unanswered)({
            kind,
            configuration: { ...configuration },
          }),
        })),
      icons: (request) =>
        answered(IconsResponseSchema, () => {
          const answer = (host.icons ?? unanswered)(
            json(IconsRequestSchema, request) as {
              readonly requests: readonly ModelIconRequest[];
            },
          );

          return {
            ...answer,
            answers: answer.answers.map((each) => ({
              ...each,
              models: each.models.map((name) => name ?? ''),
            })),
          };
        }),
    });
    router.service(ToolsService, {
      catalog: () =>
        answered(ToolCatalogResponseSchema, () => ({
          entries: [...(host.tools ?? unanswered)()],
        })),
    });
    router.service(SecretsService, {
      list: () =>
        answered(ListResponseSchema, () => ({
          credentials: [...(host.list ?? unanswered)()],
        })),
      create: (request) =>
        answered(CreateResponseSchema, () => ({
          credentialDescription: (host.create ?? unanswered)(
            json(CreateRequestSchema, request) as unknown as CredentialCreate,
          ),
        })),
      update: ({ ref, update }) =>
        answered(UpdateResponseSchema, () => ({
          credentialDescription: (host.update ?? unanswered)(
            { id: ref?.id ?? '' },
            (update === undefined
              ? {}
              : json(CredentialUpdateSchema, update)) as CredentialUpdate,
          ),
        })),
      delete: ({ credentialRef }) =>
        answered(DeleteResponseSchema, () => ({
          result: (host.delete ?? unanswered)({ id: credentialRef?.id ?? '' }),
        })),
    });
  });

/**
 * The settings adapter over fake host services, as the settings part's
 * window services answer it: a host contract's generated descriptor over
 * Connect; `calls` are the part's host calls, in order.
 */
export const settingsOver = async (
  host: FakeHost,
  run: (api: SettingsApi, calls: readonly HostCall[]) => Promise<void>,
): Promise<void> => {
  const { hostClients, calls } = settingsHostClients(host);
  const { services } = fakeClientServices({
    bundleId: 'settings',
    hostClients,
  });

  await run(createSettingsApi(services), calls);
};

/** Whether `cause` is the contract error `expected` names, or both are none. */
const sameCause = (
  cause: unknown,
  expected: { readonly code: string; readonly message: string } | undefined,
): boolean =>
  expected === undefined
    ? cause === undefined
    : cause instanceof ContractError &&
      cause.code === expected.code &&
      cause.message === expected.message;

/**
 * The settings adapter's rejection (error-messages.md §6.4): a
 * `SettingsApiError` (name kept) carrying `code`, the unchanged `message`, and
 * `cause` — the contract error the host answered, or none (`undefined`).
 * Over Connect the cause is the contract error the client read
 * (`fromConnectError`): the host's code and message, not its instance.
 */
export const settingsError =
  (expected: {
    readonly code: string;
    readonly message: string;
    /** The contract error the host answered (its code and message), or none. */
    readonly cause:
      | { readonly code: string; readonly message: string }
      | undefined;
  }) =>
  (error: unknown): boolean => {
    if (!(error instanceof Error)) {
      throw new Error(`Rejected with a non-error: ${String(error)}`);
    }
    const { code } = error as Error & { readonly code?: unknown };
    if (
      error.name !== 'SettingsApiError' ||
      code !== expected.code ||
      error.message !== expected.message ||
      !sameCause(error.cause, expected.cause)
    ) {
      throw new Error(
        `Expected SettingsApiError ${expected.code} "${expected.message}" ` +
          `(cause ${expected.cause === undefined ? 'none' : 'the contract error'}), ` +
          `got ${error.name} ${String(code)} "${error.message}" ` +
          `(cause ${error.cause === undefined ? 'none' : sameCause(error.cause, expected.cause) ? 'the contract error' : String(error.cause)})`,
      );
    }
    return true;
  };

/** Whether a rejection shows exactly `message`, the text a surface renders. */
export const showing =
  (message: string) =>
  (error: unknown): boolean =>
    error instanceof Error && error.message === message;
