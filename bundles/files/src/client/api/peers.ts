// The optional peers of the files client, as structural copies of their
// contracts: hooks are matched by contract ID only, and a composition without
// chat or git would not map their contracts modules. Both are used through
// `whenAvailable`, so they are not in the manifest's `requires`.

import {
  type CallArg,
  type Disposable,
  defineHook,
  defineHooks,
  ref,
} from 'bundle/contracts';
import { z } from 'zod';

import type { TreeScope } from '../../contracts/index.js';

/** chat.hooks/v1 (D9-10): a sandbox-writing tool finished in a held Thread. */
export const ChatHooksV1 = defineHooks('chat.hooks/v1', {
  onSandboxActivityHook: defineHook({
    kind: 'observe',
    input: z.object({ projectId: z.string() }).strict(),
  }),
});

/**
 * The mark git's changes read gives one tree row: the description its label
 * reads, the directory badge count, and the file badge's colour and letter.
 */
export interface ChangeMark {
  readonly description: string;
  readonly count: number;
  readonly tone?: string;
  readonly letter?: string;
  readonly struck?: boolean;
}

/** What git's changes read shows for one Project and working directory: its marks by path. */
export interface ChangesObservation {
  readonly decorations: ReadonlyMap<string, ChangeMark>;
  readonly error?: string;
  readonly fetching: boolean;
}

/** git.changes/v1 (client, local; WP-10G): the changes read the tree decorates from. */
export interface GitChanges {
  observe(
    scope: TreeScope,
    listener: (state: ChangesObservation) => void,
    call?: CallArg,
  ): Disposable;
}

export const GitChangesV1 = ref<GitChanges>('git.changes/v1');
