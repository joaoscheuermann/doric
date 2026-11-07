// The reading of an EntityDiagram (openui-diagrams-phase2.md F14): one pure
// function from an EntityDiagram element's props to the entities and relations
// it draws and the findings the check reports, in F14's order.

import {
  COUNTS,
  ENTITY_LIMITS,
  FIELD_KEYS,
  RELATION_KINDS,
} from './definitions.js';
import {
  cutLabel,
  isRecord,
  keepUnique,
  type Props,
  partsOf,
  quote,
  text,
} from './read.js';

export interface EntityField {
  /** Cut at 120 characters. */
  readonly name: string;
  /** Cut at 120 characters; absent when not a string. */
  readonly type?: string;
  /** Absent when not one of `FIELD_KEYS`. */
  readonly key?: 'pk' | 'fk' | 'pk-fk' | 'unique';
}
export interface EntityBox {
  readonly id: string;
  /** Cut at 120 characters; the id when written empty. */
  readonly name: string;
  /** Program order; `Field` elements with a string `name`, all of them. */
  readonly fields: readonly EntityField[];
  /** Always empty under `er`. */
  readonly methods: readonly string[];
}
export interface EntityRelation {
  /** Ids of drawn entities (never another value). */
  readonly from: string;
  readonly to: string;
  /** `association` under `er`, whatever was written. */
  readonly kind: (typeof RELATION_KINDS)[number];
  /** Cut at 120 characters; absent when not a string or empty. */
  readonly label?: string;
  readonly fromCount?: (typeof COUNTS)[number];
  readonly toCount?: (typeof COUNTS)[number];
}
export interface EntityModel {
  /** `er` when absent or not `er`/`class`. */
  readonly notation: 'er' | 'class';
  /** `down` when absent or not `down`/`right`. */
  readonly direction: 'down' | 'right';
  readonly entities: readonly EntityBox[];
  /** Program order; self-relations and repeats kept. */
  readonly relations: readonly EntityRelation[];
  readonly cut: { readonly entities?: number; readonly relations?: number };
  readonly findings: readonly string[];
}

/** `value` when it is one of `options`. */
const oneOf = <T extends string>(
  options: readonly T[],
  value: unknown,
): T | undefined => options.find((option) => option === value);

/** A field as drawn, and whether its name or type was cut. */
const fieldOf = (props: Props): { field: EntityField; cut: boolean } => {
  const written = props.name as string;
  const type = text(props.type);
  const key = oneOf(FIELD_KEYS, props.key);
  const name = cutLabel(written);
  const cutType = type === undefined ? undefined : cutLabel(type);
  return {
    field: {
      name,
      ...(cutType === undefined ? {} : { type: cutType }),
      ...(key === undefined ? {} : { key }),
    },
    cut: name !== written || cutType !== type,
  };
};

/**
 * Reads an EntityDiagram element's props (any value). Findings, in order (F14):
 * 1. `keepUnique('EntityDiagram', 'Entity', 'entities', …, 60)`.
 * 2. Members: no finding (fields and methods not limited; under `er` methods are not read).
 * 3. Relations: `Relation <from>→<to> names no Entity <missing>, so it is not drawn.`
 *    (`<missing>` the first of the two naming none); beyond 120 valid relations:
 *    `The EntityDiagram has <N> relations, and only the first 120 are drawn: split the diagram.`
 *    (`cut.relations` = N). Under `er`, `kind` reads `association` with no finding.
 * 4. Labels, at most once per entity or relation: `The name of Entity <id> is cut at 120
 *    characters.`, `A field of Entity <id> is cut at 120 characters.`, `A method of Entity <id>
 *    is cut at 120 characters.`, `The label of Relation <from>→<to> is cut at 120 characters.`
 * 5. No kept entity: `The EntityDiagram has no entities.`
 * Ids and texts in findings are written with `quote`. Pure; never throws.
 */
export const readEntities = (props: unknown): EntityModel => {
  const input: Props = isRecord(props) ? props : {};
  const notation = input.notation === 'class' ? 'class' : 'er';
  const findings: string[] = [];

  // 1. Entities.
  const entities = keepUnique(
    'EntityDiagram',
    'Entity',
    'entities',
    partsOf(input.entities, 'Entity', ['id', 'name']),
    ENTITY_LIMITS.entities,
    findings,
  );
  const known = new Set(entities.kept.map((entity) => entity.id as string));

  // 3. Relations naming kept entities, then the limit.
  const valid = partsOf(input.relations, 'Relation', ['from', 'to']).filter(
    (relation) => {
      const from = relation.from as string;
      const to = relation.to as string;
      const missing = [from, to].find((id) => !known.has(id));
      if (missing === undefined) return true;
      findings.push(
        `Relation ${quote(from)}→${quote(to)} names no Entity ${quote(missing)}, so it is not drawn.`,
      );
      return false;
    },
  );
  const over = valid.length > ENTITY_LIMITS.relations;
  if (over) {
    findings.push(
      `The EntityDiagram has ${valid.length} relations, and only the first ${ENTITY_LIMITS.relations} are drawn: split the diagram.`,
    );
  }

  // 2 and 4. Members and labels of the drawn entities.
  const boxes = entities.kept.map((entity): EntityBox => {
    const id = entity.id as string;
    const written = entity.name as string;
    const name = cutLabel(written === '' ? id : written);
    if (name !== written && written !== '') {
      findings.push(
        `The name of Entity ${quote(id)} is cut at 120 characters.`,
      );
    }
    const fields = partsOf(entity.fields, 'Field', ['name']).map(fieldOf);
    if (fields.some((field) => field.cut)) {
      findings.push(`A field of Entity ${quote(id)} is cut at 120 characters.`);
    }
    const writtenMethods =
      notation === 'class' && Array.isArray(entity.methods)
        ? entity.methods.flatMap((method: unknown) =>
            typeof method === 'string' ? [method] : [],
          )
        : [];
    const methods = writtenMethods.map(cutLabel);
    if (methods.some((method, i) => method !== writtenMethods[i])) {
      findings.push(
        `A method of Entity ${quote(id)} is cut at 120 characters.`,
      );
    }
    return {
      id,
      name,
      fields: fields.map((field) => field.field),
      methods,
    };
  });

  const relations = valid
    .slice(0, ENTITY_LIMITS.relations)
    .map((relation): EntityRelation => {
      const from = relation.from as string;
      const to = relation.to as string;
      const written = text(relation.label);
      const label = written === undefined ? undefined : cutLabel(written);
      if (label !== written) {
        findings.push(
          `The label of Relation ${quote(from)}→${quote(to)} is cut at 120 characters.`,
        );
      }
      const kind =
        notation === 'class'
          ? (oneOf(RELATION_KINDS, relation.kind) ?? 'association')
          : 'association';
      const fromCount = oneOf(COUNTS, relation.fromCount);
      const toCount = oneOf(COUNTS, relation.toCount);
      return {
        from,
        to,
        kind,
        ...(label === undefined || label === '' ? {} : { label }),
        ...(fromCount === undefined ? {} : { fromCount }),
        ...(toCount === undefined ? {} : { toCount }),
      };
    });

  // 5. Empty diagram.
  if (boxes.length === 0) findings.push('The EntityDiagram has no entities.');

  return {
    notation,
    direction: input.direction === 'right' ? 'right' : 'down',
    entities: boxes,
    relations,
    cut: {
      ...(entities.before === undefined ? {} : { entities: entities.before }),
      ...(over ? { relations: valid.length } : {}),
    },
    findings,
  };
};
