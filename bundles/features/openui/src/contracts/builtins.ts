// The question built-ins of the conversation library (openui.md D17,
// conversation-openui.md D21) as data: `AskOption`, `AskQuestion`, `AskForm`,
// with their fields from the question schemas, in positional argument order.
// Imports nothing from OpenUI or React: the caller passes `defineComponent`.

import { z } from 'zod';

import {
  askInputSchema,
  askOptionSchema,
  askQuestionSchema,
} from './questions.js';

/** The `defineComponent` of lang-core or react-lang, which returns the component with its `ref`. */
export type DefineComponent<
  C,
  D extends { readonly ref: z.core.$ZodType },
> = (config: {
  readonly name: string;
  readonly props: z.ZodObject;
  readonly description: string;
  readonly component: C;
}) => D;

export interface QuestionRenderers<C> {
  readonly AskOption: C;
  readonly AskQuestion: C;
  readonly AskForm: C;
}

/**
 * AskOption, then AskQuestion with `options` of AskOption refs, then AskForm
 * with `questions` of AskQuestion refs (D21). Calls `define` exactly three
 * times, in that order, with the names `AskOption`, `AskQuestion` and
 * `AskForm` and the matching renderer; the props' keys are, in order:
 * `label, description, recommended`; `id, question, options, multiSelect,
 * allowOther`; `questions, context`. Returns `define`'s results in that order.
 */
export const defineQuestionBuiltins = <
  C,
  D extends { readonly ref: z.core.$ZodType },
>(
  define: DefineComponent<C, D>,
  renderers: QuestionRenderers<C>,
): readonly [D, D, D] => {
  const option = define({
    name: 'AskOption',
    props: z.object({ ...askOptionSchema.shape }),
    description: 'One option of an AskQuestion.',
    component: renderers.AskOption,
  });
  const question = define({
    name: 'AskQuestion',
    props: z.object({
      ...askQuestionSchema.shape,
      options: z.array(option.ref),
    }),
    description: 'One multiple-choice question of an AskForm.',
    component: renderers.AskQuestion,
  });
  const form = define({
    name: 'AskForm',
    props: z.object({
      questions: z.array(question.ref),
      context: askInputSchema.shape.context,
    }),
    description:
      'Questions the reader must answer before you continue. Must be the root of its own fence.',
    component: renderers.AskForm,
  });
  return [option, question, form];
};
