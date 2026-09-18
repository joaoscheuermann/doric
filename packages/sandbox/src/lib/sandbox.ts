import { Buffer } from 'node:buffer';
import { isIP } from 'node:net';

import type {
  CreateSandboxOptions,
  GitAuth,
  NormalizedSandboxNetworkPolicy,
  SandboxDiffInput,
  SandboxExecInput,
  SandboxNetworkPolicy,
  SandboxRuntime,
  SandboxSession,
} from './types/sandbox.js';

type State = {
  readonly runtime: SandboxRuntime;
  readonly root: string;
  repoPath: string | undefined;
  disposed: boolean;
};

/** Validates policy and returns the effective provider-facing network policy. */
export const normalizeSandboxNetwork = (
  policy: SandboxNetworkPolicy | undefined,
): NormalizedSandboxNetworkPolicy => {
  const input = policy ?? { mode: 'disabled', ssh: false };
  const ssh = normalizeSsh(input.ssh);
  const mode = ssh === false ? input.mode : 'egress';

  validateDns(mode, input.dnsServers);

  input.allowPrivate?.forEach(validatePrivateRule);

  return {
    mode,
    ssh,
    ...(input.dnsServers === undefined ? {} : { dnsServers: input.dnsServers }),
    ...(input.allowPrivate === undefined
      ? {}
      : { allowPrivate: input.allowPrivate }),
  };
};

/** Provisions a runtime and adds provider-neutral workspace and Git helpers. */
export const createSandbox = async (
  options: CreateSandboxOptions,
): Promise<SandboxSession> => {
  validateResources(options.resources);

  const root = normalizeRoot(options.root ?? '/workspace');

  const runtime = await options.provider.provision({
    image: options.image,
    imagePullPolicy: options.imagePullPolicy,
    name: options.name,
    root,
    resources: options.resources,
    network: normalizeSandboxNetwork(options.network),
    timeoutMs: options.timeoutMs,
  });

  return session({ runtime, root, repoPath: undefined, disposed: false });
};

const session = (state: State): SandboxSession => ({
  id: state.runtime.id,
  root: state.root,
  exec(input) {
    active(state);

    return state.runtime.exec(runtimeExec(state, input));
  },
  async cloneRepo(input) {
    active(state);

    const directory = resolvePath(state.root, input.directory ?? 'repo');

    await checked(state, {
      cmd: [
        'git',
        'clone',
        ...(input.branch ? ['--branch', input.branch] : []),
        input.url,
        directory,
      ],
      env: gitAuthEnv(input.auth),
      timeoutMs: input.timeoutMs,
    });

    if (input.commit !== undefined) {
      await checked(state, {
        cmd: ['git', '-C', directory, 'fetch', 'origin', input.commit],
        env: gitAuthEnv(input.auth),
        timeoutMs: input.timeoutMs,
      });

      await checked(state, {
        cmd: ['git', '-C', directory, 'checkout', '--detach', input.commit],
        timeoutMs: input.timeoutMs,
      });
    }

    const revision = await checked(state, {
      cmd: ['git', '-C', directory, 'rev-parse', 'HEAD'],
      timeoutMs: input.timeoutMs,
    });

    state.repoPath = directory;

    return { path: directory, commit: revision.stdout.trim() };
  },
  async readFile(path) {
    active(state);

    return Buffer.from(
      await state.runtime.getFile(resolvePath(state.root, path)),
    ).toString('utf8');
  },
  async writeFile(path, content) {
    active(state);

    await put(state, path, Buffer.from(content));
  },
  async putFile(path, bytes) {
    active(state);

    await put(state, path, bytes);
  },
  async getFile(path) {
    active(state);

    return state.runtime.getFile(resolvePath(state.root, path));
  },
  async diff(input: SandboxDiffInput = {}) {
    active(state);

    const cwd =
      input.cwd === undefined
        ? (state.repoPath ?? state.root)
        : resolvePath(state.root, input.cwd);

    return (await checked(state, { cmd: ['git', 'diff'], cwd })).stdout;
  },
  ssh() {
    active(state);

    return state.runtime.ssh();
  },
  async dispose() {
    if (state.disposed) {
      return;
    }

    await state.runtime.dispose();

    state.disposed = true;
  },
});

const put = async (
  state: State,
  path: string,
  bytes: Uint8Array,
): Promise<void> => {
  const target = resolvePath(state.root, path);
  const slash = target.lastIndexOf('/');

  if (slash <= 0 || slash === target.length - 1) {
    throw new Error(`Sandbox file path must include a file name: ${path}`);
  }

  await checked(state, { cmd: ['mkdir', '-p', target.slice(0, slash)] });

  await state.runtime.putFile(target, bytes);
};

