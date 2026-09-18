import type { Logger } from 'pino';

import type { Sandbox, SandboxSession } from 'sandbox';

export type SandpoolLifecycle = 'active' | 'disposing' | 'disposed';

export type SandpoolOptions = {
  readonly minIdle: number;
  readonly maxSandboxes: number;
  /** Consecutive failed factory calls allowed before pending waits fail. Defaults to 3. */
  readonly maxCreateAttempts?: number;
  readonly create: () => Promise<SandboxSession>;
  readonly logger: Logger;
};

export type SandpoolWaitOptions = {
  readonly signal?: AbortSignal;
};

export type PooledSandbox = Sandbox;

export type SandboxLease = {
  readonly sandbox: PooledSandbox;
  readonly release: () => Promise<void>;
};

export type SandpoolStatus = {
  readonly lifecycle: SandpoolLifecycle;
  readonly idle: number;
  readonly leased: number;
  readonly creating: number;
  readonly disposing: number;
  readonly queued: number;
  readonly total: number;
  readonly heated: boolean;
  readonly lastFailure: unknown | undefined;
};

export type Sandpool = {
  heated(): boolean;

  waitUntilHeated(options?: SandpoolWaitOptions): Promise<void>;

  acquire(options?: SandpoolWaitOptions): Promise<SandboxLease>;

  status(): SandpoolStatus;

  dispose(): Promise<void>;
};
