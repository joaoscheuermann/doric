import type { ToolFactory } from 'tool';

import type { SkillRecord } from '../schemas/skill.js';

export type BundleManifestTool = {
  readonly path: string;
  readonly alwaysAvailable: boolean;
};

export type BundleManifestSkill = {
  readonly path: string;
  readonly alwaysAvailable: boolean;
};

export type BundleManifest = {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly BundleManifestTool[];
  readonly skills: readonly BundleManifestSkill[];
};

export type BundleTool = {
  readonly factory: ToolFactory;
  readonly alwaysAvailable: boolean;
};

/** Alias preserved for current catalog consumers. */
export type Skill = SkillRecord;

export type BundleSkill = {
  readonly skill: Skill;
  readonly alwaysAvailable: boolean;
};

export type Bundle = {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly BundleTool[];
  readonly skills: readonly BundleSkill[];
};
