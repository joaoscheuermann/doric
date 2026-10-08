import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { modelCatalog } from '../src/index.js';

void describe('an endpoint model catalog', () => {
  void test('names each model with what it advertises', () => {
    const catalog = modelCatalog({
      data: [
        {
          id: 'openai/gpt-5',
          name: 'OpenAI: GPT-5',
          supported_parameters: ['tools', 'tool_choice', 'temperature'],
          reasoning: { supported_efforts: ['high', 'medium', 'ultra'] },
        },
        { id: 'google/gemma-3-27b', supported_parameters: ['temperature'] },
        { id: '', supported_parameters: [] },
      ],
    });

    assert.deepEqual(
      [...catalog.keys()],
      ['openai/gpt-5', 'google/gemma-3-27b', ''],
    );
    assert.deepEqual(catalog.get('openai/gpt-5'), {
      id: 'openai/gpt-5',
      name: 'OpenAI: GPT-5',
      // An effort this library cannot send is not one a model accepts here.
      reasonings: ['high', 'medium'],
      parameters: ['tools', 'tool_choice', 'temperature'],
      mandatory: false,
    });
    assert.deepEqual(catalog.get('google/gemma-3-27b'), {
      id: 'google/gemma-3-27b',
      reasonings: [],
      parameters: ['temperature'],
      mandatory: false,
    });
  });

  void test('reads the default effort and the reasoning a catalog pins on', () => {
    const catalog = modelCatalog({
      data: [
        {
          id: 'anthropic/claude-sonnet',
          reasoning: {
            supported_efforts: ['high', 'medium', 'low'],
            default_effort: 'high',
            mandatory: true,
          },
        },
        {
          // An effort the model does not list, and an effort no request can
          // carry, are both no default at all.
          id: 'openai/gpt-5',
          reasoning: {
            supported_efforts: ['medium'],
            default_effort: 'ultra',
          },
        },
      ],
    });

    assert.deepEqual(catalog.get('anthropic/claude-sonnet'), {
      id: 'anthropic/claude-sonnet',
      reasonings: ['high', 'medium', 'low'],
      parameters: [],
      defaultEffort: 'high',
      mandatory: true,
    });
    assert.deepEqual(catalog.get('openai/gpt-5'), {
      id: 'openai/gpt-5',
      reasonings: ['medium'],
      parameters: [],
      mandatory: false,
    });
  });

  void test('reads an answer that lists nothing as an empty catalog', () => {
    assert.deepEqual([...modelCatalog({}).keys()], []);
    assert.deepEqual([...modelCatalog({ data: 'none' }).keys()], []);
  });
});
