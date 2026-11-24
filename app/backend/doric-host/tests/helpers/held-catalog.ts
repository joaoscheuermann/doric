import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An OpenRouter-kind model endpoint whose catalog read the test can hold, so a
 * `host-config/v1.Replace` naming it waits after its credential check and
 * before its write (the pipeline reads the catalog in between; spec
 * "Host-served contracts" aside, `host-config`'s step 3).
 */
export interface HeldCatalog {
  /** `http://127.0.0.1:<port>/v1`, an `openrouter` provider's `endpoint`. */
  readonly endpoint: string;
  /** The one model the catalog lists (`GET /v1/models`, `{ data: [{ id }] }`). */
  readonly model: string;
  /**
   * Holds the next `GET /v1/models` until `release()`. `reached` resolves once
   * that request arrived. A request that arrives with no hold set is answered
   * at once. Calling `hold()` again before the held request arrived replaces
   * the pending hold; `release()` twice is harmless.
   */
  hold(): { readonly reached: Promise<void>; release(): void };
  /** Answers every held request, then closes the server. Never rejects. */
  close(): Promise<void>;
}

const heldModel = 'held/model';

/** One pending hold: what the next catalog request signals and waits for. */
interface Hold {
  readonly arrived: () => void;
  readonly released: Promise<void>;
  readonly release: () => void;
}

const answerCatalog = (response: ServerResponse): void => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      data: [{ id: heldModel, name: 'Held', context_length: 128000 }],
    }),
  );
};

/** Starts a {@link HeldCatalog} on a free port of 127.0.0.1. Rejects only when the port cannot be bound. */
export const heldCatalog = async (): Promise<HeldCatalog> => {
  let pending: Hold | undefined;
  /** Every hold handed out, so `close` can answer the requests they keep. */
  const holds = new Set<Hold>();

  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/v1/models') {
      response.writeHead(404).end();
      return;
    }

    const hold = pending;
    pending = undefined;

    if (hold === undefined) {
      answerCatalog(response);
      return;
    }

    hold.arrived();
    void hold.released.then(() => answerCatalog(response));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${String(port)}/v1`,
    model: heldModel,
    hold: () => {
      let arrived!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const hold: Hold = { arrived, released, release };

      pending = hold;
      holds.add(hold);

      return { reached, release };
    },
    close: async () => {
      pending = undefined;
      for (const hold of holds) hold.release();
      // Let the released answers go out before the server stops accepting.
      await new Promise<void>((resolve) => setImmediate(resolve));
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
};
