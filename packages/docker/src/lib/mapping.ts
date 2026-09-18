import { Buffer } from 'node:buffer';

import type {
  ContainerInspect,
  ContainerRef,
  CreateContainerInput,
  DockerConnection,
  DockerTransportRequest,
  DockerVersion,
  ExecInput,
  ImageInspect,
} from './types/docker.js';

export const createBody = (
  input: CreateContainerInput,
): Record<string, unknown> => ({
  Image: input.image,
  ...(input.cmd === undefined ? {} : { Cmd: [...input.cmd] }),
  ...(input.env === undefined ? {} : { Env: [...input.env] }),
  ...(input.workingDir === undefined ? {} : { WorkingDir: input.workingDir }),
  ...(input.labels === undefined ? {} : { Labels: { ...input.labels } }),
  ...(input.user === undefined ? {} : { User: input.user }),
  ...(input.hostConfig === undefined ? {} : { HostConfig: input.hostConfig }),
  ...(input.networkDisabled === undefined
    ? {}
    : { NetworkDisabled: input.networkDisabled }),
  ...(input.exposedPorts === undefined
    ? {}
    : {
        ExposedPorts: Object.fromEntries(
          input.exposedPorts.map((port) => [port, {}]),
        ),
      }),
});

export const execCreateBody = (input: ExecInput): Record<string, unknown> => ({
  AttachStdout: true,
  AttachStderr: true,
  Tty: input.tty ?? false,
  Cmd: [...input.cmd],
  ...(input.env === undefined ? {} : { Env: [...input.env] }),
  ...(input.workingDir === undefined ? {} : { WorkingDir: input.workingDir }),
  ...(input.user === undefined ? {} : { User: input.user }),
});

export const encodeBody = (
  body: unknown,
): {
  readonly bytes?: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
} => {
  if (body === undefined) {
    return { headers: {} };
  }

  if (body instanceof Uint8Array) {
    return {
      bytes: body,
      headers: { 'content-length': String(body.byteLength) },
    };
  }

  const bytes = Buffer.from(JSON.stringify(body));

  return {
    bytes,
    headers: {
      'content-type': 'application/json',
      'content-length': String(bytes.byteLength),
    },
  };
};

export const parseJson = <Value>(body: Uint8Array): Value =>
  body.byteLength === 0
    ? ({} as Value)
    : (JSON.parse(Buffer.from(body).toString('utf8')) as Value);

export const versionFrom = (raw: Record<string, unknown>): DockerVersion => ({
  version: stringValue(raw.Version),
  apiVersion: stringValue(raw.ApiVersion),
  minApiVersion: stringValue(raw.MinAPIVersion),
  gitCommit: stringValue(raw.GitCommit),
  goVersion: stringValue(raw.GoVersion),
  os: stringValue(raw.Os),
  arch: stringValue(raw.Arch),
  kernelVersion: stringValue(raw.KernelVersion),
  experimental:
    typeof raw.Experimental === 'boolean' ? raw.Experimental : undefined,
  raw,
});

export const containerFrom = (raw: Record<string, unknown>): ContainerRef => ({
  id: stringField(raw, 'Id'),
  warnings: Array.isArray(raw.Warnings)
    ? raw.Warnings.filter(
        (warning): warning is string => typeof warning === 'string',
      )
    : [],
});

export const containerInspectFrom = (
  raw: Record<string, unknown>,
): ContainerInspect => {
  const settings = recordValue(raw.NetworkSettings);

  const addresses = Object.values(recordValue(settings.Networks))
    .map(recordValue)
    .map((network) => stringValue(network.IPAddress))
    .filter(
      (value): value is string => value !== undefined && value.length > 0,
    );

  const ports = Object.fromEntries(
    Object.entries(recordValue(settings.Ports)).map(([port, value]) => [
      port,
      Array.isArray(value)
        ? value
            .map(recordValue)
            .map((binding) => ({
              hostIp: stringValue(binding.HostIp) ?? '',
              hostPort: Number(stringValue(binding.HostPort)),
            }))
            .filter(({ hostPort }) => Number.isInteger(hostPort))
        : [],
    ]),
  );

  return { id: stringField(raw, 'Id'), ipAddress: addresses[0], ports, raw };
};

export const imageFrom = (raw: Record<string, unknown>): ImageInspect => ({
  id: stringField(raw, 'Id'),
  raw,
});

export const stringField = (
  record: Record<string, unknown>,
  key: string,
): string => {
  const value = record[key];

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Docker response is missing string field: ${key}`);
  }

  return value;
};

export const numberField = (
  record: Record<string, unknown>,
  key: string,
): number | null => (typeof record[key] === 'number' ? record[key] : null);

export const containerId = (container: ContainerRef | string): string =>
  typeof container === 'string' ? container : container.id;

export const withDefaultTimeout = (
  request: DockerTransportRequest,
  timeoutMs: number | undefined,
): DockerTransportRequest => ({
  ...request,
  timeoutMs: request.timeoutMs ?? timeoutMs,
});

export const defaultConnection = (): DockerConnection =>
  process.platform === 'win32' ? { kind: 'namedPipe' } : { kind: 'unix' };

export const socketPath = (connection: DockerConnection): string =>
  connection.kind === 'unix'
    ? (connection.socketPath ??
      dockerHostSocketPath(process.env.DOCKER_HOST) ??
      '/var/run/docker.sock')
    : (connection.pipePath ?? '//./pipe/docker_engine');

export const pathWithQuery = (request: DockerTransportRequest): string => {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }

  const query = params.toString();

  return query.length === 0 ? request.path : `${request.path}?${query}`;
};

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const recordValue = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};

const dockerHostSocketPath = (host: string | undefined): string | undefined => {
  if (host === undefined || host.length === 0) {
    return undefined;
  }

  if (host.startsWith('unix://')) {
    return host.slice('unix://'.length);
  }

  return host.startsWith('/') ? host : undefined;
};
