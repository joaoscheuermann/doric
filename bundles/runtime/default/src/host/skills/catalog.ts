import { excerpt } from 'tool';

import {
  addedSkillsPrompt,
  alwaysAvailableSkillsPrompt,
  builtInSkillsPrompt,
  changedWorkspaceSkillsPrompt,
  removedSkillsPrompt,
  serverSkillsPrompt,
  skillsChangedPrompt,
  skillsPrompt,
  skillsToLoadPrompt,
  workspaceSkillsPrompt,
} from '../prompts/skills.js';
import type { CatalogSkill, RunSkills } from './sources.js';

/** Characters of the always-available blocks, joined by a blank line. */
const ALWAYS_AVAILABLE_MAX_CHARS = 16_000;

/** Characters of the rendered rows of each list, joined by `\n`. */
const BUILT_IN_MAX_CHARS = 8000;
const WORKSPACE_MAX_CHARS = 4000;
const SERVER_MAX_CHARS = 4000;

/** The first and second description caps. */
const DESCRIPTION_MAX_CHARS = 500;
const DESCRIPTION_SHORT_CHARS = 120;

/**
 * What one run has offered so far. A skill's identity is `bundle:<name>`,
 * `workspace:<SKILL.md path>` or `mcp:<serverId>\n<uri>`.
 */
export interface CatalogState {
  /**
   * Every identity this run gave a locator to (shown or dropped row) →
   * locator. Only grows; never renamed or removed; two identities never share
   * a locator; always-available skills whose body is in the section have no
   * entry.
   */
  readonly locators: ReadonlyMap<string, string>;
  /**
   * The identities the model was told about and that were not reported or
   * seen as gone (shown or dropped rows of the built-in, workspace and MCP
   * lists).
   */
  readonly available: ReadonlySet<string>;
  /**
   * The locators `load_skill` accepts now: shown rows still available →
   * skill. Order: list order, then additions in the order announced.
   */
  readonly listed: ReadonlyMap<string, CatalogSkill>;
}

/** The skills section of one run, and the state it starts. */
export interface SkillCatalog extends CatalogState {
  /**
   * The `# Skills` section, or '' when nothing is rendered. Its parts are
   * joined by a blank line: `skillsPrompt`; `alwaysAvailableSkillsPrompt`
   * with each `### Skill: <name>\n\n<body>` (body verbatim);
   * `skillsToLoadPrompt` with the non-empty lists among built-in, workspace
   * and MCP, in that order. Each list is its prompt, then a
   * `| Skill | Description |` table with one row per skill and, when rows were
   * dropped, a blank line and "N more skills did not fit in this list.". A
   * list whose rows are all dropped keeps its prompt and that line, with no
   * table.
   */
  readonly section: string;
}

/** One check's result. */
export interface CatalogChange {
  readonly state: CatalogState;
  /** body without envelope; absent when nothing to say */
  readonly message?: string;
}

interface Entry {
  readonly locator: string;
  readonly skill: CatalogSkill;
}

/** The identity of a skill: what tells two skills apart across checks. */
const identity = ({ name, origin }: CatalogSkill): string =>
  origin.kind === 'bundle'
    ? `bundle:${name}`
    : origin.kind === 'workspace'
      ? `workspace:${origin.path}`
      : `mcp:${origin.serverId}\n${origin.uri}`;

/** The locator a skill asks for, before any `~N` suffix. */
const baseLocator = ({ name, origin }: CatalogSkill): string =>
  origin.kind === 'bundle'
    ? name
    : origin.kind === 'workspace'
      ? `cwd/${name}`
      : `mcp/${origin.serverSlug}/${name}`;

/** One table cell: on one line, single-spaced, with its pipes escaped. */
const cell = (text: string, max?: number): string => {
  const line = text.replace(/\s+/gu, ' ').trim();
  return (max === undefined ? line : excerpt(line, max)).replaceAll('|', '\\|');
};

const row = ({ locator, skill }: Entry, max: number): string =>
  `| ${cell(locator)} | ${cell(skill.description, max)} |`;

