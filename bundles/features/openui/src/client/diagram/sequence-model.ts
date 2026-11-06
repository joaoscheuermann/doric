// The reading of a SequenceDiagram (openui-diagrams-phase2.md F14): one pure
// function from a SequenceDiagram element's props to the participants and
// steps it draws and the findings the check reports, in F14's order.

import {
  FRAGMENT_KINDS,
  MESSAGE_KINDS,
  SEQUENCE_LIMITS,
} from './definitions.js';
import {
  cutLabel,
  isElement,
  isRecord,
  keepUnique,
  misplaced,
  type Props,
  partsOf,
  quote,
} from './read.js';

export interface SeqParticipant {
  readonly id: string;
  /** Cut at 120 characters; the id when written empty. */
  readonly label: string;
}
export type SeqStep =
  | {
      readonly type: 'message';
      readonly from: string;
      readonly to: string;
      readonly text: string;
      readonly kind: 'call' | 'reply' | 'async';
    }
  | {
      readonly type: 'note';
      readonly text: string;
      readonly over: readonly string[];
    }
  | {
      readonly type: 'fragment';
      readonly kind: 'loop' | 'opt' | 'alt' | 'par';
      readonly sections: readonly SeqSection[];
    };
export interface SeqSection {
  readonly label: string;
  readonly steps: readonly SeqStep[];
}
export interface SequenceModel {
  readonly height?: number;
  readonly participants: readonly SeqParticipant[];
  /** Drawn steps, program order; every id they name is a drawn participant. */
  readonly steps: readonly SeqStep[];
  readonly cut: { readonly participants?: number; readonly steps?: number };
  readonly findings: readonly string[];
}

const STEP_TYPES = ['Message', 'Note', 'Fragment'] as const;

/** `value` when it is one of `options`. */
const oneOf = <T extends string>(
  options: readonly T[],
  value: unknown,
): T | undefined => options.find((option) => option === value);

/**
 * The valid steps of a `steps` list, uncut, depth-first: misplaced parts first, then each
 * step's findings, a fragment's `holds no step` after those of the steps inside it.
 */
const validSteps = (
  list: unknown,
  known: ReadonlySet<string>,
  findings: string[],
): SeqStep[] => {
  misplaced(list, 'steps', STEP_TYPES, findings);
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown): SeqStep[] => {
    if (!isElement(entry)) return [];
    const props = entry.props;
    switch (entry.typeName) {
      case 'Message': {
        const { from, to, text } = props;
        if (
          typeof from !== 'string' ||
          typeof to !== 'string' ||
          typeof text !== 'string'
        ) {
          return [];
        }
        const missing = [from, to].find((id) => !known.has(id));
        if (missing !== undefined) {
          findings.push(
            `Message ${quote(from)}→${quote(to)} names no Participant ${quote(missing)}, so it is not drawn.`,
          );
          return [];
        }
        const kind = oneOf(MESSAGE_KINDS, props.kind) ?? 'call';
        return [{ type: 'message', from, to, text, kind }];
      }
      case 'Note': {
        const { text } = props;
        if (typeof text !== 'string') return [];
        const over = (Array.isArray(props.over) ? props.over : []).filter(
          (id: unknown): id is string => typeof id === 'string',
        );
        const missing = over.find((id) => !known.has(id));
        if (over.length === 0 || missing !== undefined) {
          const named = missing === undefined ? '' : ` ${quote(missing)}`;
          findings.push(
            `Note ${quote(text)} names no Participant${named}, so it is not drawn.`,
          );
          return [];
        }
        return [{ type: 'note', text, over }];
      }
      case 'Fragment': {
        const kind = oneOf(FRAGMENT_KINDS, props.kind) ?? 'loop';
        misplaced(props.sections, 'sections', ['Section'], findings);
        const written = partsOf(props.sections, 'Section', ['label']);
        const sections = written.map((section: Props) => ({
          label: section.label as string,
          steps: validSteps(section.steps, known, findings),
        }));
        if (sections.every((section) => section.steps.length === 0)) {
          findings.push(
            `Fragment ${JSON.stringify(kind)} ${quote(sections[0]?.label ?? '')} holds no step, so it is not drawn.`,
          );
          return [];
        }
        return [{ type: 'fragment', kind, sections }];
      }
      default:
        return [];
    }
  });
};

