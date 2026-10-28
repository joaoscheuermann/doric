import type { ProviderMessage } from 'llms';

import type { RetainedReplacement } from '../compaction/rewrite.js';
import { bundleInstruction } from '../envelope.js';
import {
  loadedSkillCutPrompt,
  loadedSkillsOmittedPrompt,
  loadedSkillsPrompt,
} from '../prompts/skills.js';
import { retainedKey } from '../repository.js';
import { LOAD_SKILL_TOOL } from './load-skill.js';

export const LOADED_SKILL_MAX_CHARS_PER_ENTRY = 20_000;
export const LOADED_SKILLS_MAX_CHARS = 100_000;

/** The meta.retained key of the loaded-skills message: retainedKey('default', 'loaded-skills'). */
export const loadedSkillsKey: string = retainedKey('default', 'loaded-skills');

/** Math.min(LOADED_SKILLS_MAX_CHARS, Math.floor(charBudget / 4)). Pure. */
export const loadedSkillsMaxChars = (charBudget: number): number =>
  Math.min(LOADED_SKILLS_MAX_CHARS, Math.floor(charBudget / 4));

/** One skill text found in a history. */
export interface LoadedSkill {
  /** text after `# Skill: ` on its first line */
  readonly locator: string;
  /** the load_skill output without the fence's added final newline; for a cut entry without the cut marker */
  readonly text: string;
  /** whether a loaded-skills message cut it */
  readonly cut: boolean;
}

const SKILL_HEADING = '# Skill: ';
const OUTPUT_HEADING = '\n## Output\n\n';

/** The first line of every loaded-skills message. */
const loadedSkillsOpening =
  bundleInstruction('loaded-skills', '').split('\n')[0] ?? '';

/** What ends the text of an entry a loaded-skills message cut. */
const cutMarker = `\n\n${loadedSkillCutPrompt}`;

/** `text` in a `text` fence one backtick longer than its longest run (at least three). */
const fenced = (text: string): string => {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/gu)].map(([run]) => run.length),
  );
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
};

/** The skill a text names on its first line, or undefined when it names none. */
const skillOf = (text: string, cut: boolean): LoadedSkill | undefined => {
  if (!text.startsWith(SKILL_HEADING)) return undefined;
  const locator = text.slice(SKILL_HEADING.length).split('\n')[0] ?? '';
  return locator === '' ? undefined : { locator, text, cut };
};

/** The text of a successful tool result's output fence, or undefined. */
const toolOutput = (content: string): string | undefined => {
  if (!content.startsWith('# Tool Result')) return undefined;
  const at = content.indexOf(OUTPUT_HEADING);
  if (at === -1) return undefined;
  const block = content.slice(at + OUTPUT_HEADING.length);
  const open = /^(`{3,})text\n/u.exec(block);
  const fence = open?.[1];
  if (open === null || fence === undefined) return undefined;
  const inner = block.slice(open[0].length);
  return inner.endsWith(`\n${fence}`)
    ? inner.slice(0, -(fence.length + 1))
    : undefined;
};

/** The fenced entries of a loaded-skills message, in their order. */
const entries = (content: string): readonly LoadedSkill[] => {
  const lines = content.split('\n');
  const found: LoadedSkill[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const fence = /^(`{3,})text$/u.exec(lines[at] ?? '')?.[1];
    if (fence === undefined) continue;
    const close = lines.indexOf(fence, at + 1);
    if (close === -1) break;
    const text = lines.slice(at + 1, close).join('\n');
    const cut = text.endsWith(cutMarker);
    const skill = skillOf(cut ? text.slice(0, -cutMarker.length) : text, cut);
    if (skill !== undefined) found.push(skill);
    at = close;
  }
  return found;
};

