import {
  type Call,
  type HookHandle,
  type Log,
  LogV1,
  type ModelRequest,
  type Models,
  ModelsV1,
  type RegisteredTool,
  type Services,
  type Skills,
  SkillsV1,
  ToolsV1,
} from 'bundle/contracts';
import {
  ConfigurationV1,
  type ConfigurationValue,
} from 'host-config/contracts';
import type { LlmProvider } from 'llms';
import {
  type PromptSession,
  type RuntimeLease,
  RuntimeLeaseV1,
  RuntimeWorkspaceV1,
} from 'runtime/contracts';
import { type BoundTool, isBoundTool } from 'tool';

import {
  type DefaultHooksV1,
  type SkillSources,
  SkillSourcesV1,
} from '../contracts/index.js';

/** One provider of `default.skill-sources/v1` (moved from `skills/sources.ts`, which re-exports it). */
export interface SkillSource {
  readonly bundleId: string;
  readonly api: SkillSources;
}

/** One image a model request carries in place of a reference line. */
export interface ResolvedImage {
  /** The attachment's name, for the `[Image: <name>]` text before it. */
  readonly name: string;
  /** What the image part's `imageUrl` is: a `data:` URL in process, an `attachmentImageUrl` over the router. */
  readonly imageUrl: string;
}

/** The image of attachment `id` of the Thread's Project; `undefined` when the Project holds none by that id. */
export type ImageReader = (id: string) => Promise<ResolvedImage | undefined>;

/**
 * What the executor, the compaction, the skills and the agents read outside `default`. Each method takes the
 * prompt's (or the handler's) `call`; the kernel ports pass it on, the routed ports leave scope, deadline and signal
 * to the SDK's current call. A method rejects with its source's failure unless it says otherwise; the callers keep
 * today's best-effort rules (a lease or cwd failure reads as "unknown", a skill source as "left out").
 */
export interface DefaultPorts {
  /** The active Doric configuration value (`host-config/v1`). */
  configuration(call: Call): Promise<ConfigurationValue>;
  /** The bundle's log; `warn` never throws and never rejects. */
  readonly log: Pick<Log, 'warn'>;
  /** The tools the call sees, in `tools/v1.List` order, each run under the call it is turned into (`toTool`). */
  tools(call: Call): Promise<readonly BoundTool[]>;
  /** The configured model `request` as an llms provider; rejects as `models/v1.Resolve` does. */
  languageModel(request: ModelRequest, call: Call): Promise<LlmProvider>;
  /** What the model reads, as its provider's catalog says; `undefined` when it does not say. Never rejects. */
  readonly inputModalities: Models['inputModalities'];
  /** The registered skills (`skills/v1.List`), in its order. */
  readonly skills: Pick<Skills, 'list'>;
  /** The prompt's (or the Project's) sandbox; any method may reject when there is none. */
  readonly lease: Pick<RuntimeLease, 'describe' | 'exec' | 'readFile'>;
  /** The calling Thread's working directory (`runtime.workspace/v1`). */
  cwd(call: Call): Promise<string>;
  /** The live providers of `default.skill-sources/v1`, provider order, without the bundle id `cwd`. Never rejects. */
  skillSources(call: Call): Promise<readonly SkillSource[]>;
  /** How a run reads the images of `session`; `undefined` when it cannot (no images are sent). */
  images(session: PromptSession): ImageReader | undefined;
}

/** The system prompt of one model request after `default.hooks/v1.onBeforeModelRequestHook`. */
export type BeforeModelRequest = (
  system: string,
  call: Call,
) => Promise<string>;

/** The subsets the skill and agent readers take (each a `Pick` of {@link DefaultPorts}). */
export type SkillPorts = Pick<
  DefaultPorts,
  'skills' | 'lease' | 'cwd' | 'skillSources' | 'log'
>;
export type SkillReadPorts = Pick<DefaultPorts, 'lease' | 'skillSources'>;
export type AgentPorts = Pick<DefaultPorts, 'lease' | 'cwd'>;

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
 * Today's kernel calls as ports: `ConfigurationV1.current(call).configuration`, `LogV1`, `boundTools(ToolsV1.list(call))`
 * (a tool not made by `defineTool` rejects with today's `TypeError`), `ModelsV1.resolve(...).languageModel`,
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