/** `base`, or its first `~N` suffix (N ≥ 2) not in `taken`. */
const freeLocator = (base: string, taken: ReadonlySet<string>): string => {
  let locator = base;
  for (let suffix = 2; taken.has(locator); suffix += 1) {
    locator = `${base}~${suffix}`;
  }
  return locator;
};

const fits = (rows: readonly string[], budget: number): boolean =>
  rows.join('\n').length <= budget;

/** One list's rendered part and the entries it rendered a row for. */
const renderList = (
  prompt: string,
  entries: readonly Entry[],
  budget: number,
): { readonly part: string; readonly shown: readonly Entry[] } => {
  let rows = entries.map((entry) => row(entry, DESCRIPTION_MAX_CHARS));
  if (!fits(rows, budget)) {
    rows = entries.map((entry) => row(entry, DESCRIPTION_SHORT_CHARS));
    while (rows.length > 0 && !fits(rows, budget)) rows = rows.slice(0, -1);
  }
  const dropped = entries.length - rows.length;
  const parts = [prompt];
  if (rows.length > 0) {
    parts.push(
      ['| Skill | Description |', '| --- | --- |', ...rows].join('\n'),
    );
  }
  if (dropped > 0) {
    parts.push(
      dropped === 1
        ? '1 more skill did not fit in this list.'
        : `${dropped} more skills did not fit in this list.`,
    );
  }
  return { part: parts.join('\n\n'), shown: entries.slice(0, rows.length) };
};

/**
 * The skills section of one run. Always-available blocks are taken in order
 * while their joined length stays within `ALWAYS_AVAILABLE_MAX_CHARS`; the
 * first that would pass it and every one after become rows at the front of
 * the built-in list. Locators: a bundle skill's name, `cwd/<name>` for a
 * workspace skill, `mcp/<serverSlug>/<name>` for an MCP skill, assigned in
 * list order; one already taken gets the first free `~2`, `~3`, …. Each
 * list's rows have their descriptions capped at `DESCRIPTION_MAX_CHARS`, at
 * `DESCRIPTION_SHORT_CHARS` when they pass the list's budget, and lose their
 * trailing rows while they still do. An empty list is omitted. The state it
 * starts gives every row, shown or dropped, its locator and makes it
 * available, and lists the shown ones. Pure, deterministic, never throws.
 */
export const skillCatalog = (skills: RunSkills): SkillCatalog => {
  const blocks: string[] = [];
  const overflow: CatalogSkill[] = [];
  for (const { name, description, body } of skills.alwaysAvailable) {
    const text = `### Skill: ${name}\n\n${body}`;
    const fitsBlocks =
      [...blocks, text].join('\n\n').length <= ALWAYS_AVAILABLE_MAX_CHARS;
    if (overflow.length === 0 && fitsBlocks) blocks.push(text);
    else overflow.push({ name, description, origin: { kind: 'bundle', body } });
  }

  const taken = new Set<string>();
  const all: Entry[] = [];
  const entries = (list: readonly CatalogSkill[]): readonly Entry[] =>
    list.map((skill) => {
      const locator = freeLocator(baseLocator(skill), taken);
      taken.add(locator);
      all.push({ locator, skill });
      return { locator, skill };
    });
  const lists = [
    {
      prompt: builtInSkillsPrompt,
      entries: entries([...overflow, ...skills.builtIn]),
      budget: BUILT_IN_MAX_CHARS,
    },
    {
      prompt: workspaceSkillsPrompt,
      entries: entries(skills.workspace),
      budget: WORKSPACE_MAX_CHARS,
    },
    {
      prompt: serverSkillsPrompt,
      entries: entries(skills.server),
      budget: SERVER_MAX_CHARS,
    },
  ]
    .filter(({ entries }) => entries.length > 0)
    .map(({ prompt, entries, budget }) => renderList(prompt, entries, budget));

  const parts: string[] = [];
  if (blocks.length > 0) parts.push(alwaysAvailableSkillsPrompt, ...blocks);
  if (lists.length > 0) {
    parts.push(skillsToLoadPrompt, ...lists.map(({ part }) => part));
  }
  return {
    section: parts.length === 0 ? '' : [skillsPrompt, ...parts].join('\n\n'),
    locators: new Map(
      all.map(({ locator, skill }) => [identity(skill), locator] as const),
    ),
    available: new Set(all.map(({ skill }) => identity(skill))),
    listed: new Map(
      lists.flatMap(({ shown }) =>
        shown.map(({ locator, skill }) => [locator, skill] as const),
      ),
    ),
  };
};

