import { Buffer } from 'node:buffer';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { TextDecoder } from 'node:util';

import {
  DockerHttpError,
  DockerRequestAbortedError,
  DockerRequestTimeoutError,
} from './classes/errors.js';
import {
  containerFrom,
  containerId,
  containerInspectFrom,
  createBody,
  defaultConnection,
  encodeBody,
  execCreateBody,
  imageFrom,
  numberField,
  parseJson,
  pathWithQuery,
  socketPath,
  stringField,
  versionFrom,
  withDefaultTimeout,
} from './mapping.js';
import { provisionDocker } from './provider.js';
import type {
  CreateDockerClientOptions,
  DockerClient,
  DockerConnection,
  DockerResponse,
  DockerTransport,
  DockerTransportRequest,
} from './types/docker.js';
import { demuxDockerOutput } from './utils/demux.js';

const decoder = new TextDecoder();

/** Creates a Docker Engine API client over Unix sockets or Windows named pipes. */
export const createDockerClient = (
  options: CreateDockerClientOptions = {},
): DockerClient => {
  const request =
    options.request ??
    createNodeTransport(options.connection ?? defaultConnection());
  const timeoutMs = options.timeoutMs;

  const send = (
    input: DockerTransportRequest,
    expectedStatus: number | readonly number[],
  ) =>
    sendDockerRequest(
      request,
      withDefaultTimeout(input, timeoutMs),
      expectedStatus,
    );

  const json = async <Value>(
    input: DockerTransportRequest,
    expectedStatus: number | readonly number[],
  ): Promise<Value> => parseJson((await send(input, expectedStatus)).body);

  const client: DockerClient = {
    provision: (input) =>
      provisionDocker(client, input, {
        connection: options.connection ?? defaultConnection(),
        dropbearPath:
          options.dropbearPath ?? '/opt/doric/firecracker/dropbearmulti',
        statePath: options.statePath ?? '/var/lib/doric/docker',
        platform: process.platform,
      }),
    async ping(control = {}) {
      await send({ method: 'GET', path: '/_ping', ...control }, 200);
    },

    async version(control = {}) {
      const raw = await json<Record<string, unknown>>(
        { method: 'GET', path: '/version', ...control },
        200,
      );

      return versionFrom(raw);
    },

    async pullImage(input, control = {}) {
      await send(
        {
          method: 'POST',
          path: '/images/create',
          query: { fromImage: input.image },
          ...control,
        },
        200,
      );
    },

    async inspectImage(image, control = {}) {
      const response = await send(
        {
          method: 'GET',
          path: `/images/${encodeURIComponent(image)}/json`,
          ...control,
        },
        [200, 404],
      );

      if (response.status === 404) {
        return undefined;
      }

      const raw = parseJson<Record<string, unknown>>(response.body);

      return imageFrom(raw);
    },

    async createContainer(input, control = {}) {
      const response = await json<Record<string, unknown>>(
        {
          method: 'POST',
          path: '/containers/create',
          query: { name: input.name },
          body: createBody(input),
          ...control,
        },
        201,
      );

      return containerFrom(response);
    },

    async startContainer(container, control = {}) {
      await send(
        {
          method: 'POST',
          path: `/containers/${encodeURIComponent(containerId(container))}/start`,
          ...control,
        },
        [204, 304],
      );
    },

    async inspectContainer(container, control = {}) {
      const raw = await json<Record<string, unknown>>(
        {
          method: 'GET',
          path: `/containers/${encodeURIComponent(containerId(container))}/json`,
          ...control,
        },
        200,
      );

      return containerInspectFrom(raw);
    },

    async removeContainer(container, options = {}) {
      await send(
        {
          method: 'DELETE',
          path: `/containers/${encodeURIComponent(containerId(container))}`,
          query: {
            force: options.force,
            v: options.volumes,
            link: options.link,
          },
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        },
        [204, 404],
      );
    },

    async exec(container, input) {
      const created = await json<Record<string, unknown>>(
        {
          method: 'POST',
          path: `/containers/${encodeURIComponent(containerId(container))}/exec`,
          body: execCreateBody(input),
          signal: input.signal,
          timeoutMs: input.timeoutMs,
        },
        201,
      );
      const execId = stringField(created, 'Id');

      const stream = await send(
        {
          method: 'POST',
          path: `/exec/${encodeURIComponent(execId)}/start`,
          body: { Detach: false, Tty: input.tty ?? false },
          signal: input.signal,
          timeoutMs: input.timeoutMs,
        },
        200,
      );

      const inspected = await json<Record<string, unknown>>(
        {
          method: 'GET',
          path: `/exec/${encodeURIComponent(execId)}/json`,
          signal: input.signal,
          timeoutMs: input.timeoutMs,
        },
        200,
      );

      const output =
        input.tty === true
          ? { stdout: stream.body, stderr: new Uint8Array() }
          : demuxDockerOutput(stream.body);

      return {
        exitCode: numberField(inspected, 'ExitCode'),
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
        stdoutBytes: output.stdout,
        stderrBytes: output.stderr,
      };
    },

    async execDetached(container, input) {
      const created = await json<Record<string, unknown>>(
        {
          method: 'POST',
          path: `/containers/${encodeURIComponent(containerId(container))}/exec`,
          body: execCreateBody(input),
          signal: input.signal,
          timeoutMs: input.timeoutMs,
        },
        201,
      );
      const execId = stringField(created, 'Id');

      await send(
        {
          method: 'POST',
          path: `/exec/${encodeURIComponent(execId)}/start`,
          body: { Detach: true, Tty: input.tty ?? false },
          signal: input.signal,
          timeoutMs: input.timeoutMs,
        },
        200,
      );

      return execId;
    },

    async putArchive(container, input, control = {}) {
      await send(
        {
          method: 'PUT',
          path: `/containers/${encodeURIComponent(containerId(container))}/archive`,
          query: {
            path: input.path,
            noOverwriteDirNonDir: input.noOverwriteDirNonDir,
            copyUIDGID: input.copyUidGid,
          },
          body: input.archive,
          ...control,
        },
        200,
      );
    },

    async getArchive(container, input, control = {}) {
      return (
        await send(
          {
            method: 'GET',
            path: `/containers/${encodeURIComponent(containerId(container))}/archive`,
            query: { path: input.path },
            ...control,
          },
          200,
        )
      ).body;
    },
  };

  return client;
};

