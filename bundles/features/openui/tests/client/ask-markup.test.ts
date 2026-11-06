// C9 (conversation-openui.md D21): `openui`'s copy of `AskQuestions` renders
// the markup `threads`' copy rendered. `tests/fixtures/ask-markup.json` is
// `{ states: [{ label, props, html }] }`: the props (without `onSend`) of the
// 12 states `threads`' ask stories exported as `states`, with
// `renderToStaticMarkup(AskQuestions)` of `threads`' copy for each. `threads`
// 2.0.0 removed `ask` (D30), so the fixture is frozen: nothing writes it any
// more. With `settledHeading`, `disabled` and `note` at their defaults,
// `openui`'s copy must render the same markup.

import './support/dom.js';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';

import { type ComponentType, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { closeWindow } from './support/dom.js';

/** `src/client/question/ask.tsx`, the copy of `threads`' `AskQuestions` (D21). */
interface AskModule {
  readonly AskQuestions: ComponentType<Record<string, unknown>>;
}

interface State {
  readonly label: string;
  readonly props: Record<string, unknown>;
  readonly html: string;
}

interface Fixture {
  readonly states: readonly State[];
}

/** The fixture, beside the sources: tests run from `dist-tests/tests/client`. */
const FIXTURE = new URL(
  '../../../tests/fixtures/ask-markup.json',
  import.meta.url,
);

const readStates = async (): Promise<readonly State[]> =>
  (JSON.parse(await readFile(FIXTURE, 'utf8')) as Fixture).states;

after(closeWindow);

test('the fixture holds the 12 states of the stories', async () => {
  const states = await readStates();

  assert.equal(states.length, 12);
  for (const state of states)
    assert.ok(state.html.startsWith('<section'), state.label);
});

test("openui's AskQuestions renders threads' markup for each state", async () => {
  const states = await readStates();
  const { AskQuestions } = (await import(
    new URL('../../src/client/question/ask.js', import.meta.url).href
  )) as AskModule;

  for (const { label, props, html } of states) {
    const markup = renderToStaticMarkup(
      createElement(AskQuestions, {
        ...props,
        onSend: () => Promise.resolve(),
      }),
    );

    assert.equal(markup, html, label);
  }
});
