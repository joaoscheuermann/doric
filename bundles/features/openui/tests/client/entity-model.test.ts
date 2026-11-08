// FT25 (openui-diagrams-phase2.md F14): `readEntities` reads an EntityDiagram
// element's props, as lang-core passes them, into the drawn entities and
// relations and the findings. One case per rule of F14: the parts kept, and
// the exact finding texts in order.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type EntityModel,
  readEntities,
} from '../../src/client/diagram/entity-model.js';

const element = (typeName: string, props: Record<string, unknown>) => ({
  type: 'element',
  typeName,
  props,
});

const Field = (name: unknown, type?: unknown, key?: unknown) =>
  element('Field', {
    name,
    ...(type === undefined ? {} : { type }),
    ...(key === undefined ? {} : { key }),
  });

const Entity = (
  id: string,
  name: string,
  fields?: readonly unknown[],
  methods?: readonly unknown[],
) =>
  element('Entity', {
    id,
    name,
    ...(fields === undefined ? {} : { fields }),
    ...(methods === undefined ? {} : { methods }),
  });

const Relation = (
  from: string,
  to: string,
  extra: {
    readonly kind?: unknown;
    readonly label?: unknown;
    readonly fromCount?: unknown;
    readonly toCount?: unknown;
  } = {},
) => element('Relation', { from, to, ...extra });

const read = (props: unknown): EntityModel => readEntities(props);

const ids = (parts: readonly { readonly id: string }[]): string[] =>
  parts.map((part) => part.id);

const USERS = Entity('users', 'users', [Field('id', 'uuid', 'pk')]);
const ORDERS = Entity('orders', 'orders', [
  Field('id', 'uuid', 'pk'),
  Field('user_id', 'uuid', 'fk'),
]);

test('an ER diagram with defaults reads its entities, fields and relation, down, without findings', () => {
  const model = read({
    entities: [USERS, ORDERS],
    relations: [
      Relation('users', 'orders', {
        label: 'places',
        fromCount: '1',
        toCount: '*',
      }),
    ],
  });

  assert.deepEqual(model.findings, []);
  assert.equal(model.notation, 'er');
  assert.equal(model.direction, 'down');
  assert.deepEqual(model.entities, [
    {
      id: 'users',
      name: 'users',
      fields: [{ name: 'id', type: 'uuid', key: 'pk' }],
      methods: [],
    },
    {
      id: 'orders',
      name: 'orders',
      fields: [
        { name: 'id', type: 'uuid', key: 'pk' },
        { name: 'user_id', type: 'uuid', key: 'fk' },
      ],
      methods: [],
    },
  ]);
  assert.deepEqual(model.relations, [
    {
      from: 'users',
      to: 'orders',
      kind: 'association',
      label: 'places',
      fromCount: '1',
      toCount: '*',
    },
  ]);
});

test('an id of 65 characters is not drawn', () => {
  const long = 'a'.repeat(65);
  const model = read({ entities: [Entity(long, 'Long'), USERS] });

  assert.deepEqual(model.findings, [
    `Entity "${'a'.repeat(23)}…" is not drawn because an id has 1 to 64 characters.`,
  ]);
  assert.deepEqual(ids(model.entities), ['users']);
});

test('a repeated entity: only the first is drawn', () => {
  const model = read({
    entities: [USERS, Entity('users', 'Users again'), ORDERS],
  });

  assert.deepEqual(model.findings, [
    'Entity "users" appears twice, and only the first is drawn.',
  ]);
  assert.deepEqual(ids(model.entities), ['users', 'orders']);
  assert.equal(model.entities[0]?.name, 'users');
});

test('61 entities: the first 60 are drawn, cut.entities is 61', () => {
  const entities = Array.from({ length: 61 }, (_, i) =>
    Entity(`e${i}`, `Table ${i}`),
  );
  const model = read({ entities });

  assert.deepEqual(model.findings, [
    'The EntityDiagram has 61 entities, and only the first 60 are drawn: split the diagram.',
  ]);
  assert.equal(model.cut.entities, 61);
  assert.equal(model.entities.length, 60);
  assert.equal(model.entities.at(-1)?.id, 'e59');
});

test('methods under er are dropped without a finding; under class they are read', () => {
  const er = read({
    entities: [Entity('dog', 'Dog', [], ['bark(): void'])],
  });
  assert.deepEqual(er.findings, []);
  assert.deepEqual(er.entities[0]?.methods, []);

  const uml = read({
    entities: [Entity('dog', 'Dog', [], ['bark(): void', 7, 'run(): void'])],
    notation: 'class',
  });
  assert.deepEqual(uml.findings, []);
  assert.deepEqual(uml.entities[0]?.methods, ['bark(): void', 'run(): void']);
});

test('a relation to an unknown entity is not drawn; with both ends unknown, from is named', () => {
  const model = read({
    entities: [USERS, ORDERS],
    relations: [
      Relation('users', 'ghosts'),
      Relation('nobody', 'ghosts'),
      Relation('users', 'orders'),
    ],
  });

  assert.deepEqual(model.findings, [
    'Relation "users"→"ghosts" names no Entity "ghosts", so it is not drawn.',
    'Relation "nobody"→"ghosts" names no Entity "nobody", so it is not drawn.',
  ]);
  assert.deepEqual(
    model.relations.map((relation) => [relation.from, relation.to]),
    [['users', 'orders']],
  );
});

