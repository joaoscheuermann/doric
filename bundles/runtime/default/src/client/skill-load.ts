/**
 * Reading a `load_skill` call's serialized args into what its block shows: the
 * skill's name and where it comes from (bundle isolation 5(b), moved from the
 * chat's `domain/skill-load.ts`).
 *
 * The args come from the log, so malformed args fall back to the raw text as a
 * bundle skill's name; nothing throws.
 */

import type { ChatToolView } from 'chat/contracts';
import type { Openness } from 'desktop/ui/collapsible-block';

export const LOAD_SKILL_TOOL = 'load_skill';

/** A tool call's status, as the chat's `view` carries it. */
export type ToolStatus = ChatToolView['status'];

/** Where a loaded skill comes from, read from its locator. */
export type SkillSource =
  | { readonly kind: 'bundle' }
  | { readonly kind: 'workspace' }
  | { readonly kind: 'group'; readonly source: string; readonly group: string };

export type ParsedSkillLoad = {
  /** The locator without its `cwd/` or `<source>/<group>/` prefix (a `~N` suffix stays). */
  readonly name: string;
  readonly source: SkillSource;
};

const WORKSPACE_PREFIX = 'cwd/';
const GROUP_LOCATOR = /^([^/]+)\/([^/]+)\/(.+)$/;

/** The args' string `name`, or nothing when they are not a JSON object with one. */
const readName = (args: string): string | undefined => {
  try {
    const value: unknown = JSON.parse(args);
    return typeof value === 'object' &&
      value !== null &&
      'name' in value &&
      typeof value.name === 'string'
      ? value.name
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * `args.name` (the args text itself when it is not a JSON object with a string
 * `name`). `cwd/<x>` → workspace `x`; `<source>/<group>/<x>` (source and group
 * without `/`) → `x` from that source and group; anything else → bundle, whole.
 */
export const parseSkillLoad = (args: string): ParsedSkillLoad => {
  const locator = readName(args) ?? args;
  if (locator.startsWith(WORKSPACE_PREFIX)) {
    return {
      name: locator.slice(WORKSPACE_PREFIX.length),
      source: { kind: 'workspace' },
    };
  }
  const [, source, group, name] = GROUP_LOCATOR.exec(locator) ?? [];
  if (source !== undefined && group !== undefined && name !== undefined) {
    return { name, source: { kind: 'group', source, group } };
  }
  return { name: locator, source: { kind: 'bundle' } };
};

/** The header's source label: `built-in`, `workspace`, or `<source> · <group>` as written (U15). */
export const skillSourceLabel = (source: SkillSource): string => {
  if (source.kind === 'bundle') return 'built-in';
  if (source.kind === 'workspace') return 'workspace';
  return `${source.source} · ${source.group}`;
};

/**
 * A `load_skill` block's answer: folded while it loads and once loaded, and
 * open when the load failed, so the reason is not scrolled past.
 */
export const skillOpenness = (status: ToolStatus): Openness => ({
  active: status === 'running',
  hasContent: true,
  defaultOpen: status === 'failed',
});
