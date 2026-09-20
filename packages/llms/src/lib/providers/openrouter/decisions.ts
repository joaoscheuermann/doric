import { ProviderErrorObject } from '../../classes/provider-error.js';
import type {
  ChoiceAnswer,
  DecisionAnswer,
  DecisionEntry,
  DecisionQuestion,
  DecisionQuestions,
  NoulAnswer,
  ProviderDecisionFinished,
  ProviderDecisionRequest,
  ScoreAnswer,
} from '../../types/decision.js';
import type { ProviderId } from '../../types/provider.js';
import {
  asRecord,
  numberField,
  recordField,
  stringField,
} from '../../utils/json.js';
import { parseUsage } from '../common.js';

export const openRouterDecisionsUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  url.pathname = `${url.pathname.replace(/\/v1\/$/u, '/')}alpha/decisions`;
  return url.toString();
};

export const openRouterDecisionBody = <Questions extends DecisionQuestions>(
  request: ProviderDecisionRequest<Questions>,
): Record<string, unknown> => ({
  model: request.model,
  state: request.state,
  questions: request.questions,
});

export const requireDecisionInput = (
  provider: ProviderId,
  request: ProviderDecisionRequest,
): void => {
  if (request.model.trim() === '') {
    throw new ProviderErrorObject({
      provider,
      code: 'missing_model',
      message: 'Provider decision request requires a model.',
    });
  }

  if (Object.keys(request.questions).length === 0) {
    throw new ProviderErrorObject({
      provider,
      code: 'missing_input',
      message: 'Provider decision request requires at least one question.',
    });
  }
};

export const parseDecisionFinished = <Questions extends DecisionQuestions>(
  provider: ProviderId,
  questions: Questions,
  response: Record<string, unknown>,
): ProviderDecisionFinished<Questions> => {
  const model = stringField(response, 'model');
  const source = recordField(response, 'answers');

  if (model === undefined || source === undefined) {
    throw malformed(provider);
  }

  const answers = Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [
      id,
      parseAnswer(provider, question, asRecord(source[id])),
    ]),
  ) as ProviderDecisionFinished<Questions>['answers'];

  return {
    model,
    answers,
    usage: parseUsage(recordField(response, 'usage'), 'credits'),
  };
};

const parseAnswer = (
  provider: ProviderId,
  question: DecisionQuestion,
  value: Record<string, unknown> | undefined,
): DecisionAnswer<DecisionQuestion> => {
  if (value === undefined || stringField(value, 'type') !== question.type) {
    throw malformed(provider);
  }

  switch (question.type) {
    case 'noul':
      return parseNoul(provider, value);
    case 'choice':
      return parseChoice(provider, question, value);
    case 'score':
      return parseScore(provider, value);
  }
};

const parseNoul = (
  provider: ProviderId,
  value: Record<string, unknown>,
): NoulAnswer => ({
  type: 'noul',
  noul: requiredNumber(provider, value, 'noul'),
});

const parseChoice = (
  provider: ProviderId,
  question: Extract<DecisionQuestion, { readonly type: 'choice' }>,
  value: Record<string, unknown>,
): ChoiceAnswer => {
  const choice = stringField(value, 'choice');

  if (choice === undefined || !(choice in question.criteria)) {
    throw malformed(provider);
  }

  return {
    type: 'choice',
    choice,
    confidence: requiredNumber(provider, value, 'confidence'),
    probabilities: probabilities(provider, value),
  };
};

const parseScore = (
  provider: ProviderId,
  value: Record<string, unknown>,
): ScoreAnswer => ({
  type: 'score',
  score: requiredNumber(provider, value, 'score'),
  confidence: requiredNumber(provider, value, 'confidence'),
  legend: entries(provider, value, 'legend'),
  probabilities: probabilities(provider, value),
});

const probabilities = (
  provider: ProviderId,
  value: Record<string, unknown>,
): Readonly<Record<string, number>> => {
  const source = recordField(value, 'probabilities');

  if (source === undefined) {
    throw malformed(provider);
  }

  return Object.fromEntries(
    Object.entries(source).map(([key, probability]) => {
      if (typeof probability !== 'number' || !Number.isFinite(probability)) {
        throw malformed(provider);
      }

      return [key, probability];
    }),
  );
};

const entries = (
  provider: ProviderId,
  value: Record<string, unknown>,
  key: string,
): Readonly<Record<string, DecisionEntry>> => {
  const source = recordField(value, key);

  if (source === undefined) {
    throw malformed(provider);
  }

  return source as Readonly<Record<string, DecisionEntry>>;
};

const requiredNumber = (
  provider: ProviderId,
  value: Record<string, unknown>,
  key: string,
): number => {
  const number = numberField(value, key);

  if (number === undefined) {
    throw malformed(provider);
  }

  return number;
};

const malformed = (provider: ProviderId): ProviderErrorObject =>
  new ProviderErrorObject({
    provider,
    code: 'malformed_response',
    message: `${provider} returned a malformed decision response.`,
  });