test('121 relations: the first 120 are drawn, cut.relations is 121', () => {
  const relations = Array.from({ length: 121 }, () =>
    Relation('users', 'orders'),
  );
  const model = read({ entities: [USERS, ORDERS], relations });

  assert.deepEqual(model.findings, [
    'The EntityDiagram has 121 relations, and only the first 120 are drawn: split the diagram.',
  ]);
  assert.equal(model.cut.relations, 121);
  assert.equal(model.relations.length, 120);
});

test('a self-relation and the same relation twice are all drawn, without a finding', () => {
  const model = read({
    entities: [USERS, ORDERS],
    relations: [
      Relation('users', 'users'),
      Relation('users', 'orders'),
      Relation('users', 'orders'),
    ],
  });

  assert.deepEqual(model.findings, []);
  assert.deepEqual(
    model.relations.map((relation) => `${relation.from}>${relation.to}`),
    ['users>users', 'users>orders', 'users>orders'],
  );
});

test('kind "inherits" under er reads association, without a finding', () => {
  const model = read({
    entities: [USERS, ORDERS],
    relations: [Relation('users', 'orders', { kind: 'inherits' })],
  });

  assert.deepEqual(model.findings, []);
  assert.equal(model.relations[0]?.kind, 'association');
});

test('a 121-character name, field type, method and relation label are cut at 120 characters, one finding each', () => {
  const long = 'z'.repeat(121);
  const cut = `${'z'.repeat(119)}…`;
  const model = read({
    notation: 'class',
    entities: [
      Entity('c', long, [Field('a', long), Field('b', long)], [long, long]),
    ],
    relations: [Relation('c', 'c', { label: long })],
  });

  assert.deepEqual(model.findings, [
    'The name of Entity "c" is cut at 120 characters.',
    'A field of Entity "c" is cut at 120 characters.',
    'A method of Entity "c" is cut at 120 characters.',
    'The label of Relation "c"→"c" is cut at 120 characters.',
  ]);
  const entity = model.entities[0];
  assert.equal(entity?.name, cut);
  assert.deepEqual(
    entity?.fields.map((field) => field.type),
    [cut, cut],
  );
  assert.deepEqual(entity?.methods, [cut, cut]);
  assert.equal(model.relations[0]?.label, cut);
});

test('an empty entity name draws the id', () => {
  const model = read({ entities: [Entity('users', '')] });

  assert.deepEqual(model.findings, []);
  assert.equal(model.entities[0]?.name, 'users');
});

test('out-of-schema values read as their defaults or unset, without a finding', () => {
  const uml = read({
    notation: 'class',
    direction: 'right',
    entities: [Entity('a', 'A', [Field('id', 5, 'primary')]), Entity('b', 'B')],
    relations: [
      Relation('a', 'b', {
        kind: 'bogus',
        fromCount: '2',
        toCount: 3,
        label: 9,
      }),
    ],
  });

  assert.deepEqual(uml.findings, []);
  assert.equal(uml.notation, 'class');
  assert.equal(uml.direction, 'right');
  const field = uml.entities[0]?.fields[0];
  assert.equal(field?.name, 'id');
  assert.equal(field?.type, undefined);
  assert.equal(field?.key, undefined);
  const relation = uml.relations[0];
  assert.equal(relation?.kind, 'association');
  assert.equal(relation?.fromCount, undefined);
  assert.equal(relation?.toCount, undefined);
  assert.equal(relation?.label, undefined);

  const other = read({
    notation: 'uml',
    direction: 'up',
    entities: [Entity('a', 'A')],
  });
  assert.deepEqual(other.findings, []);
  assert.equal(other.notation, 'er');
  assert.equal(other.direction, 'down');
});

test('an empty relation label reads as absent', () => {
  const model = read({
    entities: [USERS, ORDERS],
    relations: [Relation('users', 'orders', { label: '' })],
  });

  assert.deepEqual(model.findings, []);
  assert.equal(model.relations[0]?.label, undefined);
});

test('no entities: the EntityDiagram has no entities, after the findings before it', () => {
  assert.deepEqual(read({}).findings, ['The EntityDiagram has no entities.']);
  assert.deepEqual(read({ entities: [] }).findings, [
    'The EntityDiagram has no entities.',
  ]);

  const model = read({
    entities: [Entity('', 'Nameless')],
    relations: [Relation('a', 'b')],
  });
  assert.deepEqual(model.findings, [
    'Entity "" is not drawn because an id has 1 to 64 characters.',
    'Relation "a"→"b" names no Entity "a", so it is not drawn.',
    'The EntityDiagram has no entities.',
  ]);
  assert.deepEqual(model.entities, []);
  assert.deepEqual(model.relations, []);
});

test('entity, relation and label findings come in that order', () => {
  const model = read({
    entities: [
      USERS,
      Entity('users', 'again'),
      Entity('long', 'n'.repeat(121)),
    ],
    relations: [Relation('users', 'ghosts')],
  });

  assert.deepEqual(model.findings, [
    'Entity "users" appears twice, and only the first is drawn.',
    'Relation "users"→"ghosts" names no Entity "ghosts", so it is not drawn.',
    'The name of Entity "long" is cut at 120 characters.',
  ]);
});
