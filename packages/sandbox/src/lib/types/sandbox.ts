export interface SandboxResources {
  readonly cpuCount: number;
  readonly memoryMiB: number;
  readonly diskMiB: number;
}

export interface SandboxNetworkPolicy {
  readonly mode: 'disabled' | 'egress';
  readonly ssh?:
    | boolean
    | {
        readonly bindAddress?: string;
        readonly advertisedHost?: string;
        readonly port?: number;
      };
  readonly dnsServers?: readonly string[];
  readonly allowPrivate?: readonly {
    readonly cidr: string;
    readonly protocol: 'tcp' | 'udp';
    readonly ports: readonly number[];
  }[];
}

export type NormalizedSandboxNetworkPolicy = Omit<
  SandboxNetworkPolicy,
  'ssh'
> & {
  readonly mode: 'disabled' | 'egress';
  readonly ssh:
    | false
    | {
        readonly bindAddress: string;
        readonly advertisedHost?: string;
        readonly port?: number;
      };
};

export interface SandboxSshAccess {
  readonly host: string;
  readonly port: number;
  readonly username: 'root';
  readonly privateKey: string;
  readonly knownHosts: string;
  readonly hostKeyFingerprint: string;
}

export interface SandboxExecInput {
  readonly cmd: readonly string[];
  readonly cwd?: string;
  readonly env?: readonly string[];
  readonly user?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly tty?: boolean;
}

export interface SandboxExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: Uint8Array;
  readonly stderrBytes: Uint8Array;
}

export interface SandboxProvisionInput {
  readonly image: string;
  readonly imagePullPolicy?: 'always' | 'if-not-present';
  readonly name?: string;
  /** The durable workspace this sandbox serves; absent means a scratch one. */
  readonly workspace?: string;
  readonly root: string;
  readonly resources: SandboxResources;
  readonly network: NormalizedSandboxNetworkPolicy;
  readonly timeoutMs?: number;
}

export interface SandboxRuntime {
  readonly id: string;
  exec(input: SandboxExecInput): Promise<SandboxExecResult>;

  putFile(path: string, bytes: Uint8Array): Promise<void>;

  getFile(path: string): Promise<Uint8Array>;

  ssh(): Promise<SandboxSshAccess | undefined>;

  dispose(): Promise<void>;
}

export interface SandboxProvider {
  provision(input: SandboxProvisionInput): Promise<SandboxRuntime>;
}

export type GitAuth =
  | {
      readonly kind: 'token';
      readonly token: string;
      readonly username?: string;
    }
  | {
      readonly kind: 'basic';
      readonly username: string;
      readonly password: string;
    };

export interface CloneRepoInput {
  readonly url: string;
  readonly directory?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly auth?: GitAuth;
  readonly timeoutMs?: number;
}

export interface ClonedRepo {
  readonly path: string;
  readonly commit: string;
}

export interface CreateSandboxOptions {
  readonly provider: SandboxProvider;
  readonly image: string;
  readonly imagePullPolicy?: 'always' | 'if-not-present';
  readonly name?: string;
  /** The durable workspace this sandbox serves; absent means a scratch one. */
  readonly workspace?: string;
  readonly root?: string;
  readonly resources: SandboxResources;
  readonly network?: SandboxNetworkPolicy;
  readonly timeoutMs?: number;
}

export interface SandboxDiffInput {
  readonly cwd?: string;
  /** Workspace-relative paths that scope the diff; the whole tree when omitted. */
  readonly paths?: readonly string[];
}

export interface Sandbox {
  readonly id: string;
  readonly root: string;
  exec(input: SandboxExecInput): Promise<SandboxExecResult>;

  cloneRepo(input: CloneRepoInput): Promise<ClonedRepo>;

  readFile(path: string): Promise<string>;

  writeFile(path: string, content: string): Promise<void>;

  putFile(path: string, bytes: Uint8Array): Promise<void>;

  getFile(path: string): Promise<Uint8Array>;

  diff(input?: SandboxDiffInput): Promise<string>;

  ssh(): Promise<SandboxSshAccess | undefined>;
}

export interface SandboxSession extends Sandbox {
  dispose(): Promise<void>;
}
