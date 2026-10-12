import { Buffer } from 'node:buffer';
import { request as httpRequest, type RequestOptions } from 'node:http';

import type {
  FirecrackerApi,
  FirecrackerRequest,
  FirecrackerResponse,
  FirecrackerTransport,
} from './types.js';

/** Creates a small client for Firecracker's versioned Unix-socket HTTP API. */
export const createFirecrackerApi = (
  socketPath: string,
  transport: FirecrackerTransport = nodeTransport,
): FirecrackerApi => {
  const request = async (input: FirecrackerRequest): Promise<void> => {
    const response = await transport(socketPath, input);

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Firecracker API ${input.method} ${input.path} failed with status ${response.status}`,
      );
    }
  };

  return {
    request,
    async configure(input) {
      await request({
        method: 'PUT',
        path: '/boot-source',
        body: {
          kernel_image_path: input.kernel,
          initrd_path: input.initramfs,
          boot_args: 'console=ttyS0 reboot=k panic=1 pci=off ipv6.disable=1',
        },
      });

      await request({
        method: 'PUT',
        path: '/machine-config',
        body: {
          vcpu_count: input.cpuCount,
          mem_size_mib: input.memoryMiB,
          smt: false,
          track_dirty_pages: false,
        },
      });

      await request({
        method: 'PUT',
        path: '/drives/base',
        body: {
          drive_id: 'base',
          path_on_host: input.baseDisk,
          is_root_device: false,
          is_read_only: true,
        },
      });

      await request({
        method: 'PUT',
        path: '/drives/writable',
        body: {
          drive_id: 'writable',
          path_on_host: input.writableDisk,
          is_root_device: false,
          is_read_only: false,
        },
      });

      await request({ method: 'PUT', path: '/entropy', body: {} });

      await request({
        method: 'PUT',
        path: '/network-interfaces/eth0',
        body: {
          iface_id: 'eth0',
          host_dev_name: input.tap,
          guest_mac: input.guestMac,
        },
      });
    },
    start: (signal) =>
      request({
        method: 'PUT',
        path: '/actions',
        body: { action_type: 'InstanceStart' },
        signal,
      }),
  };
};

export const nodeTransport: FirecrackerTransport = (socketPath, input) =>
  new Promise<FirecrackerResponse>((resolve, reject) => {
    const bytes =
      input.body === undefined
        ? undefined
        : Buffer.from(JSON.stringify(input.body));

    const options: RequestOptions = {
      socketPath,
      method: input.method,
      path: input.path,
      headers:
        bytes === undefined
          ? {}
          : {
              'content-type': 'application/json',
              'content-length': String(bytes.byteLength),
            },
    };

    const client = httpRequest(options, (response) => {
      const chunks: Uint8Array[] = [];

      response.on('data', (chunk: Uint8Array) => chunks.push(chunk));

      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks),
        }),
      );
    });

    const abort = () =>
      client.destroy(
        Object.assign(new Error('Firecracker API request aborted'), {
          name: 'AbortError',
        }),
      );

    client.once('error', reject);

    input.signal?.addEventListener('abort', abort, { once: true });

    client.once('close', () =>
      input.signal?.removeEventListener('abort', abort),
    );

    if (input.signal?.aborted) {
      abort();

      return;
    }

    if (bytes !== undefined) {
      client.write(bytes);
    }

    client.end();
  });
