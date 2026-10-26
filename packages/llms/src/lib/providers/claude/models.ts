import type { Model, ReasoningEffort } from '../../types/provider.js';
import { asRecord, recordField, stringField } from '../../utils/json.js';
import type { CatalogModel } from '../models.js';

/**
 * What a Claude model id says about the request it accepts. Ids are typed by
 * hand, so the rules read the family and version an id names
 * (`claude-opus-5-5`, `claude-sonnet-4-5-20250929`) and treat an id they do
 * not recognise as an older model: nothing is sent that it could refuse.
 */
interface ClaudeModelId {
  readonly family: 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos';
  readonly major: number;
  /** The minor version; `0` when the id names none (or only a date). */
  readonly minor: number;
}

const modelIdPattern =
  /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:$|[-@])/;

/** The family and version a model id names, when it names one. */
const parseModelId = (model: string): ClaudeModelId | undefined => {
  const match = modelIdPattern.exec(model.trim().toLowerCase());
  if (match === null) return undefined;
  return {
    family: match[1] as ClaudeModelId['family'],
    major: Number(match[2]),
    minor: match[3] === undefined ? 0 : Number(match[3]),
  };
};

/** Whether the id names at least `major.minor` of its family. */
const atLeast = (id: ClaudeModelId, major: number, minor: number): boolean =>
  id.major > major || (id.major === major && id.minor >= minor);

/**
 * Whether the model thinks unless told otherwise: the 5.x families, Fable and
 * Mythos. Only these get a `thinking` field, which keeps the block-binding
 * control without turning thinking on where it was off.
 */
export const thinksByDefault = (model: string): boolean => {
  const id = parseModelId(model);
  if (id === undefined) return false;
  return id.family === 'fable' || id.family === 'mythos' || id.major >= 5;
};

/**
 * Whether the model refuses a forced `tool_choice` (`any` or a named tool):
 * Opus 5.5, Sonnet 5.5, Fable 5.1 and Mythos 5.1, and their successors.
 */
export const rejectsForcedToolChoice = (model: string): boolean => {
  const id = parseModelId(model);
  if (id === undefined) return false;
  switch (id.family) {
    case 'opus':
    case 'sonnet':
      return atLeast(id, 5, 5);
    case 'fable':
    case 'mythos':
      return atLeast(id, 5, 1);
    default:
      return false;
  }
};

/** The effort levels a model accepts, strongest last; empty when it takes none. */
const effortLevels = (model: string): readonly ReasoningEffort[] => {
  const id = parseModelId(model);
  if (id === undefined) return [];
  const all: readonly ReasoningEffort[] = [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ];
  if (id.family === 'fable' || id.family === 'mythos' || id.major >= 5) {
    return all;
  }
  if (id.major === 4 && id.family === 'opus') {
    if (id.minor >= 7) return all;
    if (id.minor === 6) return ['low', 'medium', 'high', 'max'];
    if (id.minor === 5) return ['low', 'medium', 'high'];
  }
  if (id.major === 4 && id.family === 'sonnet' && id.minor >= 6) {
    return ['low', 'medium', 'high', 'max'];
  }
  return [];
};

/**
 * A requested effort as the `output_config.effort` the model accepts:
 * `none` and `minimal` are `low`, a level the model lacks steps down to
 * `high`, and a model that takes no effort (Haiku 4.5, Sonnet 4.5 and older)
 * gets none at all.
 */
export const claudeEffort = (
  model: string,
  effort: ReasoningEffort | undefined,
): ReasoningEffort | undefined => {
  if (effort === undefined) return undefined;
  const levels = effortLevels(model);
  if (levels.length === 0) return undefined;
  const wanted = effort === 'none' || effort === 'minimal' ? 'low' : effort;
  if (levels.includes(wanted)) return wanted;
  return levels.includes('high') ? 'high' : levels.at(-1);
};

/**
 * The id a model listing names, without the date a dated id carries, so
 * `claude-haiku-4-5` and `claude-haiku-4-5-20251001` name the same model.
 */
export const undatedModelId = (model: string): string =>
  model.replace(/-\d{8}$/, '');

/** Every effort level Anthropic names, weakest first. */
const claudeEffortOrder: readonly ReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/**
 * The efforts a listed model accepts: the levels its `capabilities.effort`
 * marks supported, in Anthropic's order, or — for a listing that carries no
 * capabilities — what the model's id says it takes.
 */
const listedEfforts = (
  id: string,
  raw: Record<string, unknown>,
): readonly ReasoningEffort[] => {
  const effort = recordField(recordField(raw, 'capabilities') ?? {}, 'effort');
  if (effort === undefined) return effortLevels(id);
  if (effort.supported === false) return [];
  return claudeEffortOrder.filter(
    (level) => recordField(effort, level)?.supported === true,
  );
};

/**
 * The effort a model starts at when nothing names one: Anthropic's own
 * default, `medium` on Opus 5.5 and Haiku 5.5 and their successors, `high`
 * elsewhere, and none for a model that takes no effort.
 */
const listedDefaultEffort = (
  id: string,
  efforts: readonly ReasoningEffort[],
): ReasoningEffort | undefined => {
  const parsed = parseModelId(id);
  const preferred =
    parsed !== undefined &&
    (parsed.family === 'opus' || parsed.family === 'haiku') &&
    atLeast(parsed, 5, 5)
      ? 'medium'
      : 'high';
  if (efforts.includes(preferred)) return preferred;
  return efforts.at(-1);
};

/**
 * A model Anthropic's `/v1/models` lists, as the catalog entry a provider's
 * model list is filled from: its id and display name, and the efforts it
 * accepts with the one it starts at. Claude's reasoning is an effort, never a
 * switch a request must keep on, so no entry is `mandatory`.
 */
export const claudeCatalogModel = (model: Model): CatalogModel => {
  const raw = asRecord(model.raw) ?? {};
  const name = model.name ?? stringField(raw, 'display_name');
  const reasonings = listedEfforts(model.id, raw);
  const defaultEffort = listedDefaultEffort(model.id, reasonings);

  return {
    id: model.id,
    ...(name === undefined ? {} : { name }),
    reasonings,
    parameters: [],
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    mandatory: false,
  };
};
