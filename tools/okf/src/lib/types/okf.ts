import type { Sandbox } from 'sandbox';

export interface OkfToolOptions {
  readonly workspaceRoot: string;
  /** The sandbox that holds the workspace the tool searches. */
  readonly sandbox: Sandbox;
}
