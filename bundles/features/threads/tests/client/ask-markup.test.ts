// The markup of `threads`' ask block, recorded for `openui` (conversation-openui.md
// C9). While both bundles draw questions, `openui`'s copy of `AskQuestions`
// must draw what this one draws: this test renders this bundle's block in
// each of the 12 states its stories show (`stories/ask.stories.tsx`, the
// `states` list `AllStates` draws), with a no-op `onSend`, and compares the
// markup with `bundles/features/openui/tests/fixtures/ask-markup.json`, which
// `openui`'s own `tests/client/ask-markup.test.ts` renders its copy against.
//
// `ASK_MARKUP_UPDATE=1` writes the fixture from this render instead.
//
// The fixture: `{ "states": [{ "label", "props", "html" }] }`, one entry per
// story state in the stories' order; `props` are the story's props without
// `onSend`, and `html` is `renderToStaticMarkup` of `AskQuestions` with them.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AskQuestions } from '../../src/client/ask.js';
import { states } from '../../stories/ask.stories.js';

const here = dirname(fileURLToPath(import.meta.url));
/** From `dist-tests/tests/client` back to the repository's bundles. */
const FIXTURE = resolve(
  here,
  '../../../../openui/tests/fixtures/ask-markup.json',
);

interface MarkupState {
  readonly label: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly html: string;
}

const rendered = (): MarkupState[] =>
  states.map(([label, props]) => ({
    label,
    props: JSON.parse(JSON.stringify(props)) as Record<string, unknown>,
    html: renderToStaticMarkup(
      createElement(AskQuestions, {
        ...props,
        onSend: () => Promise.resolve(),
      }),
    ),
  }));

test("the ask block draws, in each of its stories' 12 states, the markup openui's copy is held to", async () => {
  const current = rendered();
  assert.equal(current.length, 12, 'the stories show 12 states');

  if (process.env.ASK_MARKUP_UPDATE === '1') {
    await mkdir(dirname(FIXTURE), { recursive: true });
    await writeFile(
      FIXTURE,
      `${JSON.stringify({ states: current }, null, 2)}\n`,
    );
    return;
  }

  const recorded = JSON.parse(await readFile(FIXTURE, 'utf8')) as {
    states: MarkupState[];
  };
  assert.deepEqual(
    recorded.states.map((state) => [state.label, state.props]),
    current.map((state) => [state.label, state.props]),
    'the fixture holds the stories’ states; run with ASK_MARKUP_UPDATE=1',
  );
  for (const [at, state] of current.entries()) {
    assert.equal(recorded.states[at]?.html, state.html, state.label);
  }
});
