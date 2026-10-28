import type { ProviderMessage } from 'llms';

import type { RetainedReplacement } from '../compaction/rewrite.js';
import { bundleInstruction } from '../envelope.js';
import { retainedKey } from '../history.js';
import {
  loadTemplate,
  renderBlock,
  renderSection,
} from '../prompts/templates.js';
import { LOAD_SKILL_TOOL } from './load-skill.js';

export const LOADED_SKILL_MAX_CHARS_PER_ENTRY = 20_000;
export const LOADED_SKILLS_MAX_CHARS = 100_000;

/** The meta.retained key of the loaded-skills message: retainedKey('default', 'loaded-skills'). */
export const loadedSkillsKey: string = retainedKey('default', 'loaded-skills');

/**
 * The `default` bundle's coding-workflow skill, by name and locator. The
 * "Loaded skills" message always keeps its entry, and the executor does not
 * offer it to a Thread running as an agent.
 */
export const CODING_WORKFLOW_SKILL = 'coding-workflow';

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

/** One kept skill: its text, the fence around it, and whether it was cut. */
type LoadedEntry = {
  readonly fence: string;
  readonly text: string;
  readonly cut: boolean;
};

/** The names `loaded-skills.md` may cite. */
const LOADED_SKILLS_NAMES = [
  'entries',
  'fence',
  'text',
  'cut',
  'omitted',
  'skills',
  'locator',
];

/** The body of the loaded-skills message. */
const template = loadTemplate(
  new URL('../prompts/loaded-skills.md', import.meta.url),
  LOADED_SKILLS_NAMES,
);

/** The text inside each `text` fence of `content`, in their order; an unclosed fence ends the search. */
const fencedTexts = (content: string): string[] => {
  const lines = content.split('\n');
  const texts: string[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const fence = /^(`{3,})text$/u.exec(lines[at] ?? '')?.[1];
    if (fence === undefined) continue;
    const close = lines.indexOf(fence, at + 1);
    if (close === -1) break;
    texts.push(lines.slice(at + 1, close).join('\n'));
    at = close;
  }
  return texts;
};

/** What ends the text of an entry a loaded-skills message cut: the end of an empty cut entry's text. */
const cutMarker = fencedTexts(
  renderSection(template, 'entries', [{ fence: '```', text: '', cut: true }]),
)[0];
if (cutMarker === undefined) {
  throw new Error('loaded-skills.md renders no fenced entry.');
}

/** A fence one backtick longer than the longest run in `text` (at least three). */
const fenceFor = (text: string): string =>
  '`'.repeat(
    Math.max(2, ...[...text.matchAll(/`+/gu)].map(([run]) => run.length)) + 1,
  );

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
const entries = (content: string): readonly LoadedSkill[] =>
  fencedTexts(content).flatMap((text) => {
    const cut = text.endsWith(cutMarker);
    const skill = skillOf(cut ? text.slice(0, -cutMarker.length) : text, cut);
    return skill === undefined ? [] : [skill];
  });

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

/** One entry as the loaded-skills message renders it, cut when too long. */
const loadedEntry = ({ text, cut }: LoadedSkill): LoadedEntry => {
  const cutting = cut || text.length > LOADED_SKILL_MAX_CHARS_PER_ENTRY;
  const kept = cutting ? text.slice(0, LOADED_SKILL_MAX_CHARS_PER_ENTRY) : text;
  return {
    fence: fenceFor(cutting ? `${kept}${cutMarker}` : kept),
    text: kept,
    cut: cutting,
  };
};

/**
 * The swap of the loaded-skills message for a compaction condensing [0,end)
 * (entries one per locator from the span, most recent; locators found in the
 * tail left out; texts over 20 000 or already cut → their first 20 000 chars,
 * marked as cut inside the fence; greedy within totalMaxChars, each entry
 * measured as `loaded-skills.md` renders it alone, a non-fitting entry
 * skipped and the next tried; skipped named in the omitted list; message
 * { role:'user', content: bundleInstruction('loaded-skills', body) }, body =
 * `loaded-skills.md` rendered with the fitted entries and the omitted
 * locators). Returns { key, message } when ≥1 entry (fitted or omitted);
 * { key } when retained[key] in [0,end) but no entry; undefined when nothing
 * to swap or retained[key] >= end. The entry whose locator is
 * `CODING_WORKFLOW_SKILL` comes first and is never omitted for
 * `totalMaxChars`. Pure.
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
  const fitted: LoadedEntry[] = [];
  const omitted: { readonly locator: string }[] = [];
  let used = 0;
  const span = loadedSkills(messages.slice(0, end));
  // The pinned pass: the coding workflow's most recent load, whatever the cap.
  for (const skill of span) {
    if (skill.locator !== CODING_WORKFLOW_SKILL) continue;
    if (seen.has(skill.locator) || again.has(skill.locator)) continue;
    seen.add(skill.locator);
    const entry = loadedEntry(skill);
    fitted.push(entry);
    used += renderSection(template, 'entries', [entry]).length;
  }
  // The greedy pass: every other entry, while it fits.
  for (const skill of span) {
    const { locator } = skill;
    if (seen.has(locator) || again.has(locator)) continue;
    seen.add(locator);
    const entry = loadedEntry(skill);
    const length = renderSection(template, 'entries', [entry]).length;
    if (used + length <= totalMaxChars) {
      fitted.push(entry);
      used += length;
    } else {
      omitted.push({ locator });
    }
  }
  if (fitted.length === 0 && omitted.length === 0) {
    return at === undefined ? undefined : { key: loadedSkillsKey };
  }
  const body = renderBlock(template, {
    entries: fitted,
    omitted: omitted.length === 0 ? undefined : { skills: omitted },
  });
  return {
    key: loadedSkillsKey,
    message: {
      role: 'user',
      content: bundleInstruction('loaded-skills', body),
    },
  };
};
