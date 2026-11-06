// FT12 (openui-diagrams.md F3): the diagram findings in the conversation's
// check. `programCheck` (the reader's card) and `check` (the report) give one
// `runtime-error` per statement with findings, its message numbered and fitted
// to 300 code units, merged into an error the statement already has.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import type { ChatFenceView } from '../../src/client/chat-contract.js';
import { check, programCheck } from '../../src/client/check.js';
import type { ProgramRevision } from '../../src/contracts/index.js';
import { closeWindow } from './support/dom.js';
import { chatFence, revisionOf } from './support/fence.js';

after(closeWindow);

const lines = (...statements: string[]): string =>
  [...statements, ''].join('\n');

const revision = (
  program: string,
  options: Partial<ProgramRevision> = {},
): ProgramRevision => revisionOf(chatFence(program), options);

const OPEN_URL = 'OpenUrl is disabled; write the link as text';
const ASK_FORM_OFF_ROOT =
  'A question must be the root of its own fence: write root = AskForm(…) as its first line.';
/** `ask`'s refusal in a subagent's Thread, as the check reports it today. */
const REFUSED =
  'Not asked: only the main thread can ask the user. Put the question in your result instead, so your coordinator can ask the user or decide.';

test("F3's example gives exactly its line", () => {
  const program = lines(
    'root = Stack([chart])',
    'chart = Flowchart(nodes, edges)',
    'nodes = [Node("api", "API"), Node("api", "API again")]',
    'edges = [Edge("api", "db")]',
  );

  assert.deepEqual(programCheck(revision(program)), [
    {
      code: 'runtime-error',
      statementId: 'chart',
      message:
        'Diagram problems (2): 1. Node "api" appears twice, and only the first is drawn. 2. Edge "api"→"db" names no Node "db", so it is not drawn.',
    },
  ]);
});

test('a valid diagram gives no line', () => {
  const program = lines(
    'root = Stack([chart])',
    'chart = Flowchart(nodes, edges, groups, "down")',
    'nodes = [Node("web", "Web app", "round"), Node("api", "API", "box", "core")]',
    'groups = [Group("core", "Core services")]',
    'edges = [Edge("web", "api", "HTTPS")]',
  );

  assert.deepEqual(programCheck(revision(program)), []);
});

test('two Flowcharts inline in root give one line for root', () => {
  const program = lines(
    'root = Stack([Flowchart([Node("a", "A"), Node("a", "B")]), Flowchart([])])',
  );

  assert.deepEqual(programCheck(revision(program)), [
    {
      code: 'runtime-error',
      statementId: 'root',
      message:
        'Diagram problems (2): 1. Node "a" appears twice, and only the first is drawn. 2. The Flowchart has no nodes.',
    },
  ]);
});

test('a Node in a Stack draws only inside a Flowchart, on its own statement', () => {
  const program = lines('root = Stack([n])', 'n = Node("a", "A")');

  assert.deepEqual(programCheck(revision(program)), [
    {
      code: 'runtime-error',
      statementId: 'n',
      message: 'Diagram problems (1): 1. Node draws only inside a Flowchart.',
    },
  ]);
});

test('@OpenUrl and a diagram finding on one statement give one line holding both', () => {
  const program = lines(
    'root = Stack([Button("Go", @OpenUrl("https://example.com")), Flowchart([])])',
  );

  assert.deepEqual(programCheck(revision(program)), [
    {
      code: 'runtime-error',
      statementId: 'root',
      message: `${OPEN_URL}; Diagram problems (1): 1. The Flowchart has no nodes.`,
    },
  ]);
});

test('@OpenUrl, an AskForm off the root and a diagram finding: the diagram merges into the @OpenUrl error', () => {
  const program = lines(
    'root = Stack([Button("Go", @OpenUrl("https://example.com")), AskForm([q]), Flowchart([])])',
    'q = AskQuestion("db", "Which database?", [pg, lite])',
    'pg = AskOption("Postgres", "Relational")',
    'lite = AskOption("SQLite", "One file")',
  );

  assert.deepEqual(programCheck(revision(program)), [
    {
      code: 'runtime-error',
      statementId: 'root',
      message: `${OPEN_URL}; Diagram problems (1): 1. The Flowchart has no nodes.`,
    },
    { code: 'runtime-error', statementId: 'root', message: ASK_FORM_OFF_ROOT },
  ]);
});

