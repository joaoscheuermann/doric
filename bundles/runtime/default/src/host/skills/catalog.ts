import { excerpt } from 'tool';

import {
  loadTemplate,
  renderBlock,
  renderSection,
} from '../prompts/templates.js';
import type { CatalogSkill, RunSkills } from './sources.js';

/** One table row: its cells, each on one line, capped and pipe-escaped. */
type Row = { readonly locator: string; readonly description: string };

/** The names `skills-catalog.md` may cite. */
const CATALOG_NAMES = [
  'alwaysAvailable',
  'skills',
  'name',
  'body',
  'toLoad',
  'lists',
  'builtIn',
  'workspace',
  'server',
  'table',
  'rows',
  'locator',
  'description',
  'dropped',
  'count',
  'one',
];

/** The names `skills-changed.md` may cite. */
const CHANGED_NAMES = [
  'added',
  'lists',
  'workspace',
  'server',
  'table',
  'rows',
  'locator',
  'description',
  'dropped',
  'count',
  'one',
  'removed',
  'skills',
];

/** The `# Skills` section of the system prompt. */
const catalogTemplate = loadTemplate(
  new URL('../prompts/skills-catalog.md', import.meta.url),
  CATALOG_NAMES,
);

/** A mid-run "Skills changed" message. */
const changedTemplate = loadTemplate(
  new URL('../prompts/skills-changed.md', import.meta.url),
  CHANGED_NAMES,
);

/** Characters of the always-available skills as the `skills` section of `skills-catalog.md` renders them, without its outer newlines. */
const ALWAYS_AVAILABLE_MAX_CHARS = 16_000;

/** Characters of the rows of each list as the `rows` section of its template renders them, without the final newline. */
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
   * The `# Skills` section, `skills-catalog.md` rendered, or '' when there
   * is neither an always-available skill that fits nor a non-empty list. The
   * template gives the always-available skills that fit (body verbatim), then
   * the non-empty lists among built-in, workspace and MCP, in that order:
   * each with its heading, a table of the rows that fit unless all were
   * dropped, and how many were dropped when any were.
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

/**
 * One table cell: one line (whitespace runs → one space, trimmed), cut to
 * `max` with `excerpt` when given, every `|` escaped as `\|`. Pure.
 */
export const cell = (text: string, max?: number): string => {
  const line = text.replace(/\s+/gu, ' ').trim();
  return (max === undefined ? line : excerpt(line, max)).replaceAll('|', '\\|');
};

/** `base`, or its first `~N` suffix (N ≥ 2) not in `taken`. */
const freeLocator = (base: string, taken: ReadonlySet<string>): string => {
  let locator = base;
  for (let suffix = 2; taken.has(locator); suffix += 1) {
    locator = `${base}~${suffix}`;
  }
  return locator;
};

/**
 * The rows of `entries` that fit in `budget` characters of `template`'s
 * `rows` section, the dropped count, and the entries shown.
 */
const fitList = (
  template: string,
  entries: readonly Entry[],
  budget: number,
) => {
  const rowsOf = (max: number): Row[] =>
    entries.map(({ locator, skill }) => ({
      locator: cell(locator),
      description: cell(skill.description, max),
    }));
  const length = (rows: readonly Row[]): number =>
    renderSection(template, 'rows', rows).length;
  let rows = rowsOf(DESCRIPTION_MAX_CHARS);
  if (length(rows) > budget) {
    rows = rowsOf(DESCRIPTION_SHORT_CHARS);
    while (rows.length > 0 && length(rows) > budget) rows = rows.slice(0, -1);
  }
  const dropped = entries.length - rows.length;
  return {
    table: rows.length === 0 ? undefined : { rows },
    dropped: dropped === 0 ? undefined : { count: dropped, one: dropped === 1 },
    shown: entries.slice(0, rows.length),
  };
};

/**
 * The skills section of one run. Always-available skills are taken in order
 * while their rendered length stays within `ALWAYS_AVAILABLE_MAX_CHARS`; the
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
  const fit: { readonly name: string; readonly body: string }[] = [];
  const overflow: CatalogSkill[] = [];
  for (const { name, description, body } of skills.alwaysAvailable) {
    const candidate = { name, body };
    if (
      overflow.length === 0 &&
      renderSection(catalogTemplate, 'skills', [...fit, candidate]).length <=
        ALWAYS_AVAILABLE_MAX_CHARS
    )
      fit.push(candidate);
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
      builtIn: true,
      entries: entries([...overflow, ...skills.builtIn]),
      budget: BUILT_IN_MAX_CHARS,
    },
    {
      workspace: true,
      entries: entries(skills.workspace),
      budget: WORKSPACE_MAX_CHARS,
    },
    {
      server: true,
      entries: entries(skills.server),
      budget: SERVER_MAX_CHARS,
    },
  ]
    .filter(({ entries }) => entries.length > 0)
    .map(({ entries, budget, ...kind }) => ({
      ...kind,
      ...fitList(catalogTemplate, entries, budget),
    }));

  return {
    section:
      fit.length === 0 && lists.length === 0
        ? ''
        : renderBlock(catalogTemplate, {
            alwaysAvailable: fit.length === 0 ? undefined : { skills: fit },
            toLoad: lists.length === 0 ? undefined : { lists },
          }),
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
 * Message: `skills-changed.md` rendered with each non-empty added list,
 * workspace then MCP, fitted like the system prompt fits a list (4000 chars
 * of rows; descriptions 500 → 120 → trailing rows dropped and counted), and
 * the locators of the removed identities that had a shown row, in
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
      workspace: true,
      entries: added(current.workspace),
      budget: WORKSPACE_MAX_CHARS,
    },
    {
      server: true,
      entries: added(current.server),
      budget: SERVER_MAX_CHARS,
    },
  ]
    .filter(({ entries }) => entries.length > 0)
    .map(({ budget, ...list }) => ({
      ...list,
      ...fitList(changedTemplate, list.entries, budget),
    }));
  const gone = [...state.listed]
    .filter(([, skill]) => removed.has(identity(skill)))
    .map(([locator]) => locator);

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
  if (lists.length === 0 && gone.length === 0) return { state: next };
  return {
    state: next,
    message: renderBlock(changedTemplate, {
      added: lists.length === 0 ? undefined : { lists },
      removed:
        gone.length === 0
          ? undefined
          : { skills: gone.map((locator) => ({ locator })) },
    }),
  };
};
