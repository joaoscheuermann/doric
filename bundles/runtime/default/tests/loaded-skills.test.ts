import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderMessage } from 'llms';

import { applyCompaction } from '../src/host/compaction/compact.js';
import {
  loadedSkillCutPrompt,
  loadedSkillsOmittedPrompt,
  loadedSkillsPrompt,
} from '../src/host/prompts/skills.js';
import {
  LOADED_SKILL_MAX_CHARS_PER_ENTRY,
  LOADED_SKILLS_MAX_CHARS,
  type LoadedSkill,
  loadedSkills,
  loadedSkillsKey,
  loadedSkillsMaxChars,
  loadedSkillsReplacement,
} from '../src/host/skills/loaded.js';
import {
  defaultInstruction,
  loadCall,
  loadedEntry,
  skillText,
  toolCall,
  toolFailure,
  toolResult,
} from './support/envelopes.js';

/*
 * The skills a conversation loaded, read back from its history, and the one
 * retained "Loaded skills" message a compaction puts after its summary so the
 * skills it condensed away stay in effect.
 */

const KEY = 'default:loaded-skills';

const user = (text: string): ProviderMessage => ({
  role: 'user',
  content: text,
});

/** The loaded-skills message holding `entries` (texts, a cut one with its marker) and naming `omitted`. */
const reattach = (
  entries: readonly string[],
  omitted: readonly string[] = [],
): ProviderMessage =>
  user(
    defaultInstruction(
      'loaded-skills',
      [
        loadedSkillsPrompt,
        ...entries.map(loadedEntry),
        ...(omitted.length === 0
          ? []
          : [
              `${loadedSkillsOmittedPrompt}\n\n${omitted
                .map((locator) => `- \`${locator}\``)
                .join('\n')}`,
            ]),
      ].join('\n\n'),
    ),
  );

/** A text cut to the entry limit, with the marker that says so. */
const cut = (text: string): string =>
  `${text.slice(0, LOADED_SKILL_MAX_CHARS_PER_ENTRY)}\n\n${loadedSkillCutPrompt}`;

/** Entries without trailing whitespace, so the marker's separator does not matter. */
const trimmed = (entries: readonly LoadedSkill[]) =>
  entries.map((entry) => ({ ...entry, text: entry.text.trimEnd() }));

const A = skillText('a', 'A body.');
const B = skillText('b', 'B body.');
const C = skillText('c', 'C body.');

void test('L1 reads every loaded skill from the history, most recent first, from load_skill results and loaded-skills messages alike', () => {
  const guide = skillText(
    'mcp/docs/guide',
    'From the MCP server "Docs".',
    'Run:\n```sh\nls\n```',
  );
  const messages: readonly ProviderMessage[] = [
    user('<user-request>\nGo.\n</user-request>'),
    loadCall('c1', 'b'),
    toolResult('c1', B),
    // A failed load, an interrupted one, a dedupe note and another tool's
    // result that looks like a skill are not loaded skills.
    loadCall('c2', 'cwd/x'),
    toolFailure('c2', 'The skill cwd/x could not be loaded: gone'),
    loadCall('c3', 'cwd/y'),
    toolResult('c3', skillText('cwd/y', 'Y body.'), 'incomplete'),
    loadCall('c4', 'b'),
    toolResult('c4', 'Skill b is already loaded above; follow it.'),
    toolCall('c5', 'inspect'),
    toolResult('c5', skillText('fake', 'Not a skill.')),
    // A result that answers no call of the history.
    toolResult('orphan', skillText('z', 'Z body.')),
    reattach([A, cut(skillText('big', 'x'.repeat(30_000)))]),
    loadCall('c6', 'mcp/docs/guide'),
    toolResult('c6', guide),
    loadCall('c7', 'b'),
    toolResult('c7', skillText('b', 'B body, newer.')),
  ];

  assert.deepEqual(trimmed(loadedSkills(messages)), [
    { locator: 'b', text: skillText('b', 'B body, newer.'), cut: false },
    { locator: 'mcp/docs/guide', text: guide, cut: false },
    { locator: 'a', text: A, cut: false },
    {
      locator: 'big',
      text: skillText('big', 'x'.repeat(30_000)).slice(
        0,
        LOADED_SKILL_MAX_CHARS_PER_ENTRY,
      ),
      cut: true,
    },
    { locator: 'b', text: B, cut: false },
  ]);
});

void test('L1 finds nothing in a history without a successful load', () => {
  assert.deepEqual(
    loadedSkills([
      user('<user-request>\nGo.\n</user-request>'),
      loadCall('c1', 'b'),
      toolFailure('c1', 'Unknown skill id "b". No skill can be loaded now.'),
    ]),
    [],
  );
});

void test('L2 keeps the span loads the tail does not load again, verbatim, in one loaded-skills message', () => {
  const X = skillText('cwd/x', 'X body.');
  const messages = [
    user('go'),
    loadCall('c1', 'b'),
    toolResult('c1', B),
    loadCall('c2', 'cwd/x'),
    toolResult('c2', X),
    user('next'),
    loadCall('c3', 'b'),
    toolResult('c3', B),
  ];

  assert.equal(loadedSkillsKey, KEY);
  assert.deepEqual(loadedSkillsReplacement(messages, {}, 5, 100_000), {
    key: KEY,
    message: reattach([X]),
  });
});

void test('L2 has nothing to swap without a load in the span, or when the loaded-skills message is in the tail', () => {
  assert.equal(
    loadedSkillsReplacement([user('a'), user('b'), user('c')], {}, 2, 100_000),
    undefined,
  );
  assert.equal(
    loadedSkillsReplacement(
      [user('go'), loadCall('c1', 'a'), toolResult('c1', A), reattach([A])],
      { [KEY]: 3 },
      3,
      100_000,
    ),
    undefined,
  );
});

void test('L2 cuts a skill over 20000 characters and marks it as cut', () => {
  const big = skillText('big', 'x'.repeat(30_000));

  assert.deepEqual(
    loadedSkillsReplacement(
      [user('go'), loadCall('c1', 'big'), toolResult('c1', big), user('tail')],
      {},
      3,
      100_000,
    ),
    { key: KEY, message: reattach([cut(big)]) },
  );
});

void test('L2 takes the most recent skills that fit the total, skips one that does not for an older one that does, and names the skipped', () => {
  const sized = (locator: string) =>
    skillText(locator, 'a'.repeat(3000 - `# Skill: ${locator}\n\n`.length));
  const s0 = skillText('s0', 'tiny');
  const [s1, s2, s3] = [sized('s1'), sized('s2'), sized('s3')];
  const messages = [
    user('go'),
    loadCall('c0', 's0'),
    toolResult('c0', s0),
    loadCall('c1', 's1'),
    toolResult('c1', s1),
    loadCall('c2', 's2'),
    toolResult('c2', s2),
    loadCall('c3', 's3'),
    toolResult('c3', s3),
    user('tail'),
  ];

  assert.deepEqual(loadedSkillsReplacement(messages, {}, 9, 7000), {
    key: KEY,
    message: reattach([s3, s2, s0], ['s1']),
  });
});

void test('L2 budgets the loaded skills at a quarter of the char budget, up to 100000 characters', () => {
  assert.equal(LOADED_SKILL_MAX_CHARS_PER_ENTRY, 20_000);
  assert.equal(LOADED_SKILLS_MAX_CHARS, 100_000);
  assert.equal(loadedSkillsMaxChars(200_000), 50_000);
  assert.equal(loadedSkillsMaxChars(1_000_000), 100_000);
});

void test('L3 puts the entries of an older loaded-skills message of the span after the newer loads, and replaces it rather than adding one', () => {
  const messages = [
    user('[Context summary]\n\nEarlier work.'),
    reattach([A, B]),
    user('next'),
    loadCall('c1', 'c'),
    toolResult('c1', C),
    user('tail'),
  ];
  const retained = { [KEY]: 1 };

  const replace = loadedSkillsReplacement(messages, retained, 5, 100_000);
  assert.deepEqual(replace, { key: KEY, message: reattach([C, A, B]) });

  const applied = applyCompaction({
    messages,
    meta: { checkpoints: {}, messageCount: messages.length, retained },
    end: 5,
    trigger: 'automatic',
    summaryId: 'compaction-test',
    summary: 'facts',
    ...(replace === undefined ? {} : { replace }),
  });
  assert.deepEqual(applied.rewritten.messages, [
    applied.summaryMessage,
    reattach([C, A, B]),
    user('tail'),
  ]);
  assert.deepEqual(applied.rewritten.meta.retained, { [KEY]: 1 });
});

void test('L3 leaves out an entry of the older message that the tail loads again', () => {
  const messages = [
    user('[Context summary]\n\nEarlier work.'),
    reattach([A, B]),
    user('next'),
    loadCall('c1', 'c'),
    toolResult('c1', C),
    user('tail'),
    loadCall('c2', 'a'),
    toolResult('c2', A),
  ];

  assert.deepEqual(
    loadedSkillsReplacement(messages, { [KEY]: 1 }, 5, 100_000),
    {
      key: KEY,
      message: reattach([C, B]),
    },
  );
});

void test('L3 drops the older message when every one of its skills is loaded again in the tail', () => {
  const messages = [
    user('[Context summary]\n\nEarlier work.'),
    reattach([A]),
    user('next'),
    user('tail'),
    loadCall('c1', 'a'),
    toolResult('c1', A),
  ];
  const retained = { [KEY]: 1 };

  const replace = loadedSkillsReplacement(messages, retained, 3, 100_000);
  assert.deepEqual(replace, { key: KEY });

  const applied = applyCompaction({
    messages,
    meta: { checkpoints: {}, messageCount: messages.length, retained },
    end: 3,
    trigger: 'automatic',
    summaryId: 'compaction-test',
    summary: 'facts',
    ...(replace === undefined ? {} : { replace }),
  });
  assert.deepEqual(applied.rewritten.messages, [
    applied.summaryMessage,
    user('tail'),
    loadCall('c1', 'a'),
    toolResult('c1', A),
  ]);
  assert.deepEqual(applied.rewritten.meta.retained, {});
});
