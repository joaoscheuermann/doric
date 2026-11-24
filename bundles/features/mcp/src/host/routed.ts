// The routed adapters of `mcp`'s host part as a process (phase 3, S59):
// `storage/v1`, `secrets/v1`, `tools/v1`, `runtime.lease/v1`,
// `runtime.attachments/v1` and `runtime/v2.Watch` over the router as
// `McpPorts`.

import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';

import { type MessageInitShape, toJson } from '@bufbuild/protobuf';
import type { Client } from '@connectrpc/connect';
import {
  ContractError,
  type CredentialDescription,
  credentialDescriptionSchema,
  type Disposable,
  secretSchema,
} from 'bundle/contracts';
import {
  type CredentialDescription as CredentialDescriptionMessage,
  CredentialDescriptionSchema,
  SecretSchema,
  SecretsService,
} from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { StorageService } from 'bundle/contracts/gen/doric/storage/v1/storage_pb.js';
import { ToolsService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import {
  contractErrorOf,
  type HostContext,
  type HostServices,
  resumableDelays,
  type ToolHandlers,
} from 'bundle/host';
import { attachmentSchema } from 'runtime/contracts';
import {
  AttachmentsService,
  type AttachRequestSchema,
} from 'runtime/contracts/gen/doric/runtime/attachments/v1/attachments_pb.js';
import { RuntimeService } from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';
import { type StorageClient, storageClient } from 'storage/rpc';

import { routedMcpLease } from './lease.js';
import type { McpAttach, McpPorts, McpSecrets, McpTools } from './ports.js';
import { mcpToolDefinition } from './tools.js';

/** The asynchronous context at load: outside every handler's call. */
const outside = AsyncLocalStorage.snapshot();

/** Runs `work` outside every handler's call (the context at load), as `papercraft`'s. */
export const detached = <T>(work: () => T): T => outside(work);

/** Runs `work`, rethrowing a routed call's failure as its `ContractError`. */
const routed = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw contractErrorOf(error);
  }
};

/** A failure's message, for a log line. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The largest `Attach` chunk (1 MiB). */
const ATTACH_CHUNK_BYTES = 1_048_576;

/** Standard base64, padded. */
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** A `CredentialDescription` message as today's shape (absent optionals left out). */
const descriptionOf = (
  description: CredentialDescriptionMessage,
): CredentialDescription =>
  credentialDescriptionSchema.parse(
    toJson(CredentialDescriptionSchema, description, {
      alwaysEmitImplicit: true,
    }),
  );

/** A written credential's answer, or `invalid_output` when there is none. */
const writtenOf = (
  description: CredentialDescriptionMessage | undefined,
  method: string,
): CredentialDescription => {
  if (description === undefined) {
    throw new ContractError(
      'invalid_output',
      `secrets/v1.${method} answered no credential.`,
    );
  }

  return descriptionOf(description);
};

/**
 * `McpSecrets` over `SecretsService`; clients created on first use; failures reject with `contractErrorOf`'s
 * `ContractError` (codes and details kept). `describe(ref, call?)` runs in the current context when `call` is given,
 * else `detached`; the others always `detached` (their `call` argument is ignored). Shapes: `Resolve` → `Secret`
 * (absent `username`/`email`/`secret` omitted); `Describe` → the description or `undefined`; `Create`/`Update` →
 * `CredentialWrite` (`Update` sends only the fields given; `null` clears as `''`); `Delete` → its `result`; `List` →
 * the descriptions in order.
 */
