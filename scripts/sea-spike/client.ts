/**
 * The bundle side of the phase 0 spike (T0.1), bundled into every SEA: opens
 * the control stream on the stub router with the instance token, sends a
 * `Hello`, waits for `Accepted`, runs the bundle's activation work and keeps
 * the stream open until the host closes it. Exits 70 when the host is gone or
 * refuses the Hello (spec, section 7, "Spawn").
 */
import { create } from '@bufbuild/protobuf';
import { createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import {
  BundleHostService,
  type ConnectRequest,
  ConnectRequestSchema,
} from 'bundle/contracts/gen/doric/platform/v1/control_pb.js';

const EXIT_HOST_GONE = 70;
const HELLO_TIMEOUT_MS = 10_000;

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

/** What a bundle's entry runs once its Hello is accepted. */
export type Activate = () =>
  | Promise<Record<string, unknown> | undefined>
  | Record<string, unknown>
  | undefined;

/** Writes one line of JSON on stdout, read by `scripts/sea-spike.mjs`. */
export const report = (value: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ spike: value })}\n`);
};

export const run = async (activate: Activate): Promise<never> => {
  const transport = createGrpcTransport({
    baseUrl: required('DORIC_ROUTER_URL'),
  });
  const client = createClient(BundleHostService, transport);

  let release: () => void = () => {};
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* frames(): AsyncGenerator<ConnectRequest> {
    yield create(ConnectRequestSchema, {
      frame: {
        case: 'hello',
        value: {
          protocolVersion: 1,
          instance: {
            bundleId: required('DORIC_BUNDLE_ID'),
            generation: Number(required('DORIC_GENERATION')),
            incarnation: Number(required('DORIC_INCARNATION')),
          },
        },
      },
    });
    await open;
  }

  const timeout = setTimeout(() => {
    console.error('doric-spike: no answer to the Hello');
    process.exit(EXIT_HOST_GONE);
  }, HELLO_TIMEOUT_MS);

  try {
    const responses = client.connect(frames(), {
      headers: { authorization: `Bearer ${required('DORIC_INSTANCE_TOKEN')}` },
    });
    let accepted = false;
    for await (const response of responses) {
      if (!accepted) {
        if (response.frame.case !== 'accepted') {
          throw new Error(`the Hello was not accepted: ${response.frame.case}`);
        }
        accepted = true;
        clearTimeout(timeout);
        report({ activation: (await activate()) ?? {} });
      }
    }
    throw new Error('the control stream closed');
  } catch (error) {
    console.error(
      `doric-spike: ${error instanceof Error ? error.message : String(error)}`,
    );
    release();
    process.exit(EXIT_HOST_GONE);
  }
};
