// The icons the story host answers: a circle for a model and a square for a
// provider's own icon. Each has a unique `id`, so markup that reached the
// document would be found by it.

import type { ModelIconAnswers } from 'bundle/contracts';

import type { IconLookup } from '../../src/client/domain/model-icons.js';

/** A model's icon. */
export const circleSvg =
  '<svg id="story-icon-circle" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';

/** A provider's own icon. */
export const squareSvg =
  '<svg id="story-icon-square" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>';

/** Whether the story host answers an icon for a model: none for `acme/`. */
const hasModelIcon = (model: string): boolean => !model.startsWith('acme/');

/**
 * `models/v1.icons` as the story host answers it: the square for each
 * provider, and the circle for each model except those starting with `acme/`.
 */
export const storyIconAnswers = (input: {
  readonly requests: readonly { readonly models: readonly string[] }[];
}): ModelIconAnswers => ({
  svgs: { square: squareSvg, circle: circleSvg },
  answers: input.requests.map((request) => ({
    provider: 'square',
    models: request.models.map((model) =>
      hasModelIcon(model) ? 'circle' : null,
    ),
  })),
});

/** The same icons as a lookup, for a story that draws groups itself. */
export const storyIcons: IconLookup = {
  provider: () => squareSvg,
  model: (_providerId, model) => (hasModelIcon(model) ? circleSvg : undefined),
};
