// FT28 (openui-diagrams-phase2.md F14): `readSequence` reads a
// SequenceDiagram element's props, as lang-core passes them, into the drawn
// participants and steps and the findings. One case per rule of F14: the parts
// kept, and the exact finding texts in order.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  readSequence,
  type SeqStep,
  type SequenceModel,
} from '../../src/client/diagram/sequence-model.js';

const element = (typeName: string, props: Record<string, unknown>) => ({
  type: 'element',
  typeName,
  props,
});

const Participant = (id: string, label: string) =>
  element('Participant', { id, label });
const Message = (from: string, to: string, text: string, kind?: unknown) =>
  element('Message', {
    from,
    to,
    text,
    ...(kind === undefined ? {} : { kind }),
  });
const Note = (text: string, over: readonly string[]) =>
  element('Note', { text, over });
const Section = (label: string, steps: readonly unknown[]) =>
  element('Section', { label, steps });
const Fragment = (kind: unknown, sections: readonly unknown[]) =>
  element('Fragment', { kind, sections });

const A = Participant('a', 'Alice');
const B = Participant('b', 'Bob');

const read = (props: unknown): SequenceModel => readSequence(props);

/** `count` messages a→b numbered from `from`. */
const messages = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => Message('a', 'b', `m${from + i}`));

const message = (
  from: string,
  to: string,
  text: string,
  kind: 'call' | 'reply' | 'async' = 'call',
): SeqStep => ({ type: 'message', from, to, text, kind });

test('a sequence with defaults reads its participants and steps without findings', () => {
  const model = read({
    participants: [A, B],
    steps: [
      Message('a', 'b', 'login'),
      Message('b', 'a', 'token', 'reply'),
      Note('checks the password', ['b']),
    ],
  });

  assert.deepEqual(model.findings, []);
  assert.deepEqual(model.participants, [
    { id: 'a', label: 'Alice' },
    { id: 'b', label: 'Bob' },
  ]);
  assert.deepEqual(model.steps, [
    message('a', 'b', 'login'),
    message('b', 'a', 'token', 'reply'),
    { type: 'note', text: 'checks the password', over: ['b'] },
  ]);
});

test('21 participants: the first 20 are drawn, cut.participants is 21', () => {
  const participants = Array.from({ length: 21 }, (_, i) =>
    Participant(`p${i}`, `Service ${i}`),
  );
  const model = read({ participants });

  assert.deepEqual(model.findings, [
    'The SequenceDiagram has 21 participants, and only the first 20 are drawn: split the diagram.',
  ]);
  assert.equal(model.cut.participants, 21);
  assert.equal(model.participants.length, 20);
});

test('a repeated participant id: only the first is drawn', () => {
  const model = read({ participants: [A, Participant('a', 'Again'), B] });

  assert.deepEqual(model.findings, [
    'Participant "a" appears twice, and only the first is drawn.',
  ]);
  assert.deepEqual(
    model.participants.map((participant) => participant.label),
    ['Alice', 'Bob'],
  );
});

test('a Section in steps and a Message in sections are not drawn, each with its finding', () => {
  const model = read({
    participants: [A, B],
    steps: [
      Section('stray', [Message('a', 'b', 'lost')]),
      Fragment('opt', [
        Message('a', 'b', 'misplaced'),
        Section('ok', [Message('a', 'b', 'kept')]),
      ]),
    ],
  });

  assert.deepEqual(model.findings, [
    'A Section in steps is not drawn: steps holds Message, Note and Fragment.',
    'A Message in sections is not drawn: sections holds Section.',
  ]);
  assert.deepEqual(model.steps, [
    {
      type: 'fragment',
      kind: 'opt',
      sections: [{ label: 'ok', steps: [message('a', 'b', 'kept')] }],
    },
  ]);
});

test("a Section in a Section's steps is misplaced; an entry of another kind is skipped without a finding", () => {
  const model = read({
    participants: [A, B],
    steps: [
      element('Node', { id: 'n', label: 'N' }),
      Fragment('loop', [
        Section('each', [Section('inner', []), Message('a', 'b', 'tick')]),
      ]),
    ],
  });

  assert.deepEqual(model.findings, [
    'A Section in steps is not drawn: steps holds Message, Note and Fragment.',
  ]);
  assert.equal(model.steps.length, 1);
});

test('a message to an unknown participant is not drawn', () => {
  const model = read({
    participants: [A, B],
    steps: [Message('a', 'z', 'lost'), Message('y', 'z', 'lost too')],
  });

  assert.deepEqual(model.findings, [
    'Message "a"→"z" names no Participant "z", so it is not drawn.',
    'Message "y"→"z" names no Participant "y", so it is not drawn.',
  ]);
  assert.deepEqual(model.steps, []);
});

test('a note over no participant, and one over an unknown id, are not drawn', () => {
  const model = read({
    participants: [A, B],
    steps: [Note('hi', []), Note('yo', ['a', 'z', 'y'])],
  });

  assert.deepEqual(model.findings, [
    'Note "hi" names no Participant, so it is not drawn.',
    'Note "yo" names no Participant "z", so it is not drawn.',
  ]);
  assert.deepEqual(model.steps, []);
});

test('149 messages, then a fragment holding 80: the fragment is drawn with its first 50, cut.steps is 230', () => {
  const model = read({
    participants: [A, B],
    steps: [
      ...messages(149),
      Fragment('loop', [Section('retry', messages(80, 150))]),
    ],
  });

  assert.deepEqual(model.findings, [
    'The SequenceDiagram has 230 steps, and only the first 200 are drawn: split the diagram.',
  ]);
  assert.equal(model.cut.steps, 230);
  assert.equal(model.steps.length, 150);
  const fragment = model.steps[149];
  assert.equal(fragment?.type, 'fragment');
  const inside =
    fragment?.type === 'fragment' ? (fragment.sections[0]?.steps ?? []) : [];
  assert.equal(inside.length, 50);
  assert.deepEqual(inside.at(-1), message('a', 'b', 'm199'));
});

