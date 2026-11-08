// The diagram findings of the conversation's check (openui-diagrams.md F3):
// one numbered `runtime-error` per statement, fitted to the reporter's 300
// code units, merged into an error the statement already has.

import type { ReportedError } from '../../contracts/index.js';
import { DIAGRAM_PARTS, type DiagramType } from './definitions.js';
import { readEntities } from './entity-model.js';
import { readMindMap } from './mindmap-model.js';
import { readFlowchart } from './model.js';
import { isElement } from './read.js';
import { readSequence } from './sequence-model.js';

/** The longest message a report carries, in UTF-16 code units. */
const MAX_MESSAGE = 300;

/** Each diagram type's reading and parts (F15). */
const DIAGRAMS: Readonly<
  Record<
    DiagramType,
    {
      readonly read: (props: unknown) => {
        readonly findings: readonly string[];
      };
      readonly parts: readonly string[];
    }
  >
> = {
  Flowchart: { read: readFlowchart, parts: DIAGRAM_PARTS.Flowchart },
  SequenceDiagram: {
    read: readSequence,
    parts: DIAGRAM_PARTS.SequenceDiagram,
  },
  EntityDiagram: { read: readEntities, parts: DIAGRAM_PARTS.EntityDiagram },
  MindMap: { read: readMindMap, parts: DIAGRAM_PARTS.MindMap },
};

const diagramOf = (typeName: string): DiagramType | undefined =>
  Object.hasOwn(DIAGRAMS, typeName) ? (typeName as DiagramType) : undefined;

/** The diagram whose parts include `typeName`, if any. */
const ownerOf = (typeName: string): DiagramType | undefined =>
  (Object.keys(DIAGRAMS) as DiagramType[]).find((type) =>
    DIAGRAMS[type].parts.includes(typeName),
  );

/** The findings each diagram error was built from, so a merge can rebuild it to fit. */
const findingsOf = new WeakMap<ReportedError, readonly string[]>();

/**
 * `Diagram problems (<N>): 1. … 2. …` within `room` code units: findings in
 * order while they and the closing ` <K> more not shown.` fit.
 */
const messageOf = (findings: readonly string[], room: number): string => {
  const count = findings.length;
  const text = (items: readonly string[]): string => {
    const left = count - items.length;
    const tail = left > 0 ? [`${left} more not shown.`] : [];
    return `Diagram problems (${count}): ${[...items, ...tail].join(' ')}`;
  };
  const shown: string[] = [];
  for (const finding of findings) {
    const item = `${shown.length + 1}. ${finding}`;
    if (text([...shown, item]).length > room) break;
    shown.push(item);
  }
  return text(shown);
};

/**
 * The diagram findings of a parsed program root (`parseProgram`'s result
 * root; anything else gives `[]`): one `{ code: 'runtime-error',
 * statementId, message }` per statement with findings, in walk order. A
 * diagram's findings go to its statement (own `statementId`, else the
 * nearest enclosing one, else `root`); a part outside its diagram gives
 * `"<Part> draws only inside a <Diagram>."`; a diagram inside another
 * diagram's props gives `"<Inner> is not drawn inside a <Outer>."`, and its
 * contents add nothing. `message` is
 * `Diagram problems (<N>): 1. … 2. …`, at most 300 UTF-16 code units, ending
 * with ` <K> more not shown.` when K findings did not fit, and
 * `Diagram problems (<N>): <N> more not shown.` when not even the first fits.
 * Never throws.
 */
export const diagramCheck = (root: unknown): readonly ReportedError[] => {
  const byStatement = new Map<string, string[]>();
  const add = (statement: string, findings: readonly string[]): void => {
    if (findings.length === 0) return;
    byStatement.set(statement, [
      ...(byStatement.get(statement) ?? []),
      ...findings,
    ]);
  };

  const walk = (
    value: unknown,
    statement: string,
    enclosing: DiagramType | undefined,
  ): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, statement, enclosing);
      return;
    }
    if (!isElement(value)) return;
    const own = value.statementId ?? statement;
    const diagram = diagramOf(value.typeName);
    const owner = ownerOf(value.typeName);
    if (diagram !== undefined && enclosing !== undefined) {
      // The outer reading skips it; its parts and its reading add nothing.
      add(own, [`${diagram} is not drawn inside a ${enclosing}.`]);
      return;
    }
    if (diagram !== undefined) {
      add(own, DIAGRAMS[diagram].read(value.props).findings);
    } else if (owner !== undefined && owner !== enclosing) {
      add(own, [`${value.typeName} draws only inside a ${owner}.`]);
    }
    const within = diagram ?? enclosing;
    for (const prop of Object.values(value.props)) walk(prop, own, within);
  };
  walk(root, 'root', undefined);

  return [...byStatement].map(([statementId, findings]) => {
    const error: ReportedError = {
      code: 'runtime-error',
      statementId,
      message: messageOf(findings, MAX_MESSAGE),
    };
    findingsOf.set(error, findings);
    return error;
  });
};

/**
 * `errors` with each diagram error appended to the message of the first
 * `runtime-error` of its statement after `; ` (rebuilt to fit the room left
 * of 300 code units), or added at the end when there is none. The order of
 * `errors` is kept; neither input is mutated.
 */
export const mergeDiagramErrors = (
  errors: readonly ReportedError[],
  diagram: readonly ReportedError[],
): readonly ReportedError[] => {
  const merged = [...errors];
  for (const error of diagram) {
    const at = merged.findIndex(
      (existing) =>
        existing.code === 'runtime-error' &&
        existing.statementId === error.statementId,
    );
    const existing = merged[at];
    if (existing === undefined) {
      merged.push(error);
      continue;
    }
    const findings = findingsOf.get(error);
    const before = existing.message ?? '';
    const room = MAX_MESSAGE - before.length - 2;
    const message =
      findings === undefined ? error.message : messageOf(findings, room);
    merged[at] = { ...existing, message: `${before}; ${message ?? ''}` };
  }
  return merged;
};