const checked = async (state: State, input: SandboxExecInput) => {
  const result = await state.runtime.exec(runtimeExec(state, input));

  if (result.exitCode !== 0) {
    throw new Error(
      `Sandbox command failed with exit code ${String(result.exitCode)}`,
    );
  }

  return result;
};

const runtimeExec = (
  state: State,
  input: SandboxExecInput,
): SandboxExecInput => ({
  ...input,
  cwd:
    input.cwd === undefined ? state.root : resolvePath(state.root, input.cwd),
});

const resolvePath = (root: string, path: string): string => {
  const raw = path.startsWith('/') ? path : `${root}/${path}`;
  const parts = raw.split('/').filter(Boolean);
  const rootParts = root.split('/').filter(Boolean);

  if (
    parts.includes('..') ||
    rootParts.some((part, index) => parts[index] !== part)
  ) {
    throw new Error(`Sandbox paths must stay under ${root}: ${path}`);
  }

  return `/${parts.join('/')}`;
};

const normalizeRoot = (root: string): string => {
  if (!root.startsWith('/') || root.includes('..')) {
    throw new Error(
      `Sandbox root must be an absolute normalized path: ${root}`,
    );
  }

  return root.length > 1 ? root.replace(/\/+$/u, '') : root;
};

const validateResources = (
  resources: CreateSandboxOptions['resources'],
): void => {
  for (const [name, value] of Object.entries(resources)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
};

const normalizeSsh = (
  ssh: SandboxNetworkPolicy['ssh'],
): NormalizedSandboxNetworkPolicy['ssh'] => {
  if (ssh !== true && (ssh === false || ssh === undefined)) {
    return false;
  }

  const config = ssh === true ? {} : ssh;
  const bindAddress = config.bindAddress ?? '127.0.0.1';

  if (isIP(bindAddress) === 0) {
    throw new Error('SSH bindAddress must be an IP literal');
  }

  if (!isLoopback(bindAddress) && !config.advertisedHost) {
    throw new Error('A non-loopback SSH bindAddress requires advertisedHost');
  }

  if (
    config.port !== undefined &&
    (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535)
  ) {
    throw new RangeError('SSH port must be between 1 and 65535');
  }

  return {
    bindAddress,
    advertisedHost: config.advertisedHost,
    port: config.port,
  };
};

const validateDns = (
  mode: 'disabled' | 'egress',
  servers: readonly string[] | undefined,
): void => {
  if (mode === 'egress' && (servers === undefined || servers.length === 0)) {
    throw new Error(
      'Effective egress networking requires at least one DNS server',
    );
  }

  servers?.forEach((server) => {
    if (isIP(server) !== 4) {
      throw new Error(`DNS server must be an IPv4 literal: ${server}`);
    }
  });
};

const validatePrivateRule = (
  rule: NonNullable<SandboxNetworkPolicy['allowPrivate']>[number],
): void => {
  const [address, prefix, extra] = rule.cidr.split('/');
  const family = isIP(address ?? '');
  const bits = family === 4 ? 32 : 0;

  if (
    extra !== undefined ||
    bits === 0 ||
    prefix === undefined ||
    !/^\d+$/u.test(prefix) ||
    Number(prefix) > bits
  ) {
    throw new Error(
      `Private network exception must use a valid CIDR: ${rule.cidr}`,
    );
  }

  if (
    rule.ports.length === 0 ||
    rule.ports.some(
      (port) => !Number.isInteger(port) || port < 1 || port > 65_535,
    )
  ) {
    throw new Error(
      `Private network exception has invalid ports: ${rule.cidr}`,
    );
  }
};

const isLoopback = (address: string): boolean =>
  address === '::1' || address.startsWith('127.');

const active = (state: State): void => {
  if (state.disposed) {
    throw new Error(`Sandbox has been disposed: ${state.runtime.id}`);
  }
};

const gitAuthEnv = (
  auth: GitAuth | undefined,
): readonly string[] | undefined => {
  if (auth === undefined) {
    return undefined;
  }

  const credential =
    auth.kind === 'token'
      ? `${auth.username ?? 'x-access-token'}:${auth.token}`
      : `${auth.username}:${auth.password}`;

  return [
    'GIT_CONFIG_COUNT=1',
    'GIT_CONFIG_KEY_0=http.extraHeader',
    `GIT_CONFIG_VALUE_0=Authorization: Basic ${Buffer.from(credential).toString('base64')}`,
  ];
};
