// The two optional contracts the footer execution picker reads, while a
// provider of each is available: `settings.models/v1` and
// `workspace.selection/v1` (bundle isolation 6(c)). The conversation reads the
// selection too (`hooks/use-workspace.ts`, bundle isolation 4(d)).

import type { SettingsModels } from 'settings/contracts';
import { useStore } from 'zustand/react';
import { createStore } from 'zustand/vanilla';

import type { WorkspaceSelectionService } from '../api/workspace-selection.js';

interface ExecutionSources {
  readonly models?: SettingsModels;
  readonly selection?: WorkspaceSelectionService;
}

const sources = createStore<ExecutionSources>()(() => ({}));

export const setSettingsModels = (models: SettingsModels | undefined): void => {
  sources.setState({ models });
};

export const setWorkspaceSelection = (
  selection: WorkspaceSelectionService | undefined,
): void => {
  sources.setState({ selection });
};

/** The handles of the two contracts, re-rendering when either comes or goes. */
export const useExecutionSources = (): ExecutionSources => useStore(sources);

/** The `workspace.selection/v1` handle, while a provider is available. */
export const currentWorkspaceSelection = ():
  | WorkspaceSelectionService
  | undefined => sources.getState().selection;

/** Called when either handle comes or goes. */
export const subscribeExecutionSources = (listener: () => void): (() => void) =>
  sources.subscribe(listener);
