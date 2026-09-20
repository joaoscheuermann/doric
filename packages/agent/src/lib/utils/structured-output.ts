import {
  type ProviderFinished,
  structuredJsonSchema,
  type StructuredOutputSchema,
} from 'llms';
import type { ToolDefinition } from 'tool';

import { AgentErrorObject } from '../classes/agent-error.js';

const baseName = 'submit_structured_output';
const description = 'Submit the final structured output and end the agent run.';
const defaultInvalidSubmissionLimit = 2;
const validationIssueLimit = 10;
const terminalOutputSchema = { not: {} } as const;

export type StructuredOutputTool = {
  readonly name: string;
  readonly definition: ToolDefinition;
  readonly schema: StructuredOutputSchema;
};

export type StructuredOutputSubmission<Output> =
  | { readonly type: 'continue' }
  | { readonly type: 'finished'; readonly finish: ProviderFinished<Output> }
  | {
      readonly type: 'invalid';
      readonly error: AgentErrorObject;
      readonly baseline?: StructuredOutputBaseline;
    };

export type StructuredOutputPath = readonly (string | number)[];

/** Ephemeral candidate retained only while repairing concrete leaf paths. */
export type StructuredOutputBaseline = {
  readonly value: unknown;
  readonly paths: readonly StructuredOutputPath[];
};

export type StructuredOutputRepair = {
  readonly invalidSubmissions: number;
  readonly correction: string;
};

type ValidationIssue = {
  readonly code: string;
  readonly expected?: unknown;
  readonly path: readonly PropertyKey[];
  readonly message: string;
};

/**
 * Creates a collision-free strict tool for terminal structured output through
 * the provider-neutral Agent API.
 */
export const createStructuredOutputTool = (
  provider: string,
  schema: StructuredOutputSchema,
  tools: readonly ToolDefinition[],
): StructuredOutputTool => {
  /** Never shadow a caller tool that already uses the preferred terminal name. */
  const name = availableName(new Set(tools.map((tool) => tool.name)));
  /** Reuse the provider schema conversion used by native structured output. */
  const inputSchema = structuredJsonSchema(provider, schema);

  if (inputSchema === undefined) {
    throw new AgentErrorObject({
      code: 'invalid_structured_output',
      message: 'Agent terminal structured output requires an object schema.',
    });
  }

  return {
    name,
    schema,
    definition: {
      name,
      description,
      inputSchema,
      outputSchema: terminalOutputSchema,
      strict: true,
    },
  };
};

/** Instructs the model how to end a structured run. */
export const structuredOutputInstruction = (name: string): string =>
  [
    `When the task is complete, call \`${name}\` exactly once with the final structured output.`,
    'That call must be the only tool call in its response.',
    'Do not return the final output as ordinary text.',
  ].join(' ');

/** Classifies a terminal submission without executing or persisting invalid calls. */
export const parseStructuredOutputTool = <Output>(
  finish: ProviderFinished<unknown>,
  tool: StructuredOutputTool,
  baseline?: StructuredOutputBaseline,
): StructuredOutputSubmission<Output> => {
  /** Ordinary tool calls are not terminal and continue through the agent loop. */
  const terminal = finish.toolCalls.filter(({ name }) => name === tool.name);

  if (terminal.length === 0) {
    return finish.toolCalls.length === 0
      ? invalidSubmission('Agent run ended without terminal structured output.')
      : { type: 'continue' };
  }

  /** A mixed response is ambiguous: no executable call may accompany completion. */
  if (terminal.length !== 1 || finish.toolCalls.length !== 1) {
    return invalidSubmission(
      'Agent terminal structured output must be the only tool call.',
    );
  }

  let value: unknown;

  /** Function arguments arrive as a JSON string at the provider boundary. */
  try {
    value = JSON.parse(terminal[0].arguments) as unknown;
  } catch {
    return invalidSubmission(
      'Agent terminal structured output arguments must be valid JSON.',
    );
  }

  /**
   * Validate locally with the original Zod schema. This enforces refinements
   * that may not be representable in the provider-facing JSON Schema.
   */
  if (baseline !== undefined) {
    const composed = composeCandidate(baseline, value);
    const parsed = tool.schema.safeParse(composed);

    if (parsed.success) {
      return finishedSubmission(finish, composed, parsed.data);
    }

    /** A failed composition falls back to normal whole-submission validation. */
    const replacement = tool.schema.safeParse(value);

    if (replacement.success) {
      return finishedSubmission(finish, value, replacement.data);
    }

    return invalidValidation(value, replacement.error.issues);
  }

  const parsed = tool.schema.safeParse(value);

  if (!parsed.success) {
    return invalidValidation(value, parsed.error.issues);
  }

  return finishedSubmission(finish, value, parsed.data);
};

