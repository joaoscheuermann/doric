import { z } from 'zod';

import { bundleIdPattern, contractIdPattern } from '../contracts/ids.js';

/** An alternative's name: a lowercase segment, as a bundle ID is. */
const alternativeNamePattern = /^[a-z][a-z0-9-]*$/;

/**
 * A choice between bundles that fill the same role, such as two sandbox
 * bundles. The variable named by `env` picks one of `options`; any other value
 * (or none) picks `default`. The host enables the chosen bundle in place of
 * the default one; the kernel only sees the composition it is given.
 */
export const alternativeSchema = z
  .object({
    env: z.string().min(1),
    default: z.string().min(1),
    options: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .refine((alternative) => alternative.options.includes(alternative.default), {
    message: 'alternative default must be one of its options',
  });

/**
 * What the host needs active before it serves: the contracts that must have
 * an active provider, and the bundles that must be active. Absent, nothing is
 * required.
 */
export const requiredSchema = z
  .object({
    contracts: z.array(z.string().regex(contractIdPattern)).default([]),
    bundles: z.array(z.string().regex(bundleIdPattern)).default([]),
  })
  .strict();

/** The host's structural composition: one core, enabled bundles, chosen providers. */
export const compositionSchema = z
  .object({
    core: z.string().min(1),
    enabled: z.array(z.string().min(1)).min(1),
    /** Installed host parts sharing the native host process. */
    resident: z.array(z.string().regex(bundleIdPattern)).optional(),
    providers: z
      .record(z.string().regex(contractIdPattern), z.string().min(1))
      .default({}),
    required: requiredSchema.optional(),
    alternatives: z
      .record(z.string().regex(alternativeNamePattern), alternativeSchema)
      .optional(),
  })
  .strict();

export type Composition = z.output<typeof compositionSchema>;

export type Alternative = z.output<typeof alternativeSchema>;

/** The option each alternative takes, by its name. */
export type AlternativeChoices = Readonly<Record<string, string>>;

/** The variables the host reads its alternatives from (the process environment). */
export type Variables = Readonly<Record<string, string | undefined>>;

export const parseComposition = (document: unknown): Composition =>
  compositionSchema.parse(document);

/**
 * The option each alternative takes from its variable: the value the variable
 * names when it is one of the options, otherwise the default.
 */
export const selectAlternatives = (
  composition: Composition,
  variables: Variables,
): AlternativeChoices =>
  Object.fromEntries(
    Object.entries(composition.alternatives ?? {}).map(
      ([name, alternative]) => {
        const requested = variables[alternative.env];

        return [
          name,
          requested !== undefined && alternative.options.includes(requested)
            ? requested
            : alternative.default,
        ];
      },
    ),
  );

/**
 * The composition with each chosen option enabled in place of its alternative's
 * default bundle. An option already enabled is not duplicated.
 */
export const enableAlternatives = (
  composition: Composition,
  choices: AlternativeChoices,
): Composition => {
  let enabled = composition.enabled;

  for (const [name, alternative] of Object.entries(
    composition.alternatives ?? {},
  )) {
    const option = choices[name];

    if (option === undefined || option === alternative.default) continue;

    enabled = [
      ...new Set(
        enabled.map((id) => (id === alternative.default ? option : id)),
      ),
    ];
  }

  return { ...composition, enabled };
};

/**
 * The option each alternative names through its enabled bundles: the single
 * enabled option, or the default when none or several are enabled.
 */
export const enabledAlternatives = (
  composition: Composition,
): AlternativeChoices =>
  Object.fromEntries(
    Object.entries(composition.alternatives ?? {}).map(
      ([name, alternative]) => {
        const enabledOptions = alternative.options.filter((option) =>
          composition.enabled.includes(option),
        );
        const [only] = enabledOptions;

        return [
          name,
          enabledOptions.length === 1 && only !== undefined
            ? only
            : alternative.default,
        ];
      },
    ),
  );