test('20 findings give one message of at most 300 code units ending with how many are not shown', () => {
  const repeats = Array.from({ length: 20 }, () => 'Node("a", "A")');
  const program = lines(
    'root = Stack([chart])',
    'chart = Flowchart(nodes)',
    `nodes = [Node("a", "A"), ${repeats.join(', ')}]`,
  );
  const finding = 'Node "a" appears twice, and only the first is drawn.';

  const errors = programCheck(revision(program));
  assert.equal(errors.length, 1);
  const { code, statementId, message } = errors[0] as {
    code: string;
    statementId: string;
    message: string;
  };
  assert.equal(code, 'runtime-error');
  assert.equal(statementId, 'chart');
  assert.ok(message.length <= 300, `${message.length} code units`);

  const notShown = / (\d+) more not shown\.$/.exec(message);
  assert.ok(notShown !== null, message);
  const left = Number(notShown[1]);
  assert.ok(left >= 1 && left < 20, message);

  const shown = Array.from(
    { length: 20 - left },
    (_, i) => `${i + 1}. ${finding}`,
  ).join(' ');
  assert.equal(
    message,
    `Diagram problems (20): ${shown} ${left} more not shown.`,
  );
  // Findings are added while there is room: one more would not fit.
  const oneMore = `Diagram problems (20): ${shown} ${21 - left}. ${finding}${
    left > 1 ? ` ${left - 1} more not shown.` : ''
  }`;
  assert.ok(oneMore.length > 300, oneMore);
});

test('an edge whose three ids are 24 control characters each: not even the first finding fits', () => {
  // Written escaped in the program; each character is six code units once
  // JSON-escaped in the finding (\u0001), so the finding alone exceeds 300.
  const from = '\\u0001'.repeat(24);
  const to = '\\u0002'.repeat(24);
  const program = lines(
    'root = Stack([chart])',
    'chart = Flowchart(nodes, edges)',
    'nodes = [Node("a", "A")]',
    `edges = [Edge("${from}", "${to}")]`,
  );

  assert.deepEqual(programCheck(revision(program)), [
    {
      code: 'runtime-error',
      statementId: 'chart',
      message: 'Diagram problems (1): 1 more not shown.',
    },
  ]);
});

test("through check: a question fence in an agent Thread with an inline Flowchart's finding gives one root line", () => {
  const program = lines('root = Stack([Flowchart([])])');
  const fence = chatFence(program);
  const view: ChatFenceView = { fence, origin: 'agent', fences: [fence] };

  assert.deepEqual(check(view, revisionOf(fence, { question: true })), [
    {
      code: 'runtime-error',
      statementId: 'root',
      message: `${REFUSED}; Diagram problems (1): 1. The Flowchart has no nodes.`,
    },
  ]);
});

test('through check: a fence of a main Thread reports the same diagram line as programCheck', () => {
  const program = lines(
    'root = Stack([chart])',
    'chart = Flowchart(nodes)',
    'nodes = [Node("api", "API"), Node("api", "API again")]',
  );
  const fence = chatFence(program);
  const view: ChatFenceView = { fence, origin: 'user', fences: [fence] };

  assert.deepEqual(check(view, revisionOf(fence)), [
    {
      code: 'runtime-error',
      statementId: 'chart',
      message:
        'Diagram problems (1): 1. Node "api" appears twice, and only the first is drawn.',
    },
  ]);
});

// FT21 (openui-diagrams-phase2.md F15): a MindMap's findings go to its
// statement, also from a branch statement; parts outside their diagram and
// diagrams inside another diagram give their own line.

/** A chain of `Topic`s, each the only child of the one before. */
const topicChain = (labels: readonly string[]): string => {
  const [first, ...rest] = labels;
  return rest.length === 0
    ? `Topic("${first}")`
    : `Topic("${first}", [${topicChain(rest)}])`;
};

const DEEP =
  'Diagram problems (1): 1. Topic "A › B › C › D › E › F › G › H › I" is deeper than 8 levels, so it and its subtopics are not drawn.';