/**
 * Compares the workspace and MCP skills offered now with `state`; bundle
 * identities never compared.
 * Added: identities in current not in state.available, workspace first, each
 * list in its order. Removed: workspace/MCP identities in state.available not
 * in current.
 * Locators for added: old locator if identity in state.locators; else base
 * (`cwd/<name>`, `mcp/<serverSlug>/<name>`) or first `<base>~N` (N ≥ 2) not a
 * value of state.locators.
 * Message parts joined by '\n\n': skillsChangedPrompt; when added:
 * addedSkillsPrompt then each non-empty added list rendered like the system
 * prompt renders a list (workspace under changedWorkspaceSkillsPrompt, MCP
 * under serverSkillsPrompt; 4000 chars of rows; descriptions 500 → 120 →
 * trailing rows dropped and counted); when a removed identity had a shown
 * row: removedSkillsPrompt, a blank line, one "- `<locator>`" line each in
 * state.listed order.
 * message absent when nothing added and no shown row removed; a dropped row
 * that goes away is never reported.
 * Next state: locators gains new entries; available = (available − removed)
 * ∪ added; listed = listed − removed locators + shown added rows appended
 * (dropped added rows join available only). Pure, deterministic; never
 * throws.
 */
export const skillCatalogChange = (
  state: CatalogState,
  current: {
    readonly workspace: readonly CatalogSkill[];
    readonly server: readonly CatalogSkill[];
  },
): CatalogChange => {
  const offered = new Set(
    [...current.workspace, ...current.server].map(identity),
  );
  const removed = new Set(
    [...state.available].filter(
      (id) => !id.startsWith('bundle:') && !offered.has(id),
    ),
  );

  const locators = new Map(state.locators);
  const taken = new Set(state.locators.values());
  const seen = new Set(state.available);
  const added = (list: readonly CatalogSkill[]): readonly Entry[] =>
    list.flatMap((skill) => {
      const id = identity(skill);
      if (seen.has(id)) return [];
      seen.add(id);
      const locator =
        locators.get(id) ?? freeLocator(baseLocator(skill), taken);
      taken.add(locator);
      locators.set(id, locator);
      return [{ locator, skill }];
    });
  const lists = [
    {
      prompt: changedWorkspaceSkillsPrompt,
      entries: added(current.workspace),
      budget: WORKSPACE_MAX_CHARS,
    },
    {
      prompt: serverSkillsPrompt,
      entries: added(current.server),
      budget: SERVER_MAX_CHARS,
    },
  ]
    .filter(({ entries }) => entries.length > 0)
    .map(({ prompt, entries, budget }) => ({
      entries,
      ...renderList(prompt, entries, budget),
    }));
  const gone = [...state.listed]
    .filter(([, skill]) => removed.has(identity(skill)))
    .map(([locator]) => locator);

  const parts: string[] = [];
  if (lists.length > 0) {
    parts.push(addedSkillsPrompt, ...lists.map(({ part }) => part));
  }
  if (gone.length > 0) {
    parts.push(
      `${removedSkillsPrompt}\n\n${gone.map((locator) => `- \`${locator}\``).join('\n')}`,
    );
  }
  const next: CatalogState = {
    locators,
    available: new Set([
      ...[...state.available].filter((id) => !removed.has(id)),
      ...lists.flatMap(({ entries }) =>
        entries.map(({ skill }) => identity(skill)),
      ),
    ]),
    listed: new Map([
      ...[...state.listed].filter(([locator]) => !gone.includes(locator)),
      ...lists.flatMap(({ shown }) =>
        shown.map(({ locator, skill }) => [locator, skill] as const),
      ),
    ]),
  };
  return parts.length === 0
    ? { state: next }
    : { state: next, message: [skillsChangedPrompt, ...parts].join('\n\n') };
};