export const routedSecrets = (
  services: Pick<HostServices, 'use'>,
): McpSecrets => {
  let client: Client<typeof SecretsService> | undefined;
  const secrets = () => (client ??= services.use(SecretsService));
  const outsideCall = <T>(work: () => Promise<T>): Promise<T> =>
    detached(() => routed(work));

  return {
    resolve: (ref) =>
      outsideCall(async () => {
        const { secret } = await secrets().resolve({
          credentialRef: { id: ref.id },
        });

        if (secret === undefined) {
          throw new ContractError(
            'invalid_output',
            'secrets/v1.Resolve answered no secret.',
          );
        }

        return secretSchema.parse(
          toJson(SecretSchema, secret, { alwaysEmitImplicit: true }),
        );
      }),
    describe: (ref, call) => {
      const work = async () => {
        const { credentialDescription } = await secrets().describe({
          credentialRef: { id: ref.id },
        });

        return credentialDescription === undefined
          ? undefined
          : descriptionOf(credentialDescription);
      };

      return call === undefined ? outsideCall(work) : routed(work);
    },
    create: (input) =>
      outsideCall(async () => {
        const { credentialDescription } = await secrets().create({
          kind: input.kind,
          name: input.name,
          username: input.username,
          email: input.email,
          secret: input.secret,
        });

        return writtenOf(credentialDescription, 'Create');
      }),
    update: (ref, input) =>
      outsideCall(async () => {
        const cleared = (value: string | null | undefined) =>
          value === null ? '' : value;
        const { credentialDescription } = await secrets().update({
          ref: { id: ref.id },
          update: {
            kind: input.kind,
            name: input.name,
            username: cleared(input.username),
            email: cleared(input.email),
            secret: cleared(input.secret),
          },
        });

        return writtenOf(credentialDescription, 'Update');
      }),
    delete: (ref) =>
      outsideCall(async () => {
        const { result } = await secrets().delete({
          credentialRef: { id: ref.id },
        });

        if (
          result !== 'deleted' &&
          result !== 'missing' &&
          result !== 'referenced'
        ) {
          throw new ContractError(
            'invalid_output',
            `Unknown delete result "${result}".`,
          );
        }

        return result;
      }),
    list: () =>
      outsideCall(async () =>
        (await secrets().list({})).credentials.map(descriptionOf),
      ),
  };
};

/**
 * `McpTools` over the SDK table (D3): `register(source, projectId)` = `detached(() => tools.register(context,
 * mcpToolDefinition(source).bind({attach: routedAttach(services)}), {alwaysAvailable: false, order: 1000,
 * projectId}))`; its registration's `dispose()` calls `unregister()` without awaiting, a rejection logged at `warn`.
 * `listed(projectId)` = `ToolsService.List{}` with scope `{projectId}`, `detached`, the names of `tools[].tool`.
 */
export const routedTools = (
  context: Pick<HostContext, 'services' | 'registrations' | 'log'>,
  tools: ToolHandlers,
): McpTools => {
  const attach = routedAttach(context.services);

  return {
    register: (source, projectId) =>
      detached(async () => {
        const registration = await tools.register(
          context,
          mcpToolDefinition(source).bind({ attach }),
          { alwaysAvailable: false, order: 1000, projectId },
        );

        return {
          dispose: () => {
            registration.unregister().catch((error: unknown) => {
              context.log.warn(
                `Could not unregister the tool ${source.name}.`,
                {
                  error: messageOf(error),
                },
              );
            });
          },
        };
      }),
    listed: (projectId) =>
      detached(() =>
        routed(async () => {
          const { tools: listed } = await context.services
            .use(ToolsService, { scope: { projectId } })
            .list({});
          const names = new Set<string>();
          for (const { tool } of listed) {
            if (tool !== undefined) names.add(tool.name);
          }

          return names;
        }),
      ),
  };
};

/**
 * `McpAttach` over `AttachmentsService.Attach` in the current context (the tool's `Execute` call: its scope holds the
 * Thread): `head{name}`, then the base64-decoded bytes in chunks of at most 1 MiB; answers `{id, name, mediaType,
 * size}`. Rejects with the provider's `ContractError` (`invalid_input` for bytes it refuses) or `invalid_input`,
 * calling nothing, when `input.bytes` is not base64.
 */
