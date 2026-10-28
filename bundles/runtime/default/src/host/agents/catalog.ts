import type { AgentSummary } from '../../contracts/index.js';
import {
  loadTemplate,
  renderBlock,
  renderSection,
} from '../prompts/templates.js';
import { cell } from '../skills/catalog.js';

/** The names `agents.md` may cite. */
const CATALOG_NAMES = [
  'rows',
  'name',
  'description',
  'dropped',
  'count',
  'one',
];

/** The names `agents-changed.md` may cite. */
const CHANGED_NAMES = [
  'added',
  'rows',
  'name',
  'description',
  'dropped',
  'count',
  'one',
  'removed',
  'agents',
];

/** The `# Agents` section of the system prompt. */
const catalogTemplate = loadTemplate(
  new URL('../prompts/agents.md', import.meta.url),
  CATALOG_NAMES,
);

/** A mid-run "Agents changed" message. */
const changedTemplate = loadTemplate(
  new URL('../prompts/agents-changed.md', import.meta.url),
  CHANGED_NAMES,
);

/** Characters of the rows as the `rows` section of a template renders them, without the final newline. */
const ROWS_MAX_CHARS = 8000;

/** The cap of a description cell. */
const DESCRIPTION_MAX_CHARS = 500;

/**
 * The rows of `agents` that fit `template`'s `rows` section (at least one),
 * and how many were dropped.
 */
const fitRows = (template: string, agents: readonly AgentSummary[]) => {
  let rows = agents.map(({ name, description }) => ({
    name,
    description: cell(description, DESCRIPTION_MAX_CHARS),
  }));
  while (
    rows.length > 1 &&
    renderSection(template, 'rows', rows).length > ROWS_MAX_CHARS
  ) {
    rows = rows.slice(0, -1);
  }
  const dropped = agents.length - rows.length;
  return {
    rows,
    dropped: dropped === 0 ? undefined : { count: dropped, one: dropped === 1 },
  };
};

/**
 * The system prompt's `# Agents` section, or '' when `agents` is empty:
 * `agents.md` rendered with a table of one row per agent in order, the
 * descriptions capped at 500 characters. Trailing rows are dropped while the
 * rows pass 8000 characters, and counted; at least one row always fits. Pure.
 */
export const agentCatalog = (agents: readonly AgentSummary[]): string =>
  agents.length === 0
    ? ''
    : renderBlock(catalogTemplate, fitRows(catalogTemplate, agents));

/**
 * The body of an "Agents changed" message (no envelope), by `name`: the
 * agents added or changed (new, or `description`/`source` differs; `current`
 * order) in a table fitted like `agentCatalog`, and the names removed
 * (`previous` order). Empty sections omitted. undefined when nothing changed;
 * a `model`/`effort` change alone is not reported. Pure.
 */
export const agentCatalogChange = (
  previous: readonly AgentSummary[],
  current: readonly AgentSummary[],
): string | undefined => {
  const before = new Map(previous.map((agent) => [agent.name, agent]));
  const names = new Set(current.map(({ name }) => name));
  const added = current.filter((agent) => {
    const old = before.get(agent.name);
    return (
      old === undefined ||
      old.description !== agent.description ||
      old.source !== agent.source
    );
  });
  const removed = previous.filter(({ name }) => !names.has(name));
  if (added.length === 0 && removed.length === 0) return undefined;
  return renderBlock(changedTemplate, {
    added: added.length === 0 ? undefined : fitRows(changedTemplate, added),
    removed: removed.length === 0 ? undefined : { agents: removed },
  });
};
