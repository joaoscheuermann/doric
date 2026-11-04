// The site a provider kind's page links to. What a provider is drawn as is the
// host's icon answer, proven by the dashboard's window test.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { providerSite } from '../src/client/domain/provider-icon.js';

describe('provider sites', () => {
  test('OpenRouter links to its site; a kind without one links nowhere', () => {
    assert.deepEqual(providerSite('openrouter'), {
      url: 'https://openrouter.ai',
      label: 'Open OpenRouter',
    });
    assert.equal(providerSite('openai'), undefined);
  });
});
