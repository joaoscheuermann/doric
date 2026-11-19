/**
 * Which drawing a tool call or an input gets (`chat.views/v1` 1.2.0).
 *
 * A tool's registration answers all three facts of its calls' drawing — the
 * element, whether a call stands outside the activity group, whether its block
 * is open by default — whole. An unregistered tool is drawn by the chat's
 * generic row, grouped and closed by default.
 */

import type { ToolRendererSpec } from '../../contracts/index.js';
import type { QueueItem } from './queue.js';

/** How the calls of one tool are drawn. */
export interface ToolDrawing {
  /** The registered element that draws each call; absent, the chat draws it. */
  readonly elementTag?: string;
  /** Whether a call is a block of its own, outside the activity group. */
  readonly standalone: boolean;
  /** Whether a call's block stays open once settled, until the reader closes it. */
  readonly openByDefault: boolean;
}

/** A registration's answer for `name`, whole (O4); else grouped and closed. */
export const toolDrawing = (
  name: string,
  registered: ReadonlyMap<string, ToolRendererSpec>,
): ToolDrawing => {
  const spec = registered.get(name);
  if (spec === undefined) return { standalone: false, openByDefault: false };
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