/** Applies the fixed cumulative budget and prepares one transient correction. */
export const nextStructuredOutputRepair = (
  tool: StructuredOutputTool,
  error: AgentErrorObject,
  invalidSubmissions: number,
  maxRepairs = defaultInvalidSubmissionLimit,
  baseline?: StructuredOutputBaseline,
): StructuredOutputRepair => {
  if (invalidSubmissions >= maxRepairs) {
    throw error;
  }

  return {
    invalidSubmissions: invalidSubmissions + 1,
    correction: structuredOutputCorrection(tool.name, error, baseline),
  };
};

const finishedSubmission = <Output>(
  finish: ProviderFinished<unknown>,
  value: unknown,
  structured: unknown,
): StructuredOutputSubmission<Output> => ({
  type: 'finished',
  finish: {
    ...finish,
    text: JSON.stringify(value),
    finishReason: 'stop',
    toolCalls: [],
    structured: structured as Output,
  },
});

const invalidValidation = <Output>(
  value: unknown,
  issues: readonly ValidationIssue[],
): StructuredOutputSubmission<Output> => {
  const paths = repairablePaths(value, issues);

  return {
    ...invalidSubmission(
      'Agent terminal structured output failed schema validation.',
      validationDiagnostic(issues),
    ),
    ...(paths === undefined ? {} : { baseline: { value, paths } }),
  };
};

const availableName = (names: ReadonlySet<string>): string => {
  if (!names.has(baseName)) {
    return baseName;
  }

  /** Select the first deterministic suffix not owned by caller tools. */
  let suffix = 2;

  while (names.has(`${baseName}_${suffix}`)) {
    suffix += 1;
  }

  return `${baseName}_${suffix}`;
};

const structuredOutputCorrection = (
  name: string,
  error: AgentErrorObject,
  baseline?: StructuredOutputBaseline,
): string =>
  [
    '# Structured output correction',
    '',
    `The previous response was rejected: ${error.data.message}`,
    '',
    `Submit the corrected final output by calling \`${name}\` exactly once. That call must be the only tool call in its response.`,
    ...(error.data.diagnostic === undefined
      ? []
      : [
          '',
          baseline === undefined
            ? 'Correct every validation issue listed below. Preserve fields that already satisfy the schema. Do not encode objects or arrays as JSON strings.'
            : `Only the following rejected paths will be applied to the previous candidate: ${baseline.paths.map(formatPath).join(', ')}. Changes to every other path will be ignored. Do not encode objects or arrays as JSON strings.`,
          '',
          '# Validation issues',
          '',
          error.data.diagnostic,
        ]),
  ].join('\n');

const validationDiagnostic = (issues: readonly ValidationIssue[]): string =>
  issues
    .slice(0, validationIssueLimit)
    .map((issue) => {
      const path = issue.path.map(String).join('.') || '<root>';
      const kind = issue.code.replace(/\s+/g, '_').trim();

      const expected =
        typeof issue.expected === 'string'
          ? [`  Expected: ${issue.expected}`]
          : [];

      const [message = '', ...details] = issue.message
        .split(/\r?\n/u)
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => line.length > 0);

      return [
        `- Field: ${path}`,
        `  Kind: ${kind}`,
        ...expected,
        `  Problem: ${message}`,
        ...details.map((line) => `  ${line}`),
      ].join('\n');
    })
    .join('\n');

