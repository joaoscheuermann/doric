import crypto from 'node:crypto';

import {
  PLAIN_TEXT_FIELDS_VERSION,
  THREE_STAGE_PIPELINE_VERSION,
} from './constants.js';
import { EXTRACTOR_VERSION, PARSER_VERSION } from './interface.js';
import type { ModuleInterface } from './types/interface.js';
import type { OkfConfig } from './types/okf.js';

export const CONCEPT_SCHEMA_VERSION = 'okf-yaml-v1';
export const YAML_DEPENDENCY_VERSION = '2.9.0';

export type RecipeVersions = {
  readonly parser: string;
  readonly extractor: string;
  readonly yaml: string;
  readonly conceptSchema: string;
  readonly plainTextFields: string;
  readonly pipeline: string;
};

export const RECIPE_VERSIONS: RecipeVersions = {
  parser: PARSER_VERSION,
  extractor: EXTRACTOR_VERSION,
  yaml: YAML_DEPENDENCY_VERSION,
  conceptSchema: CONCEPT_SCHEMA_VERSION,
  plainTextFields: PLAIN_TEXT_FIELDS_VERSION,
  pipeline: THREE_STAGE_PIPELINE_VERSION,
};

type RecipeInput = {
  readonly config: OkfConfig;
  readonly content: string;
  readonly interface?: ModuleInterface;
  readonly path: string;
  readonly prompts: {
    readonly summary: string;
    readonly description: string;
    readonly tags: string;
  };
  readonly promptTarget: string;
  readonly type: string;
  readonly versions?: RecipeVersions;
};

/** Calculates the recipe-aware identity for a generated concept. */
export const recipeHash = (input: RecipeInput): string => {
  const sourceHash = sha256(input.content);

  const recipe = {
    source: {
      hash: sourceHash,
      path: input.path,
      type: input.type,
    },
    interface: input.interface ?? null,
    versions: input.versions ?? RECIPE_VERSIONS,
    prompts: {
      target: input.promptTarget,
      summary: input.prompts.summary,
      description: input.prompts.description,
      tags: input.prompts.tags,
    },
    completion: {
      provider: input.config.provider.metadata.id,
      model: input.config.model,
      effort: input.config.effort ?? null,
    },
  };

  return sha256(JSON.stringify(recipe));
};

const sha256 = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex');
