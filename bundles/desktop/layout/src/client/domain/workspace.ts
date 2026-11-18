// The Project and Thread records are the runtime's (`runtime/contracts`),
// imported as types only: a window's import map is not guaranteed to serve a
// host bundle's contracts module.
import { ref } from 'bundle/contracts';
import type {
  Project,
  ProjectColor,
  RuntimeRecords,
  Thread,
} from 'runtime/contracts';

export type {
  Project,
  ProjectColor,
  RecordsRead,
  RuntimeRecords,
  Thread,
  ThreadEvent,
} from 'runtime/contracts';

/**
 * The window's mirror of the host's Projects and Threads, which the runtime's
 * client part provides (bundle isolation phase 3). Optional for the layout:
 * it is reached only through `whenAvailable`.
 */
export const RecordsV1 = ref<RuntimeRecords>('runtime.records/v1');

/**
 * The colors a Project can be marked with, in palette order. The vocabulary is
 * the host's; this module also says how each one paints, so no surface invents
 * a color name and an unassigned Project stays absent rather than falling back
 * to a default.
 */
export const projectColors = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const satisfies readonly ProjectColor[];

/** The fill each palette color gives the Project's mark. */
export const projectColorSwatch: Record<ProjectColor, string> = {
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-500',
  green: 'bg-green-500',
  teal: 'bg-teal-500',
  blue: 'bg-blue-500',
  violet: 'bg-violet-500',
  pink: 'bg-pink-500',
};

/** CSS colors for surfaces that use a Project mark as a border. */
export const projectColorValue: Record<ProjectColor, string> = {
  red: '#ef4444',
  orange: '#f97316',
  amber: '#f59e0b',
  green: '#22c55e',
  teal: '#14b8a6',
  blue: '#3b82f6',
  violet: '#8b5cf6',
  pink: '#ec4899',
};

export type Draft =
  | { readonly kind: 'project' }
  | {
      readonly kind: 'thread';
      readonly projectId: string;
      readonly parentThreadId?: string;
    };

export type Entity =
  | { readonly kind: 'project'; readonly value: Project }
  | { readonly kind: 'thread'; readonly value: Thread };

export const threadSubtreeIds = (
  threads: readonly Thread[],
  rootId: string,
): ReadonlySet<string> => {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const thread of threads) {
      if (
        thread.parentThreadId !== undefined &&
        ids.has(thread.parentThreadId) &&
        !ids.has(thread.id)
      ) {
        ids.add(thread.id);
        changed = true;
      }
    }
  }
  return ids;
};

export const limitName = (value: string): string =>
  Array.from(value).slice(0, 80).join('');

export const nameError = (value: string): string | undefined => {
  if (value.includes('\0')) return 'Names cannot contain a null character.';
  const length = Array.from(value.trim()).length;
  if (length === 0 || length > 80) {
    return 'Enter a name between 1 and 80 characters.';
  }
  return undefined;
};
