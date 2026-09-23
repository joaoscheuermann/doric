import type { WorkspaceApi } from '@/domain/workspace';

declare global {
  interface Window {
    readonly doric: WorkspaceApi;
  }
}

export {};