/**
 * Every loaded skill in messages, most recent first, repeats included (rules
 * as in the tests: role:'tool' answering an assistant toolCalls entry named
 * load_skill, status not 'incomplete', content starting `# Tool Result`,
 * fenced block after `## Output` starting `# Skill: `; loaded-skills messages
 * (user message starting `<bundle-instruction bundle="default"
 * reason="loaded-skills">`) give each fenced entry in their own order). Pure;
 * malformed skipped.
 */
export const loadedSkills = (
  messages: readonly ProviderMessage[],
): readonly LoadedSkill[] => {
  const loads = new Set(
    messages.flatMap(({ role, toolCalls }) =>
      role === 'assistant'
        ? (toolCalls ?? [])
            .filter(({ name }) => name === LOAD_SKILL_TOOL)
            .map(({ id }) => id)
        : [],
    ),
  );
  const found: LoadedSkill[] = [];
  for (const message of [...messages].reverse()) {
    const { role, content } = message;
    if (typeof content !== 'string') continue;
    if (role === 'user' && content.startsWith(loadedSkillsOpening)) {
      found.push(...entries(content));
      continue;
    }
    if (
      role !== 'tool' ||
      message.toolCallId === undefined ||
      !loads.has(message.toolCallId) ||
      message.toolResultStatus === 'incomplete'
    )
      continue;
    const output = toolOutput(content);
    const skill = output === undefined ? undefined : skillOf(output, false);
    if (skill !== undefined) found.push(skill);
  }
  return found;
};

/**
 * The swap of the loaded-skills message for a compaction condensing [0,end)
 * (entries one per locator from the span, most recent; locators found in the
 * tail left out; texts over 20 000 or already cut → first 20 000 chars +
 * '\n\n' + loadedSkillCutPrompt inside the fence; greedy within
 * totalMaxChars, a non-fitting entry skipped and the next tried; skipped
 * named in the omitted list; message { role:'user', content:
 * bundleInstruction('loaded-skills', body) }, body = loadedSkillsPrompt, the
 * fenced entries, then loadedSkillsOmittedPrompt + blank line + "-
 * `<locator>`" lines when needed, joined by '\n\n'). Returns { key, message }
 * when ≥1 entry (fitted or omitted); { key } when retained[key] in [0,end)
 * but no entry; undefined when nothing to swap or retained[key] >= end. Pure.
 */
export const loadedSkillsReplacement = (
  messages: readonly ProviderMessage[],
  retained: Readonly<Record<string, number>>,
  end: number,
  totalMaxChars: number,
): RetainedReplacement | undefined => {
  const at = retained[loadedSkillsKey];
  if (at !== undefined && at >= end) return undefined;
  const again = new Set(
    loadedSkills(messages.slice(end)).map(({ locator }) => locator),
  );
  const seen = new Set<string>();
  const fitted: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const { locator, text, cut } of loadedSkills(messages.slice(0, end))) {
    if (seen.has(locator) || again.has(locator)) continue;
    seen.add(locator);
    const entry = fenced(
      cut || text.length > LOADED_SKILL_MAX_CHARS_PER_ENTRY
        ? `${text.slice(0, LOADED_SKILL_MAX_CHARS_PER_ENTRY)}${cutMarker}`
        : text,
    );
    if (used + entry.length <= totalMaxChars) {
      fitted.push(entry);
      used += entry.length;
    } else {
      omitted.push(locator);
    }
  }
  if (fitted.length === 0 && omitted.length === 0) {
    return at === undefined ? undefined : { key: loadedSkillsKey };
  }
  const body = [
    loadedSkillsPrompt,
    ...fitted,
    ...(omitted.length === 0
      ? []
      : [
          `${loadedSkillsOmittedPrompt}\n\n${omitted
            .map((locator) => `- \`${locator}\``)
            .join('\n')}`,
        ]),
  ].join('\n\n');
  return {
    key: loadedSkillsKey,
    message: {
      role: 'user',
      content: bundleInstruction('loaded-skills', body),
    },
  };
};
