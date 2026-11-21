// The part of `workspace.selection/v1` the usage summary reads: the selected
// Thread's id and change notifications. A structural copy of the workspace's
// contract, as chat keeps one, so the client part does not import another
// bundle's code; the ID and shapes are the workspace's.

import { type CallArg, type Disposable, ref } from 'bundle/contracts';

export interface SelectionSource {
  /** The selected Thread's id, while one is selected. */
  current(call?: CallArg): { readonly threadId?: string };
  /** Called after the selected ids change. */
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const WorkspaceSelectionV1 = ref<SelectionSource>(
  'workspace.selection/v1',
);
