/**
 * Reading a `load_skill` call's serialized args into what its block shows: the
 * skill's name and where it comes from.
 *
 * The args come from the log, so malformed args fall back to the raw text as a
 * bundle skill's name; nothing throws.
 */

export const LOAD_SKILL_TOOL = 'load_skill';

/** Where a loaded skill comes from, read from its locator. */
export type SkillSource =
  | { readonly kind: 'bundle' }
  | { readonly kind: 'workspace' }
  | { readonly kind: 'mcp'; readonly server: string };

export type ParsedSkillLoad = {
  /** The locator without its `cwd/` or `mcp/<slug>/` prefix (a `~N` suffix stays). */
  readonly name: string;
  readonly source: SkillSource;
};

const WORKSPACE_PREFIX = 'cwd/';
const MCP_LOCATOR = /^mcp\/([^/]+)\/(.+)$/;

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
 * `name`). `cwd/<x>` → workspace `x`; `mcp/<slug>/<x>` (slug without `/`) → mcp
 * `x` from `slug`; anything else → bundle, whole.
 */
export const parseSkillLoad = (args: string): ParsedSkillLoad => {
  const locator = readName(args) ?? args;
  if (locator.startsWith(WORKSPACE_PREFIX)) {
    return {
      name: locator.slice(WORKSPACE_PREFIX.length),
      source: { kind: 'workspace' },
    };
  }
  const [, server, name] = MCP_LOCATOR.exec(locator) ?? [];
  if (server !== undefined && name !== undefined) {
    return { name, source: { kind: 'mcp', server } };
  }
  return { name: locator, source: { kind: 'bundle' } };
};

/** The header's source label: `built-in`, `workspace`, or `MCP · <slug>`. */
export const skillSourceLabel = (source: SkillSource): string => {
  if (source.kind === 'bundle') return 'built-in';
  if (source.kind === 'workspace') return 'workspace';
  return `MCP · ${source.server}`;
};
