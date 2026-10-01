import type { ReasoningEffort } from '../types/provider.js';
import {
  arrayField,
  asRecord,
  recordField,
  stringField,
} from '../utils/json.js';

/**
 * What an endpoint's model catalog says about one model: what it is called, the
 * reasoning efforts it accepts, and every request parameter it advertises. A
 * catalog that describes a model's reasoning without naming efforts, or that says
 * nothing about it, leaves the set unknown rather than empty, and a model the
 * catalog does not list has no entry at all.
 */
export interface CatalogModel {
  readonly id: string;
  readonly name?: string;
  readonly reasonings: readonly ReasoningEffort[];
  /** Every supported parameter the catalog named, in the order it named them. */
  readonly parameters: readonly string[];
  /**
   * The effort the catalog names as this model's own, when it names one that the
   * model also lists. An endpoint that names none leaves the choice to a surface.
   */
  readonly defaultEffort?: ReasoningEffort;
  /**
   * Whether the catalog pins reasoning on for this model, so no request may turn
   * it off. A catalog that says nothing about it leaves reasoning optional.
   */
  readonly mandatory: boolean;
}

/**
 * The models an OpenAI-compatible `/models` answer lists, each with the efforts
 * the catalog names for it and the reasoning its `reasoning` block describes. The
 * envelope is the one every OpenAI-shaped endpoint serves; the per-model
 * `reasoning` block is what makes a catalog one that describes its models rather
 * than only listing them.
 */
export const modelCatalog = (
  response: Record<string, unknown>,
): ReadonlyMap<string, CatalogModel> =>
  new Map(
    arrayField(response, 'data')
      .map(asRecord)
      .filter(isRecord)
      .map((entry) => {
        const id = stringField(entry, 'id') ?? '';
        const name = stringField(entry, 'name');
        const reasoning = recordField(entry, 'reasoning') ?? {};
        const reasonings = catalogEfforts(reasoning);
        const defaultEffort = catalogDefaultEffort(reasoning, reasonings);

        return [
          id,
          {
            id,
            ...(name === undefined ? {} : { name }),
            reasonings,
            parameters: arrayField(entry, 'supported_parameters').filter(
              (value): value is string => typeof value === 'string',
            ),
            ...(defaultEffort === undefined ? {} : { defaultEffort }),
            mandatory: reasoning.mandatory === true,
          },
        ] as const;
      }),
  );

const catalogEfforts = (
  reasoning: Record<string, unknown>,
): readonly ReasoningEffort[] =>
  arrayField(reasoning, 'supported_efforts').filter(
    (value): value is ReasoningEffort => isReasoningEffort(value),
  );

/**
 * The effort a catalog names as a model's own, kept only when it is one the model
 * lists: an endpoint that names an effort it does not accept says nothing a
 * request could use.
 */
const catalogDefaultEffort = (
  reasoning: Record<string, unknown>,
  reasonings: readonly ReasoningEffort[],
): ReasoningEffort | undefined => {
  const value = stringField(reasoning, 'default_effort');

  return value !== undefined &&
    isReasoningEffort(value) &&
    reasonings.includes(value)
    ? value
    : undefined;
};

/**
 * Only the efforts this library names are kept: a catalog value no request can
 * carry is not an effort a model accepts here, so it is dropped rather than
 * stored as an unspellable choice.
 */
const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  value === 'none' ||
  value === 'minimal' ||
  value === 'low' ||
  value === 'medium' ||
  value === 'high' ||
  value === 'xhigh' ||
  value === 'max';

const isRecord = (
  value: Record<string, unknown> | undefined,
): value is Record<string, unknown> => value !== undefined;
