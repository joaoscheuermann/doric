// The two optional contracts the footer execution picker reads, while a
// provider of each is available: `settings.models/v1` and
// `workspace.selection/v1` (bundle isolation 6(c)).

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
