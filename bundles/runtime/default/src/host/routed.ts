// `default`'s ports over the router (phase 3, slice S51d): what the executor,
// the compaction, the skills and the agents read outside `default`, as
// `context.services` calls made inside a handler call.

import { create, toJson } from '@bufbuild/protobuf';
import { anyPack, anyUnpack } from '@bufbuild/protobuf/wkt';
import { ContractError } from 'bundle/contracts';
import { HooksService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { ModelsService } from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import { CatalogService } from 'bundle/contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import { SkillsService } from 'bundle/contracts/gen/doric/skills/v1/skills_pb.js';
import { ToolsService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import type { HostContext } from 'bundle/host';
import { configurationValueSchema } from 'host-config/contracts';
import { ConfigurationValueSchema } from 'host-config/contracts/gen/doric/host_config/configuration/v1/configuration_pb.js';
import { HostConfigService } from 'host-config/contracts/gen/doric/host_config/v1/host_config_pb.js';
import { attachmentImageUrl, modelsLanguageModel } from 'llms/rpc';
import type { PromptSession, RemotePromptSession } from 'runtime/contracts';
import { LeaseService } from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import { WorkspaceService } from 'runtime/contracts/gen/doric/runtime/workspace/v1/workspace_pb.js';

import { OnBeforeModelRequestHookInputSchema } from '../contracts/gen/doric/default/hooks/v1/hooks_pb.js';
import { SkillSourcesService } from '../contracts/gen/doric/default/skill_sources/v1/skill_sources_pb.js';
import type { SkillSources } from '../contracts/index.js';
import type { BeforeModelRequest, DefaultPorts, SkillSource } from './ports.js';
import { called, routedTools } from './routed-tools.js';

/** The contract `default`'s hooks belong to. */
export const DEFAULT_HOOKS = 'default.hooks/v1';
/** The contract of the skill sources. */
const SKILL_SOURCES = 'default.skill-sources/v1';
/** The skill source the run reads itself (the working directory's skills). */
const WORKSPACE_SOURCE_ID = 'cwd';

/** Whether `session` is a session of `executor.session/v1` (it describes attachments). */
const isRemoteSession = (
  session: PromptSession,
): session is RemotePromptSession =>
  typeof (session as Partial<RemotePromptSession>).describeAttachment ===
  'function';

/** `default.skill-sources/v1` of provider `bundleId`, over the router. */
const routedSkillSource = (
  services: HostContext['services'],
  bundleId: string,
): SkillSources => {
  const client = () =>
    services.use(SkillSourcesService, { provider: bundleId });

  return {
    list: async ({ cwd }) => {
      const { skills } = await called(client().list({ cwd }));
      return {
        skills: skills.map(({ group, name, description, reference }) => ({
          ...(group === undefined ? {} : { group }),
          name,
          description,
          reference,
        })),
      };
    },
    read: async ({ reference }) => {
      const { origin, text } = await called(client().read({ reference }));
      return origin === undefined ? { text } : { origin, text };
    },
  };
};

/**
 * `DefaultPorts` over `context.services`; every call is made inside a handler call, so it inherits the `Run` or
 * `Compact` handler's scope (the prompt's `{projectId, threadId, promptId}` for `executor/v1`), deadline, trace and
 * signal; the handler's signal aborts only when that call ends. A cancellation through the session reaches the model
 * stream (the agent's `request.signal`) and the tool calls (`call.signal`, `routed-tools.ts`); the other port calls
 * (configuration, skills, lease, hooks) finish. Makes no call
 * until a port is used. A routed failure rejects as `fromConnectError` reads it (a `ContractError`).
 * - `configuration`: `host-config/v1.Current{}`'s `doricConfiguration.configuration`, as JSON
 *   (`toJson(…, {alwaysEmitImplicit: true})`) parsed with today's schema; absent → `invalid_output`.
 * - `log`: `context.log` (`call` ignored).
 * - `tools`: `routedTools(use(ToolsService))` (`routed-tools.ts`).
 * - `languageModel(request)`: `models/v1.Resolve{providerId, model, effort?}` (fails as `resolve` did), then
 *   `modelsLanguageModel(use(ModelsService), providerId)`.
 * - `inputModalities`: `models/v1.InputModalities`; `known: false` or a failure → `undefined`.
 * - `skills.list`: `skills/v1.List` as `RegisteredSkill`s (`skill` as JSON, `order` only when set).
 * - `lease`: `runtime.lease/v1` `Describe`/`Exec`/`ReadFile` with an empty `LeaseTarget` (the prompt's bound
 *   sandbox, else the scope's Project); `exitCode` absent → `null`; `ReadFile` → `response.content`.
 * - `cwd`: `runtime.workspace/v1.Cwd{}`'s `cwd`.
 * - `skillSources`: `doric.catalog/v1.Get` once per use; the host contract `default.skill-sources/v1`'s providers
 *   whose bundle is `active`, in provider order, minus `cwd`; each `api` calls `use(SkillSourcesService, {provider:
 *   bundleId})` (`List{cwd}`, `Read{reference}`, answers as today's JSON). A failed `Get` → `[]`.
 * - `images(session)`: for a `RemotePromptSession`, `describeAttachment(id)` as `{name, imageUrl:
 *   attachmentImageUrl({id, mediaType, name})}`; `undefined` for any other session. Never reads bytes.
 */
export const routedPorts = (
  context: Pick<HostContext, 'services' | 'log'>,
): DefaultPorts => {
  const { services } = context;
  const models = () => services.use(ModelsService);
  const lease = () => services.use(LeaseService);

  return {
    configuration: async () => {
      const { doricConfiguration } = await called(
        services.use(HostConfigService).current({}),
      );
      const configuration = doricConfiguration?.configuration;
      if (configuration === undefined) {
        throw new ContractError(
          'invalid_output',
          'host-config/v1.Current answered no configuration.',
        );
      }
      return configurationValueSchema.parse(
        toJson(ConfigurationValueSchema, configuration, {
          alwaysEmitImplicit: true,
        }),
      );
    },
    log: context.log,
    tools: () => routedTools(services.use(ToolsService)),
    languageModel: async ({ providerId, model, effort }) => {
      await called(
        models().resolve({
          providerId,
          model,
          ...(effort === undefined ? {} : { effort }),
        }),
      );
      return modelsLanguageModel(models(), providerId);
    },
    inputModalities: async ({ providerId, model }) => {
      try {
        const { known, inputModalities } = await models().inputModalities({
          ...(providerId === undefined ? {} : { providerId }),
          model,
        });
        return known ? inputModalities : undefined;
      } catch {
        return undefined;
      }
    },
    skills: {
      list: async () => {
        const { skills } = await called(services.use(SkillsService).list({}));
        return skills.map(({ bundleId, alwaysAvailable, order, skill }) => ({
          bundleId,
          alwaysAvailable,
          ...(order === undefined ? {} : { order }),
          skill: {
            name: skill?.name ?? '',
            description: skill?.description ?? '',
            body: skill?.body ?? '',
            allowedTools: [...(skill?.allowedTools ?? [])],
            indexText: skill?.indexText ?? '',
          },
        }));
      },
    },
    lease: {
      describe: async () => {
        const { id, root } = await called(lease().describe({ target: {} }));
        return { id, root };
      },
      exec: async ({ cmd, cwd, env, user, timeoutMs, tty }) => {
        const { response } = await called(
          lease().exec({
            target: {},
            request: {
              cmd: [...cmd],
              ...(cwd === undefined ? {} : { cwd }),
              env: [...(env ?? [])],
              ...(user === undefined ? {} : { user }),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
              ...(tty === undefined ? {} : { tty }),
            },
          }),
        );
        return {
          exitCode: response?.exitCode ?? null,
          stdout: response?.stdout ?? '',
          stderr: response?.stderr ?? '',
        };
      },
      readFile: async (path) => {
        const { response } = await called(
          lease().readFile({ target: {}, request: { path } }),
        );
        return response?.content ?? '';
      },
    },
    cwd: async () => (await called(services.use(WorkspaceService).cwd({}))).cwd,
    skillSources: async () => {
      const catalog = await services
        .use(CatalogService)
        .get({})
        .then(
          ({ catalogSnapshot }) => catalogSnapshot,
          () => undefined,
        );
      if (catalog === undefined) return [];
      const active = new Set(
        catalog.bundles
          .filter(({ state }) => state === 'active')
          .map(({ id }) => id),
      );
      const providers =
        catalog.contracts.find(({ id }) => id === SKILL_SOURCES)?.providers ??
        [];

      return providers
        .filter(
          ({ bundleId }) =>
            active.has(bundleId) && bundleId !== WORKSPACE_SOURCE_ID,
        )
        .map(
          ({ bundleId }): SkillSource => ({
            bundleId,
            api: routedSkillSource(services, bundleId),
          }),
        );
    },
    images: (session) => {
      if (!isRemoteSession(session)) return undefined;
      return async (id) => {
        const attachment = await session.describeAttachment(id);
        return attachment === undefined
          ? undefined
          : {
              name: attachment.name,
              imageUrl: attachmentImageUrl({
                id: attachment.id,
                mediaType: attachment.mediaType,
                name: attachment.name,
              }),
            };
      };
    },
  };
};

/**
 * `hooks/v1.Run{contract: 'default.hooks/v1', hook: 'onBeforeModelRequestHook', input:
 * anyPack(OnBeforeModelRequestHookInput{system})}`; answers the unpacked `output`'s `system`, or `system` when no
 * `output` came. Rejects with the `Run` call's failure (a model request then fails, as a rejecting kernel hook does).
 */
export const routedBeforeModelRequest =
  (context: Pick<HostContext, 'services'>): BeforeModelRequest =>
  async (system) => {
    const { output } = await called(
      context.services.use(HooksService).run({
        contract: DEFAULT_HOOKS,
        hook: 'onBeforeModelRequestHook',
        input: anyPack(
          OnBeforeModelRequestHookInputSchema,
          create(OnBeforeModelRequestHookInputSchema, { system }),
        ),
      }),
    );
    if (output === undefined) return system;
    return (
      anyUnpack(output, OnBeforeModelRequestHookInputSchema)?.system ?? system
    );
  };
