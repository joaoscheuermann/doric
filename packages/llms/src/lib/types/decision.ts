import type { JsonArray, JsonObject } from 'tool';

import type { ProviderMetadata, UsageMetadata } from './provider.js';

/** JSON content accepted by System One state, instructions, and criteria. */
export type DecisionEntry = string | JsonObject | JsonArray | null;

export interface NoulQuestion {
  readonly type: 'noul';
  readonly instructions: DecisionEntry;
  readonly criteria?: {
    readonly true: DecisionEntry;
    readonly false: DecisionEntry;
  };
}

export interface ChoiceQuestion<Choice extends string = string> {
  readonly type: 'choice';
  readonly instructions: DecisionEntry;
  readonly criteria: Readonly<Record<Choice, DecisionEntry>>;
}

export interface ScoreQuestion {
  readonly type: 'score';
  readonly instructions: DecisionEntry;
  readonly criteria: readonly DecisionEntry[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type DecisionQuestions = Readonly<Record<string, DecisionQuestion>>;

export interface NoulAnswer {
  readonly type: 'noul';
  readonly noul: number;
}

export interface ChoiceAnswer<Choice extends string = string> {
  readonly type: 'choice';
  readonly choice: Choice;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<Choice, number>>;
}

export interface ScoreAnswer {
  readonly type: 'score';
  readonly score: number;
  readonly confidence: number;
  readonly legend: Readonly<Record<string, DecisionEntry>>;
  readonly probabilities: Readonly<Record<string, number>>;
}

export type DecisionAnswer<Question extends DecisionQuestion> =
  Question extends ChoiceQuestion<infer Choice>
    ? ChoiceAnswer<Choice>
    : Question extends ScoreQuestion
      ? ScoreAnswer
      : NoulAnswer;

export interface ProviderDecisionRequest<
  Questions extends DecisionQuestions = DecisionQuestions,
> {
  readonly model: string;
  readonly state: DecisionEntry;
  readonly questions: Questions;
  readonly signal?: AbortSignal;
}

export interface ProviderDecisionFinished<Questions extends DecisionQuestions> {
  readonly model: string;
  readonly answers: {
    readonly [Key in keyof Questions]: DecisionAnswer<Questions[Key]>;
  };
  readonly usage?: UsageMetadata;
}

/** Typed decision-model contract for System One models such as Jev. */
export interface DecisionProvider {
  readonly metadata: ProviderMetadata;

  decide<Questions extends DecisionQuestions>(
    request: ProviderDecisionRequest<Questions>,
  ): Promise<ProviderDecisionFinished<Questions>>;
}
