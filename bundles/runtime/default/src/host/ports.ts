import type { Call, Log, ModelRequest, Models, Skills } from 'bundle/contracts';
import type { ConfigurationValue } from 'host-config/contracts';
import type { LlmProvider } from 'llms';
import type { PromptSession, RuntimeLease } from 'runtime/contracts';
import type { BoundTool } from 'tool';

import type { SkillSources } from '../contracts/index.js';

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