const createNodeTransport =
  (connection: DockerConnection): DockerTransport =>
  (request) =>
    new Promise<DockerResponse>((resolve, reject) => {
      const body = encodeBody(request.body);

      const options: RequestOptions = {
        method: request.method,
        path: pathWithQuery(request),
        socketPath: socketPath(connection),
        headers: { ...request.headers, ...body.headers },
      };

      const client = httpRequest(options, (response) => {
        const chunks: Uint8Array[] = [];

        response.on('data', (chunk: Uint8Array) => chunks.push(chunk));

        response.on('end', () => {
          cleanup();

          resolve({
            status: response.statusCode ?? 0,
            headers: { ...response.headers },
            body: Buffer.concat(chunks),
          });
        });
      });

      const abort = () => {
        client.destroy(
          new DockerRequestAbortedError(request.method, request.path),
        );
      };

      const cleanup = () => {
        request.signal?.removeEventListener('abort', abort);
      };

      client.on('error', (error) => {
        cleanup();

        reject(error);
      });

      if (request.signal?.aborted === true) {
        abort();

        return;
      }

      request.signal?.addEventListener('abort', abort, { once: true });

      if (body.bytes !== undefined) {
        client.write(body.bytes);
      }

      client.end();
    });

const sendDockerRequest = async (
  transport: DockerTransport,
  request: DockerTransportRequest,
  expectedStatus: number | readonly number[],
): Promise<DockerResponse> => {
  const response = await withRequestControl(transport, request);

  const expected = Array.isArray(expectedStatus)
    ? expectedStatus
    : [expectedStatus];

  if (!expected.includes(response.status)) {
    throw new DockerHttpError({
      status: response.status,
      method: request.method,
      path: pathWithQuery(request),
      body: decoder.decode(response.body),
    });
  }

  return response;
};

const withRequestControl = async (
  transport: DockerTransport,
  request: DockerTransportRequest,
): Promise<DockerResponse> => {
  if (request.signal?.aborted === true) {
    throw new DockerRequestAbortedError(request.method, request.path);
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromInput = () => controller.abort();
  const timeout = request.timeoutMs;

  const timer =
    timeout === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;

          controller.abort();
        }, timeout);

  const abortPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      reject(
        timedOut
          ? new DockerRequestTimeoutError(
              request.method,
              request.path,
              timeout ?? 0,
            )
          : new DockerRequestAbortedError(request.method, request.path),
      );
    };

    controller.signal.addEventListener('abort', onAbort, { once: true });
  });

  request.signal?.addEventListener('abort', abortFromInput, { once: true });

  try {
    return await Promise.race([
      transport({ ...request, signal: controller.signal }),
      abortPromise,
    ]);
  } finally {
    request.signal?.removeEventListener('abort', abortFromInput);

    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};
