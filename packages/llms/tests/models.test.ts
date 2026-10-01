import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { modelCatalog } from '../src/index.js';

describe('an endpoint model catalog', () => {
  test('names each model with what it advertises', () => {
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
    });
    assert.deepEqual(catalog.get('google/gemma-3-27b'), {
      id: 'google/gemma-3-27b',
      reasonings: [],
      parameters: ['temperature'],
    });
  });

  test('reads an answer that lists nothing as an empty catalog', () => {
    assert.deepEqual([...modelCatalog({}).keys()], []);
    assert.deepEqual([...modelCatalog({ data: 'none' }).keys()], []);
  });
});