test('199 messages, then a fragment numbered 200 holding 3: the fragment is not drawn, only the limit finding', () => {
  const model = read({
    participants: [A, B],
    steps: [
      ...messages(199),
      Fragment('opt', [Section('maybe', messages(3, 200))]),
    ],
  });

  assert.deepEqual(model.findings, [
    'The SequenceDiagram has 203 steps, and only the first 200 are drawn: split the diagram.',
  ]);
  assert.equal(model.cut.steps, 203);
  assert.equal(model.steps.length, 199);
  assert.ok(model.steps.every((step) => step.type === 'message'));
});

test('an alt whose sections hold only invalid steps is not drawn, with one finding of its own and no number', () => {
  const model = read({
    participants: [A, B],
    steps: [
      ...messages(199),
      Fragment('alt', [
        Section('ok', [Message('a', 'z', 'x')]),
        Section('else', [Message('z', 'a', 'y')]),
      ]),
      Message('b', 'a', 'last'),
    ],
  });

  assert.deepEqual(model.findings, [
    'Message "a"→"z" names no Participant "z", so it is not drawn.',
    'Message "z"→"a" names no Participant "z", so it is not drawn.',
    'Fragment "alt" "ok" holds no step, so it is not drawn.',
  ]);
  assert.equal(model.cut.steps, undefined);
  assert.equal(model.steps.length, 200);
  assert.deepEqual(model.steps.at(-1), message('b', 'a', 'last'));
});

test('a fragment with no section holds no step, labelled ""', () => {
  const model = read({
    participants: [A, B],
    steps: [Fragment('par', [])],
  });

  assert.deepEqual(model.findings, [
    'Fragment "par" "" holds no step, so it is not drawn.',
  ]);
  assert.deepEqual(model.steps, []);
});

test('fragments nested three deep, a self-message and an empty section are drawn as written', () => {
  const model = read({
    participants: [A, B],
    steps: [
      Fragment('loop', [
        Section('each', [
          Fragment('opt', [
            Section('if any', [
              Fragment('par', [
                Section('one', [Message('a', 'a', 'think')]),
                Section('two', []),
              ]),
            ]),
          ]),
        ]),
      ]),
    ],
  });

  assert.deepEqual(model.findings, []);
  assert.deepEqual(model.steps, [
    {
      type: 'fragment',
      kind: 'loop',
      sections: [
        {
          label: 'each',
          steps: [
            {
              type: 'fragment',
              kind: 'opt',
              sections: [
                {
                  label: 'if any',
                  steps: [
                    {
                      type: 'fragment',
                      kind: 'par',
                      sections: [
                        { label: 'one', steps: [message('a', 'a', 'think')] },
                        { label: 'two', steps: [] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ]);
});

test('kind "bogus" reads call for a message and loop for a fragment, without a finding', () => {
  const model = read({
    participants: [A, B],
    steps: [
      Message('a', 'b', 'hello', 'bogus'),
      Fragment('bogus', [Section('', [Message('b', 'a', 'hi')])]),
    ],
  });

  assert.deepEqual(model.findings, []);
  assert.deepEqual(model.steps[0], message('a', 'b', 'hello'));
  assert.equal(
    model.steps[1]?.type === 'fragment' && model.steps[1].kind,
    'loop',
  );
});

test('a 121-character participant label, message text, note text and section label are cut, one finding each', () => {
  const long = (c: string) => c.repeat(121);
  const cut = (c: string) => `${c.repeat(119)}…`;
  const model = read({
    participants: [Participant('a', long('p')), B],
    steps: [
      Message('a', 'b', long('m')),
      Note(long('n'), ['a']),
      Fragment('opt', [Section(long('s'), [Message('b', 'a', 'ok')])]),
    ],
  });

  assert.deepEqual(model.findings, [
    'The label of Participant "a" is cut at 120 characters.',
    'The text of Message "a"→"b" is cut at 120 characters.',
    `The text of Note "${'n'.repeat(23)}…" is cut at 120 characters.`,
    `The label of Section "${'s'.repeat(23)}…" is cut at 120 characters.`,
  ]);
  assert.equal(model.participants[0]?.label, cut('p'));
  assert.deepEqual(model.steps[0], message('a', 'b', cut('m')));
  assert.deepEqual(model.steps[1], {
    type: 'note',
    text: cut('n'),
    over: ['a'],
  });
  const fragment = model.steps[2];
  assert.equal(
    fragment?.type === 'fragment' ? fragment.sections[0]?.label : undefined,
    cut('s'),
  );
});

test('an empty participant label draws the id', () => {
  const model = read({ participants: [Participant('api', '')] });

  assert.deepEqual(model.findings, []);
  assert.deepEqual(model.participants, [{ id: 'api', label: 'api' }]);
});

test('no participants: the SequenceDiagram has no participants, after the step findings', () => {
  assert.deepEqual(read({}).findings, [
    'The SequenceDiagram has no participants.',
  ]);
  assert.deepEqual(
    read({ participants: [], steps: [Message('a', 'b', 'x')] }).findings,
    [
      'Message "a"→"b" names no Participant "a", so it is not drawn.',
      'The SequenceDiagram has no participants.',
    ],
  );
});
