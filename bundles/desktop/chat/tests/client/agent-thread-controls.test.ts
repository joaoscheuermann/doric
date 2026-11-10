// The identity an agent Thread wears in its footer (Figma `32:49144`): the
// "Agent thread · <status>" words are 12/16 Light in `--muted-foreground`, set
// on the identity itself, so the footer band they sit in does not decide them.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentThreadControls } from '../../src/client/components/organisms/agent-thread-controls.js';

const noop = () => {};

test('the agent identity is 12 px Light in the muted colour, whatever the band sets', () => {
  const markup = renderToStaticMarkup(
    createElement(AgentThreadControls, {
      control: {
        status: 'idle',
        canPause: false,
        canContinue: false,
        canRetry: true,
      },
      onContinue: noop,
      onPause: noop,
      onRetry: noop,
    }),
  );
  const tag = /<span[^>]*data-slot="agent-thread-identity"[^>]*>/.exec(
    markup,
  )?.[0];
  assert.ok(tag, `no agent identity in ${markup}`);
  const classes = (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(' ');
  for (const name of ['text-xs', 'font-light', 'text-muted-foreground']) {
    assert.ok(classes.includes(name), `the identity lacks ${name}: ${tag}`);
  }
  assert.match(markup, /Finished/);
});