/**
 * The drawn steps of valid `steps`, numbered depth-first from `counter.n` (a fragment before
 * its sections' steps), with their labels cut; label findings go to `labels`.
 */
const drawnSteps = (
  steps: readonly SeqStep[],
  counter: { n: number },
  labels: string[],
): SeqStep[] =>
  steps.flatMap((step): SeqStep[] => {
    counter.n += 1;
    const drawn = counter.n <= SEQUENCE_LIMITS.steps;
    if (step.type !== 'fragment') {
      if (!drawn) return [];
      const text = cutLabel(step.text);
      if (text !== step.text) {
        const part =
          step.type === 'message'
            ? `Message ${quote(step.from)}→${quote(step.to)}`
            : `Note ${quote(step.text)}`;
        labels.push(`The text of ${part} is cut at 120 characters.`);
      }
      return [{ ...step, text }];
    }
    // Inner steps keep their numbers whether or not the fragment is drawn.
    const sectionLabels: string[] = [];
    const sections = step.sections.map((section) => {
      const label = cutLabel(section.label);
      if (label !== section.label) {
        sectionLabels.push(
          `The label of Section ${quote(section.label)} is cut at 120 characters.`,
        );
      }
      return {
        label,
        steps: drawnSteps(section.steps, counter, sectionLabels),
      };
    });
    if (!drawn || sections.every((section) => section.steps.length === 0)) {
      return [];
    }
    labels.push(...sectionLabels);
    return [{ type: 'fragment', kind: step.kind, sections }];
  });

/**
 * Reads a SequenceDiagram element's props (any value). Findings, in order (F14):
 * 1. `keepUnique('SequenceDiagram', 'Participant', 'participants', …, 20)`.
 * 2. Steps, depth-first in program order: `misplaced` first on each `steps` and `sections`
 *    list; then per step `Message <from>→<to> names no Participant <missing>, so it is not
 *    drawn.`, `Note <text> names no Participant[ <missing>], so it is not drawn.`, and,
 *    post-order, `Fragment <kind> <label> holds no step, so it is not drawn.`. Valid steps are
 *    numbered depth-first, a fragment before its sections' steps; those numbered ≤ 200 are drawn
 *    (a fragment only when one of its sections holds a drawn step). More than 200 valid steps:
 *    `The SequenceDiagram has <N> steps, and only the first 200 are drawn: split the diagram.`
 *    after the walk's findings (`cut.steps` = N).
 * 3. Labels of drawn parts cut at 120 characters, one finding each.
 * 4. No kept participant: `The SequenceDiagram has no participants.`
 * Ids and texts in findings are written with `quote`. Pure; never throws.
 */
export const readSequence = (props: unknown): SequenceModel => {
  const input: Props = isRecord(props) ? props : {};
  const height = input.height;
  const findings: string[] = [];

  // 1. Participants.
  const kept = keepUnique(
    'SequenceDiagram',
    'Participant',
    'participants',
    partsOf(input.participants, 'Participant', ['id', 'label']),
    SEQUENCE_LIMITS.participants,
    findings,
  );
  const labels: string[] = [];
  const participants = kept.kept.map((participant): SeqParticipant => {
    const id = participant.id as string;
    const written = participant.label as string;
    const label = cutLabel(written === '' ? id : written);
    if (label !== written && written !== '') {
      labels.push(
        `The label of Participant ${quote(id)} is cut at 120 characters.`,
      );
    }
    return { id, label };
  });
  const known = new Set(participants.map((participant) => participant.id));

  // 2. Steps, then the limit; 3. labels of the drawn parts.
  const valid = validSteps(input.steps, known, findings);
  const counter = { n: 0 };
  const steps = drawnSteps(valid, counter, labels);
  const over = counter.n > SEQUENCE_LIMITS.steps;
  if (over) {
    findings.push(
      `The SequenceDiagram has ${counter.n} steps, and only the first ${SEQUENCE_LIMITS.steps} are drawn: split the diagram.`,
    );
  }
  findings.push(...labels);

  // 4. Empty diagram.
  if (participants.length === 0) {
    findings.push('The SequenceDiagram has no participants.');
  }

  return {
    ...(typeof height === 'number' && Number.isFinite(height)
      ? { height }
      : {}),
    participants,
    steps,
    cut: {
      ...(kept.before === undefined ? {} : { participants: kept.before }),
      ...(over ? { steps: counter.n } : {}),
    },
    findings,
  };
};
