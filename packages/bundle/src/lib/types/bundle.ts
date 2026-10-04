import type { ToolFactory } from 'tool';

import type { SkillRecord } from '../schemas/skill.js';

export interface BundleManifestTool {
  readonly path: string;
  readonly alwaysAvailable: boolean;
}

export interface BundleManifestSkill {
  readonly path: string;
  readonly alwaysAvailable: boolean;
}

export interface BundleManifest {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly BundleManifestTool[];
  readonly skills: readonly BundleManifestSkill[];
}

export interface BundleTool {
  readonly factory: ToolFactory;
  readonly alwaysAvailable: boolean;
}

/** Alias preserved for current catalog consumers. */
export type Skill = SkillRecord;

export interface BundleSkill {
  readonly skill: Skill;
  readonly alwaysAvailable: boolean;
}

export interface Bundle {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly BundleTool[];
  readonly skills: readonly BundleSkill[];
}
