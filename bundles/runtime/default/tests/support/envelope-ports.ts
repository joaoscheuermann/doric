import {
  type HookHandle,
  LogV1,
  ModelsV1,
  type RegisteredTool,
  type Services,
  SkillsV1,
  ToolsV1,
} from 'bundle/contracts';
import { ConfigurationV1 } from 'host-config/contracts';
import type { LlmProvider } from 'llms';
import { RuntimeLeaseV1, RuntimeWorkspaceV1 } from 'runtime/contracts';
import { type BoundTool, isBoundTool } from 'tool';

import {
  type DefaultHooksV1,
  SkillSourcesV1,
} from '../../src/contracts/index.js';
import type {
  BeforeModelRequest,
  DefaultPorts,
  SkillSource,
} from '../../src/host/ports.js';

/*
 * The envelope-to-ports adapter of `default`'s envelope test worlds (S68d,
 * Q-F1): `DefaultPorts` over envelope `Services`, as the kernel entry built
 * them. It moved here from `src/host/ports.ts` with the kernel entry, keeping
 * its signatures; it goes with the envelope in phase 6.
 */

/** The id of the working directory's skills (`cwd/<name>`): no source takes it. */
const WORKSPACE_SOURCE_ID = 'cwd';

/** The tools of the prompt's generation; each must be one `defineTool` bound. */
const boundTools = (tools: readonly RegisteredTool[]): readonly BoundTool[] =>
  tools.map(({ tool }) => {
    if (!isBoundTool(tool))
      throw new TypeError(
        `Tool "${tool.name}" was not defined with defineTool.`,
      );
    return tool;
  });

/**
 * The envelope calls as ports: `ConfigurationV1.current(call).configuration`, `LogV1`, `boundTools(ToolsV1.list(call))`
 * (a tool not made by `defineTool` rejects with a `TypeError`), `ModelsV1.resolve(...).languageModel`,
 * `ModelsV1.inputModalities`, `SkillsV1`, `RuntimeLeaseV1`, `RuntimeWorkspaceV1.cwd`, `whenAvailable(SkillSourcesV1)`
 * read once per call. `images(session)`: `session.attachment` as `{name, imageUrl: 'data:<mediaType>;base64,<bytes>'}`,
 * `undefined` without `attachment`. Building it makes no call.
 */
export const kernelPorts = (services: Services): DefaultPorts => ({
  configuration: async (call) =>
    (await services.use(ConfigurationV1).current(call)).configuration,
  log: {
    warn: (message, fields, call) => {
      try {
        const logged: unknown = services.use(LogV1).warn(message, fields, call);
        // A log that fails changes nothing for its caller.
        if (logged instanceof Promise) logged.catch(() => undefined);
      } catch {
        // A log that fails changes nothing for its caller.
      }
    },
  },
  // `list` answers a promise when tools/v1 is in another process.
  tools: async (call) => boundTools(await services.use(ToolsV1).list(call)),
  languageModel: async (request, call) =>
    (await services.use(ModelsV1).resolve(request, call))
      .languageModel as unknown as LlmProvider,
  inputModalities: async (request, call) =>
    services.use(ModelsV1).inputModalities(request, call),
  skills: { list: async (call) => services.use(SkillsV1).list(call) },
  lease: {
    describe: async (call) => services.use(RuntimeLeaseV1).describe(call),
    exec: async (input, call) => services.use(RuntimeLeaseV1).exec(input, call),
    readFile: async (path, call) =>
      services.use(RuntimeLeaseV1).readFile(path, call),
  },
  cwd: async (call) => services.use(RuntimeWorkspaceV1).cwd(call),
  skillSources: () => {
    const found: SkillSource[] = [];
    services
      .whenAvailable(SkillSourcesV1, (api, { bundleId }) => {
        if (bundleId !== WORKSPACE_SOURCE_ID) found.push({ bundleId, api });
      })
      .dispose();
    return Promise.resolve(found);
  },
  images: (session) => {
    const attachment = session.attachment?.bind(session);
    if (attachment === undefined) return undefined;
    return async (id) => {
      const content = await attachment(id);
      return content === undefined
        ? undefined
        : {
            name: content.name,
            imageUrl: `data:${content.mediaType};base64,${content.bytes}`,
          };
    };
  },
});

/** `hooks.onBeforeModelRequestHook.execute({system}, call)`'s `system`. */
export const kernelBeforeModelRequest =
  (hooks: HookHandle<typeof DefaultHooksV1>): BeforeModelRequest =>
  async (system, call) =>
    (await hooks.onBeforeModelRequestHook.execute({ system }, call)).system;
