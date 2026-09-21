import type { WorkspaceApi } from './app/workspace';

declare global {
  interface Window {
    readonly doric: WorkspaceApi;
  }
}

export {};
