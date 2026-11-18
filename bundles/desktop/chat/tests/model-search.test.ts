// The footer picker's model search (bundle isolation 6(c), O8): the groups
// `settings.models/v1` answers, narrowed to the choices whose label holds the
// typed text. Moved from `settings`' `tests/config.test.ts`, over literal
// groups.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ReasoningEffort } from 'runtime/contracts';

import { searchModelGroups } from '../src/client/domain/model-search.js';

/** The groups of `settings.models/v1`'s view, as the contract types them. */
type Groups = readonly {
  readonly label?: string;
  readonly choices: readonly {
    readonly label: string;
    readonly value: string;
    readonly icon?: string;
    readonly execution: {
      readonly providerId: string;
      readonly model: string;
      readonly effort?: ReasoningEffort;
    };
  }[];
}[];

const svg = '<svg id="gpt"></svg>';

const groups: Groups = [
  {
    label: 'OpenAI',
    choices: [
      {
        label: 'gpt-5',
        value: 'openai:gpt-5',
        icon: svg,
        execution: { providerId: 'openai', model: 'gpt-5', effort: 'medium' },
      },
      {
        label: 'o3',
        value: 'openai:o3',
        execution: { providerId: 'openai', model: 'o3' },
      },
    ],
  },
  {
    label: 'Anthropic',
    choices: [
      {
        label: 'claude-sonnet',
        value: 'anthropic:claude-sonnet',
        execution: { providerId: 'anthropic', model: 'claude-sonnet' },
      },
    ],
  },
];

/** The groups narrowed to `query`. */
const search = (query: string): Groups => searchModelGroups(groups, query);

const labels = (found: Groups): string[][] =>
  found.map((group) => group.choices.map((choice) => choice.label));

describe('searching the model groups', () => {
  test('narrows the groups to a matching name, and drops the emptied ones', () => {
    assert.deepEqual(labels(search('gpt')), [['gpt-5']]);
    assert.deepEqual(
      search('gpt').map((group) => group.label),
      ['OpenAI'],
    );
    assert.deepEqual(search('nope'), []);
  });

  test('a blank query answers the groups as they are', () => {
    assert.deepEqual(search(''), groups);
    assert.deepEqual(search('  '), groups);
  });

  test('matches the trimmed query in any case', () => {
    assert.deepEqual(labels(search('  GPT ')), [['gpt-5']]);
    assert.deepEqual(labels(search('Sonnet')), [['claude-sonnet']]);
  });

  test('a narrowed choice keeps its icon and its execution', () => {
    assert.deepEqual(
      search('gpt').map((group) => group.choices),
      [
        [
          {
            label: 'gpt-5',
            value: 'openai:gpt-5',
            icon: svg,
            execution: {
              providerId: 'openai',
              model: 'gpt-5',
              effort: 'medium',
            },
          },
        ],
      ],
    );
  });
});
