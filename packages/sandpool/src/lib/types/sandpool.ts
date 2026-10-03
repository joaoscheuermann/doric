import type { Logger } from 'pino';

import type { Sandbox, SandboxSession } from 'sandbox';

export type SandpoolLifecycle = 'active' | 'disposing' | 'disposed';

export type SandpoolOptions = {
  readonly minIdle: number;
  readonly maxSandboxes: number;
  /** Consecutive failed factory calls allowed before pending waits fail. Defaults to 3. */
  readonly maxCreateAttempts?: number;
  /**
   * Creates one session. `identity` names the caller the session serves; a
   * session created without one serves any caller.
   */
  readonly create: (identity?: string) => Promise<SandboxSession>;
  readonly logger: Logger;
};

export type SandpoolWaitOptions = {
  readonly signal?: AbortSignal;
};

export type SandpoolAcquireOptions = SandpoolWaitOptions & {
  /**
   * Names the caller the session serves. An identified acquisition is always
   * provisioned its own session and never takes an idle one.
   */
  readonly identity?: string;
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

  acquire(options?: SandpoolAcquireOptions): Promise<SandboxLease>;

  status(): SandpoolStatus;

  dispose(): Promise<void>;
};