test('FT21: a MindMap with a 9-level topic gives one line on its statement', () => {
  const program = lines(
    'root = Stack([map])',
    'map = MindMap(top, "right")',
    `top = ${topicChain(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'])}`,
  );

  assert.deepEqual(programCheck(revision(program)), [
    { code: 'runtime-error', statementId: 'map', message: DEEP },
  ]);
});

test("FT21: a 9-level topic in a branch statement gives the line on the MindMap's statement", () => {
  const program = lines(
    'root = Stack([map])',
    'map = MindMap(top, "right")',
    'top = Topic("A", [b1, b2])',
    `b1 = ${topicChain(['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'])}`,
    'b2 = Topic("Z")',
  );

  assert.deepEqual(programCheck(revision(program)), [
    { code: 'runtime-error', statementId: 'map', message: DEEP },
  ]);
});

test('FT21: a Topic in a Stack draws only inside a MindMap, on its own statement', () => {
  const program = lines('root = Stack([t])', 't = Topic("A")');

  assert.deepEqual(programCheck(revision(program)), [
    {
      code: 'runtime-error',
      statementId: 't',
      message: 'Diagram problems (1): 1. Topic draws only inside a MindMap.',
    },
  ]);
});

test("FT21: a Node in a MindMap's children draws only inside a Flowchart", () => {
  const program = lines(
    'root = Stack([map])',
    'map = MindMap(top)',
    'top = Topic("A", [n, Topic("B")])',
    'n = Node("x", "X")',
  );

  assert.deepEqual(programCheck(revision(program)), [
    {
      code: 'runtime-error',
      statementId: 'n',
      message: 'Diagram problems (1): 1. Node draws only inside a Flowchart.',
    },
  ]);
});

test("FT21: a Flowchart in a Topic's children is not drawn inside a MindMap, and its nodes add nothing", () => {
  const program = lines(
    'root = Stack([map])',
    'map = MindMap(top)',
    'top = Topic("A", [chart, Topic("B")])',
    'chart = Flowchart(nodes)',
    'nodes = [Node("a", "A"), Node("a", "A again")]',
  );

  assert.deepEqual(programCheck(revision(program)), [
    {
      code: 'runtime-error',
      statementId: 'chart',
      message:
        'Diagram problems (1): 1. Flowchart is not drawn inside a MindMap.',
    },
  ]);
});

// FT30 (F15): a sequence part outside its diagram, and a SequenceDiagram's
// many findings fitted into one line.

test('FT30: a Section in a Stack draws only inside a SequenceDiagram', () => {
  const program = lines('root = Stack([s])', 's = Section("ok", [])');

  assert.deepEqual(programCheck(revision(program)), [
    {
      code: 'runtime-error',
      statementId: 's',
      message:
        'Diagram problems (1): 1. Section draws only inside a SequenceDiagram.',
    },
  ]);
});

test('FT30: a SequenceDiagram with 25 findings gives one message of at most 300 code units', () => {
  const repeats = Array.from({ length: 25 }, () => 'Participant("a", "A")');
  const program = lines(
    'root = Stack([seq])',
    'seq = SequenceDiagram(participants)',
    `participants = [Participant("a", "A"), ${repeats.join(', ')}]`,
  );
  const finding = 'Participant "a" appears twice, and only the first is drawn.';

  const errors = programCheck(revision(program));
  assert.equal(errors.length, 1);
  const { code, statementId, message } = errors[0] as {
    code: string;
    statementId: string;
    message: string;
  };
  assert.equal(code, 'runtime-error');
  assert.equal(statementId, 'seq');
  assert.ok(message.length <= 300, `${message.length} code units`);

  const notShown = / (\d+) more not shown\.$/.exec(message);
  assert.ok(notShown !== null, message);
  const left = Number(notShown[1]);
  assert.ok(left >= 1 && left < 25, message);
  const shown = Array.from(
    { length: 25 - left },
    (_, i) => `${i + 1}. ${finding}`,
  ).join(' ');
  assert.equal(
    message,
    `Diagram problems (25): ${shown} ${left} more not shown.`,
  );
});
