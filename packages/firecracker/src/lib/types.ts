import type { SandboxProvisionInput, SandboxRuntime } from 'sandbox';

export interface FirecrackerPaths {
  readonly firecracker: string;
  readonly jailer: string;
  readonly kernel: string;
  readonly initramfs: string;
  readonly dropbear: string;
  readonly state: string;
  readonly cache: string;
}

export interface FirecrackerRequest {
  readonly method: 'GET' | 'PUT' | 'PATCH';
  readonly path: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export interface FirecrackerResponse {
  readonly status: number;
  readonly body: Uint8Array;
}

export type FirecrackerTransport = (
  socketPath: string,
  request: FirecrackerRequest,
) => Promise<FirecrackerResponse>;

export interface FirecrackerConfig {
  readonly paths: FirecrackerPaths;
  readonly networkPool: string;
  readonly cacheLimitBytes: number;
  readonly readinessTimeoutMs: number;
  readonly jailerUid: number;
  readonly jailerGid: number;
  readonly transport: FirecrackerTransport;
}

export interface CreateFirecrackerClientOptions {
  readonly paths?: Partial<FirecrackerPaths>;
  readonly networkPool?: string;
  readonly cacheLimitBytes?: number;
  readonly readinessTimeoutMs?: number;
  readonly jailerUid?: number;
  readonly jailerGid?: number;
  readonly transport?: FirecrackerTransport;
  readonly preflight?: (config: FirecrackerConfig) => Promise<void>;
  /** Internal/runtime seam used by the image, jailer, and VM lifecycle integration. */
  readonly provision?: (
    input: SandboxProvisionInput,
    config: FirecrackerConfig,
  ) => Promise<SandboxRuntime>;
}

export interface FirecrackerApi {
  request(input: FirecrackerRequest): Promise<void>;

  configure(input: {
    readonly cpuCount: number;
    readonly memoryMiB: number;
    readonly kernel: string;
    readonly initramfs: string;
    readonly baseDisk: string;
    readonly writableDisk: string;
    readonly tap: string;
    readonly guestMac: string;
  }): Promise<void>;

  start(signal?: AbortSignal): Promise<void>;
}