const repairablePaths = (
  value: unknown,
  issues: readonly ValidationIssue[],
): readonly StructuredOutputPath[] | undefined => {
  const paths = issues.map((issue) => repairablePath(value, issue));

  if (paths.some((path) => path === undefined)) {
    return undefined;
  }

  const unique = new Map<string, StructuredOutputPath>();

  paths.forEach((path) => {
    if (path !== undefined) {
      unique.set(JSON.stringify(path), path);
    }
  });

  return [...unique.values()];
};

const repairablePath = (
  value: unknown,
  issue: ValidationIssue,
): StructuredOutputPath | undefined => {
  if (issue.code === 'custom' || issue.path.length === 0) {
    return undefined;
  }

  if (
    !issue.path.every(
      (part) => typeof part === 'string' || typeof part === 'number',
    )
  ) {
    return undefined;
  }

  const path = issue.path;
  const located = locate(value, path);

  if (!located.parentFound) {
    return undefined;
  }

  if (!located.found) {
    return typeof path.at(-1) === 'string' && primitiveExpected(issue.expected)
      ? path
      : undefined;
  }

  return primitive(located.value) && !collectionExpected(issue.expected)
    ? path
    : undefined;
};

const primitive = (value: unknown): boolean =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

const primitiveExpected = (expected: unknown): boolean =>
  typeof expected === 'string' &&
  ['string', 'number', 'boolean', 'null'].includes(expected);

const collectionExpected = (expected: unknown): boolean =>
  expected === 'object' || expected === 'array' || expected === 'record';

const composeCandidate = (
  baseline: StructuredOutputBaseline,
  candidate: unknown,
): unknown =>
  baseline.paths.reduce((value, path) => {
    const replacement = locate(candidate, path);

    return replacement.parentFound
      ? replaceAt(value, path, replacement)
      : value;
  }, baseline.value);

type Located = {
  readonly found: boolean;
  readonly parentFound: boolean;
  readonly value?: unknown;
};

const locate = (value: unknown, path: StructuredOutputPath): Located => {
  let current = value;

  for (let index = 0; index < path.length; index += 1) {
    if (!container(current)) {
      return { found: false, parentFound: false };
    }

    const key = path[index];
    const found = Object.prototype.hasOwnProperty.call(current, key);

    if (!found) {
      return { found: false, parentFound: index === path.length - 1 };
    }

    current = current[key as keyof typeof current];
  }

  return { found: true, parentFound: true, value: current };
};

const replaceAt = (
  value: unknown,
  path: StructuredOutputPath,
  replacement: Located,
): unknown => {
  const [key, ...rest] = path;

  if (key === undefined || !container(value)) {
    return value;
  }

  if (rest.length === 0) {
    if (Array.isArray(value)) {
      if (typeof key !== 'number' || !replacement.found) {
        return value;
      }

      return value.map((item, index) =>
        index === key ? replacement.value : item,
      );
    }

    return Object.fromEntries([
      ...Object.entries(value).filter(([name]) => name !== String(key)),
      ...(replacement.found ? [[String(key), replacement.value]] : []),
    ]);
  }

  const child = value[key as keyof typeof value];
  const next = replaceAt(child, rest, replacement);

  return Array.isArray(value)
    ? value.map((item, index) => (index === key ? next : item))
    : Object.fromEntries(
        Object.entries(value).map(([name, item]) => [
          name,
          name === String(key) ? next : item,
        ]),
      );
};

const container = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === 'object' && value !== null;

const formatPath = (path: StructuredOutputPath): string =>
  path.reduce<string>(
    (output, part) =>
      typeof part === 'number'
        ? `${output}[${part}]`
        : output.length === 0
          ? part
          : `${output}.${part}`,
    '',
  );

const invalidSubmission = <Output>(
  message: string,
  diagnostic?: string,
): StructuredOutputSubmission<Output> => ({
  type: 'invalid',
  error: new AgentErrorObject({
    code: 'invalid_structured_output',
    message,
    ...(diagnostic === undefined || diagnostic.length === 0
      ? {}
      : { diagnostic }),
  }),
});
