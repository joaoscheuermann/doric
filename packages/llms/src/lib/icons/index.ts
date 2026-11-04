import {
  type OpenRouterLab,
  openRouterProfileForModel,
} from '../providers/openrouter/profiles.js';
import { lobehubIcons } from './lobehub.js';

/** The icons a provider kind may name. */
export type ModelIconName = keyof typeof lobehubIcons;

/** Whether a string names an icon of the set (an own key, never a prototype key). */
export const isModelIconName = (value: string): value is ModelIconName =>
  Object.hasOwn(lobehubIcons, value);

/** The SVG of a named icon. */
export const modelIconSvg = (name: ModelIconName): string => lobehubIcons[name];

/** One model family of the set: its icon, its OpenRouter lab and the word its names contain. */
export interface ModelFamily {
  readonly icon: ModelIconName;
  readonly lab: OpenRouterLab;
  readonly word: string;
}

/**
 * The model families, in matching order. OpenRouter is a provider brand, not a
 * model family, so it has no row.
 */
export const modelFamilies: readonly ModelFamily[] = [
  { icon: 'claude', lab: 'anthropic', word: 'claude' },
  { icon: 'gemini', lab: 'gemini', word: 'gemini' },
  { icon: 'gemma', lab: 'gemma', word: 'gemma' },
  { icon: 'openai', lab: 'openai', word: 'gpt' },
  { icon: 'deepseek', lab: 'deepseek', word: 'deepseek' },
  { icon: 'qwen', lab: 'qwen', word: 'qwen' },
  { icon: 'meta', lab: 'llama', word: 'llama' },
];

/**
 * The icon of an OpenRouter model: the family whose lab
 * `openRouterProfileForModel` reads from its id; any other lab (kimi, mistral,
 * xai, glm, cohere, minimax, unknown) → null.
 */
export const openRouterModelIcon = (model: string): ModelIconName | null => {
  const { lab } = openRouterProfileForModel(model);
  return modelFamilies.find((family) => family.lab === lab)?.icon ?? null;
};

/**
 * The icon a model's name says: the first family whose word is a substring of
 * the lowercased name; none → null.
 */
export const modelNameIcon = (model: string): ModelIconName | null => {
  const name = model.toLowerCase();
  return (
    modelFamilies.find((family) => name.includes(family.word))?.icon ?? null
  );
};
