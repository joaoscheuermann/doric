// The app's check of a papercraft program (D6) and the `Export` calls it holds
// (D16). Both are pure functions of the program text, computed by papercraft's
// client from the model's program, so their messages keep their text under
// openui's D18.

import type { ReportedError } from 'openui/contracts';

import {
  type ASTNode,
  parseExpression,
  split,
  tokenize,
  walkAST,
} from './openui-adapter.js';

/** The action steps that leave the fence (D6). */
const LEAVING_STEPS = new Set(['ToAssistant', 'OpenUrl', 'Run']);

const stepMessage = (step: string): string =>
  `@${step} is not available in papercraft fences. Actions belong in openui-lang fences; a preview changes only local state ($variables, forms, @Set, @Reset), and the reader answers with pinned comments.`;

const DATA_HINT =
  'Query and Mutation are not available; write the data as literals.';

const QUESTION_HINT = 'Questions go in openui-lang fences.';

/** Each statement of `program` that parses, with its name; none when the text cannot be read. */
const statements = (
  program: string,
): readonly { readonly id: string; readonly expression: ASTNode }[] => {
  let raw: ReturnType<typeof split>;
  try {
    raw = split(tokenize(program));
  } catch {
    return [];
  }

  return raw.flatMap((statement) => {
    try {
      return [
        { id: statement.id, expression: parseExpression(statement.tokens) },
      ];
    } catch {
      return [];
    }
  });
};

/** Every `Comp` node of `expression`, in walk order. */
const calls = (
  expression: ASTNode,
): readonly Extract<ASTNode, { k: 'Comp' }>[] => {
  const found: Extract<ASTNode, { k: 'Comp' }>[] = [];
  walkAST(expression, (node) => {
    if (node.k === 'Comp') found.push(node);
  });

  return found;
};

const literal = (node: ASTNode | undefined): string | undefined =>
  node?.k === 'Str' ? node.v : undefined;

/** The most distinct `Export` keys one program builds (D16). */
export const MAX_EXPORTS = 8;

/** One literal `Export(path, name?, props?)` call of a program. */
export interface ExportCall {
  /** `<path>#<name>`, or `<path>#` when `name` is absent. */
  readonly key: string;
  readonly path: string;
  readonly name?: string;
  /** The named statement that holds the call. */
  readonly statementId: string;
}

/**
 * Every `Export` call of `program` whose `path` (and `name`, when given) is a
 * string literal, in the order of the calls; a key may repeat. A call with a
 * non-literal path is left out, and an unparsable program gives `[]`. Never
 * throws.
 */
export const exportCalls = (program: string): readonly ExportCall[] =>
  statements(program).flatMap(({ id, expression }) =>
    calls(expression).flatMap((node): ExportCall[] => {
      if (node.name !== 'Export') return [];
      const [pathArg, nameArg] = node.args;
      const path = literal(pathArg);
      const name = literal(nameArg);
      if (path === undefined) return [];
      if (nameArg !== undefined && nameArg.k !== 'Null' && name === undefined)
        return [];

      return [
        {
          key: `${path}#${name ?? ''}`,
          path,
          ...(name === undefined ? {} : { name }),
          statementId: id,
        },
      ];
    }),
  );

/**
 * The errors the app's check finds in `program` (D6): `unknown-function` for
 * each statement holding `@ToAssistant`, `@OpenUrl` or `@Run`;
 * `tool-not-found` for each `Query` or `Mutation` statement; and
 * `unknown-component` for each statement holding `AskForm` — each with its
 * `statementId` and fixed message. `@Set` and `@Reset` give none; an
 * unparsable program gives `[]`. Never throws.
 */
export const programErrors = (program: string): ReportedError[] =>
  statements(program).flatMap(({ id, expression }): ReportedError[] => {
    const errors: ReportedError[] = [];

    if (
      expression.k === 'Comp' &&
      (expression.name === 'Query' || expression.name === 'Mutation')
    )
      errors.push({
        code: 'tool-not-found',
        statementId: id,
        message: DATA_HINT,
      });

    let asks = false;
    for (const node of calls(expression)) {
      if (LEAVING_STEPS.has(node.name))
        errors.push({
          code: 'unknown-function',
          statementId: id,
          message: stepMessage(node.name),
        });
      if (node.name === 'AskForm') asks = true;
    }

    if (asks)
      errors.push({
        code: 'unknown-component',
        statementId: id,
        message: QUESTION_HINT,
      });

    return errors;
  });
