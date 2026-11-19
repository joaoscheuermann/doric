/**
 * Which drawing a tool call or an input gets (`chat.views/v1` 1.2.0).
 *
 * A tool's registration answers all three facts of its calls' drawing — the
 * element, whether a call stands outside the activity group, whether its block
 * is open by default — whole, so a registration of a name the chat draws itself
 * replaces the chat's answer. An unregistered tool gets the chat's built-in
 * answer, whose names leave here one by one as bundles take their drawings
 * over (5(b)).
 */

import type { ToolRendererSpec } from '../../contracts/index.js';
import type { QueueItem } from './queue.js';
import { LOAD_SKILL_TOOL } from './skill-load.js';
import { THREAD_SPAWN_TOOL } from './thread-spawn.js';

/** How the calls of one tool are drawn. */
export interface ToolDrawing {
  /** The registered element that draws each call; absent, the chat draws it. */
  readonly elementTag?: string;
  /** Whether a call is a block of its own, outside the activity group. */
  readonly standalone: boolean;
  /** Whether a call's block stays open once settled, until the reader closes it. */
  readonly openByDefault: boolean;
}

/**
 * The calls that stay out of the activity summary as blocks of their own:
 * `thread-spawn`, whose delegation has a block of its own, and `load_skill`,
 * whose block names the skill the agent loaded.
 */
const STANDALONE: ReadonlySet<string> = new Set([
  THREAD_SPAWN_TOOL,
  LOAD_SKILL_TOOL,
]);

/**
 * The chat's own answer for an unregistered tool: closed by default, and
 * standalone for the names left in `STANDALONE`, which leave in 5(b).
 */
export const builtInDrawing = (name: string): ToolDrawing => ({
  standalone: STANDALONE.has(name),
  openByDefault: false,
});

/** A registration's answer for `name`, whole (O4); else `builtInDrawing(name)`. */
export const toolDrawing = (
  name: string,
  registered: ReadonlyMap<string, ToolRendererSpec>,
): ToolDrawing => {
  const spec = registered.get(name);
  if (spec === undefined) return builtInDrawing(name);
  return {
    ...(spec.elementTag === undefined ? {} : { elementTag: spec.elementTag }),
    standalone: spec.standalone ?? false,
    openByDefault: spec.openByDefault ?? false,
  };
};

/**
 * The key an input renderer is registered under: the kind, `bundle:<id>` for a
 * bundle; `undefined` for `user` and a bundle with no id.
 */
export const inputSourceKey = (
  source: QueueItem['source'],
): string | undefined => {
  if (source.kind === 'user') return undefined;
  if (source.kind !== 'bundle') return source.kind;
  return source.bundleId === undefined
    ? undefined
    : `bundle:${source.bundleId}`;
};