export const routedAttach =
  (services: Pick<HostServices, 'use'>): McpAttach =>
  (input) => {
    if (!BASE64.test(input.bytes)) {
      return Promise.reject(
        new ContractError(
          'invalid_input',
          'An attachment needs its bytes as base64.',
        ),
      );
    }

    const bytes = new Uint8Array(Buffer.from(input.bytes, 'base64'));
    const items: MessageInitShape<typeof AttachRequestSchema>[] = [
      { item: { case: 'head', value: { name: input.name } } },
    ];
    for (let at = 0; at < bytes.length; at += ATTACH_CHUNK_BYTES) {
      items.push({
        item: {
          case: 'chunk',
          value: bytes.subarray(at, at + ATTACH_CHUNK_BYTES),
        },
      });
    }

    return routed(async () => {
      async function* requests() {
        yield* items;
      }
      const { attachment } = await services
        .use(AttachmentsService)
        .attach(requests());

      if (attachment === undefined) {
        throw new ContractError(
          'invalid_output',
          'runtime.attachments/v1.Attach answered no attachment.',
        );
      }

      return attachmentSchema.parse({
        id: attachment.id,
        name: attachment.name,
        mediaType: attachment.mediaType,
        size: attachment.size,
      });
    });
  };

/**
 * Every `McpPorts` member over the router, `detached` except as stated above: `storage` = `storageClient(use(
 * StorageService), {registrations})` with each method `detached`; `secrets` = `routedSecrets`; `tools` = `routedTools`;
 * `lease` = `routedMcpLease`; `log` = `() => context.log`. Also answers the storage client, whose `settled()`
 * `activate` awaits.
 */
export const routedMcpPorts = (
  context: Pick<HostContext, 'services' | 'registrations' | 'log'>,
  tools: ToolHandlers,
): { readonly ports: McpPorts; readonly storage: StorageClient } => {
  const storage = storageClient(context.services.use(StorageService), {
    registrations: context.registrations,
  });

  return {
    ports: {
      storage: {
        get: (...args) => detached(() => storage.get(...args)),
        query: (...args) => detached(() => storage.query(...args)),
        commit: (...args) => detached(() => storage.commit(...args)),
      },
      secrets: routedSecrets(context.services),
      tools: routedTools(context, tools),
      lease: routedMcpLease(context.services),
      log: () => context.log,
    },
    storage,
  };
};

/**
 * Opens `runtime/v2.Watch` `detached` and calls `onDeleted(projectId)` for each `projectDeleted` item, in order,
 * awaiting none (D7). An opening that ends, cleanly or with an error, is opened again after 5 s; an error other than the
 * dispose's cancel is first logged at `warn`. `dispose()` cancels the open stream and any pending reopening, so nothing
 * opens after it. Never throws.
 */
export const watchProjectDeletions = (
  context: Pick<HostContext, 'services' | 'log'>,
  onDeleted: (projectId: string) => void,
): Disposable => {
  const controller = new AbortController();
  let reopening: ReturnType<typeof setTimeout> | undefined;

  const open = (): void => {
    if (controller.signal.aborted) return;

    detached(() => {
      void (async () => {
        try {
          const notices = context.services
            .use(RuntimeService)
            .watch({}, { signal: controller.signal });

          for await (const { notice } of notices) {
            if (notice.case === 'projectDeleted') {
              onDeleted(notice.value.projectId);
            }
          }
        } catch (error) {
          if (controller.signal.aborted) return;

          context.log.warn(
            'runtime/v2.Watch failed; opening it again in 5 s.',
            { error: messageOf(error) },
          );
        }

        if (controller.signal.aborted) return;

        reopening = setTimeout(() => {
          reopening = undefined;
          open();
        }, resumableDelays.maxMs);
      })();
    });
  };

  open();

  return {
    dispose: () => {
      controller.abort();
      if (reopening !== undefined) clearTimeout(reopening);
      reopening = undefined;
    },
  };
};
