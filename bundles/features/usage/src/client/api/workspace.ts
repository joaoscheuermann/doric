// The part of `layout.workspace/v1` the usage summary reads: the selected
// Thread and change notifications. A structural copy of the layout's
// contract, as chat keeps one, so the client part does not import another
// bundle's code; the ID and shapes are the layout's.

import { type CallArg, type Disposable, ref } from 'bundle/contracts';

export interface SelectedThreadSource {
  /** The selected Thread, once the tree describes it. */
  selectedThread(call?: CallArg): { readonly id: string } | undefined;
  /** Called after every change of the tree, the selection or the connection. */
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const WorkspaceV1 = ref<SelectedThreadSource>('layout.workspace/v1');
