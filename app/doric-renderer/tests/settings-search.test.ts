import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { filterSettingsSections } from '../src/domain/settings-search';

/** The settings sections as the window holds them, named by the text they show. */
const sections = [
  {
    id: 'providers',
    label: 'Providers',
    description: 'Every provider Doric may call.',
  },
  {
    id: 'execution',
    label: 'Execution',
    description: 'The model on the provider and the turn limit of one prompt.',
  },
  {
    id: 'credentials',
    label: 'Credentials',
    description: 'Secrets the host stores and never sends back.',
  },
] as const;

const ids = (query: string): string[] =>
  filterSettingsSections(sections, query).map((section) => section.id);

describe('settings search', () => {
  test('keeps every section, in the order given, while nothing is typed', () => {
    assert.deepEqual(ids(''), ['providers', 'execution', 'credentials']);
  });

  test('keeps every section for a query of blank space alone', () => {
    assert.deepEqual(ids('   '), ['providers', 'execution', 'credentials']);
  });

  test('matches a label whatever its case and wherever the text sits in it', () => {
    assert.deepEqual(ids('cred'), ['credentials']);
    assert.deepEqual(ids('PROVIDERS'), ['providers']);
    assert.deepEqual(ids('cuti'), ['execution']);
  });

  test('matches the description of a section whose label never says the word', () => {
    assert.deepEqual(ids('turn limit'), ['execution']);
    assert.deepEqual(ids('SECRETS'), ['credentials']);
  });

  test('keeps several matches, in the order the sections were given', () => {
    assert.deepEqual(ids('the'), ['execution', 'credentials']);
    assert.deepEqual(ids('o'), ['providers', 'execution', 'credentials']);
  });

  test('keeps nothing when no section says what was typed', () => {
    assert.deepEqual(ids('sandbox'), []);
  });

  test('ignores blank space around what was typed', () => {
    assert.deepEqual(ids('  credentials '), ['credentials']);
  });

  test('matches a section that carries a label alone', () => {
    assert.deepEqual(filterSettingsSections([{ label: 'Advanced' }], 'dv'), [
      { label: 'Advanced' },
    ]);
  });
});
