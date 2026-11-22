// The HTTP prefix (spec `docs/designs/grpc-processes.md`, section 11, "The
// HTTP prefix", D16): HTTP/1.1 requests and upgrades under a bundle's
// `host.httpPrefix`, forwarded to its active instance's loopback listener.

import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

import type { ResolvedEnvironment } from '../../runtime/catalog.js';
import { httpPrefixOf } from '../../runtime/manifest.js';
import type { InstanceKey } from '../router/instances.js';
import type { HttpTarget } from '../router/listener.js';

/**
 * The prefixes of `resolved`, `"/screen/"` to `"screen-relay"`: the
 * `host.httpPrefix` (`httpPrefixOf`) of every `scheduled` entry that sets
 * one. The catalog quarantines the second bundle of a prefix in activation
 * order (`duplicate_http_prefix`), so a prefix has one bundle. Pure; never
 * throws.
 */
export const httpPrefixesOf = (
  resolved: ResolvedEnvironment,
): ReadonlyMap<string, string> =>
  new Map(
    resolved.entries.flatMap(({ id, state, manifest }) => {
      const prefix =
        state === 'scheduled' && manifest !== undefined
          ? httpPrefixOf(manifest)
          : undefined;

      return prefix === undefined ? [] : [[prefix, id] as const];
    }),
  );

export interface PrefixProxyOptions {
  /**
   * The current prefixes ({@link httpPrefixesOf}); read on every request, so
   * a publish that adds or removes a prefix reaches the next request.
   */
  readonly prefixes: () => ReadonlyMap<string, string>;
  /** `Router.httpTargetOf`. */
  readonly target: (bundleId: string) => HttpTarget | undefined;
  /** `Router.trackConnection`. */
  readonly track: (key: InstanceKey, cancel: () => void) => () => void;
}

/**
 * Forwards what falls under a prefix. A request falls under a prefix when
 * its path (the request target before `?`) starts with it, compared as
 * strings; `/screen` does not fall under `/screen/`.
 */
export interface PrefixProxy {
  /**
   * Takes an HTTP/1.1 request under a prefix and answers `true`; answers
   * `false`, touching nothing, for any other request. The request goes to
   * `127.0.0.1:<port>` of the prefix's bundle's {@link HttpTarget} with its
   * method, target and headers, and the answer comes back as the bundle
   * sent it. Counted as a call in flight of the target instance until the
   * answer ends (`track`); the drain deadline destroys it. Without a target
   * (no active instance, or no `httpPort`): HTTP 503. A failed connection to
   * the target: HTTP 502. Never throws.
   */
  request(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): boolean;
  /**
   * Takes an `upgrade` request under a prefix and answers `true`; answers
   * `false`, touching nothing, for any other. Opens a TCP connection to the
   * target, writes the request line, headers and `head` to it, then copies
   * bytes both ways unchanged until either side closes, which closes the
   * other. The connection counts as a call in flight of the target instance
   * while it is open (`track`), so a draining generation keeps serving it
   * until it closes or the drain deadline destroys it. Without a target, or
   * when the connection to it fails: `HTTP/1.1 503` or `502` written to the
   * socket, then the socket destroyed. Never throws.
   */
  upgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): boolean;
}

/** A proxy over `options`; it holds no connection until a request comes. */
export const createPrefixProxy = (options: PrefixProxyOptions): PrefixProxy => {
  /** The bundle whose prefix `url`'s path falls under. */
  const bundleOf = (url: string | undefined): string | undefined => {
    const path = (url ?? '').split('?', 1)[0] ?? '';

    for (const [prefix, bundleId] of options.prefixes()) {
      if (path.startsWith(prefix)) {
        return bundleId;
      }
    }

    return undefined;
  };

  return {
    request: (request, response) => {
      const bundleId = bundleOf(request.url);

      if (bundleId === undefined) {
        return false;
      }

      const target = options.target(bundleId);

      if (target === undefined) {
        answer(response, 503);

        return true;
      }

      const outgoing = http.request(
        {
          host: '127.0.0.1',
          port: target.port,
          method: request.method,
          path: request.url,
          headers: request.headers,
          agent: false,
        },
        (incoming) => {
          response.writeHead(
            incoming.statusCode ?? 502,
            incoming.statusMessage,
            incoming.headers,
          );
          incoming.pipe(response);
        },
      );
      const release = options.track(target.key, () => {
        outgoing.destroy();
        response.destroy();
      });

      response.on('close', () => {
        outgoing.destroy();
        release();
      });
      outgoing.on('error', () => {
        if (response.headersSent) {
          response.destroy();
        } else {
          answer(response, 502);
        }
      });
      request.pipe(outgoing);

      return true;
    },
    upgrade: (request, socket, head) => {
      const bundleId = bundleOf(request.url);

      if (bundleId === undefined) {
        return false;
      }

      const target = options.target(bundleId);

      socket.on('error', () => {});

      if (target === undefined) {
        refuse(socket, 503);

        return true;
      }

      const upstream = net.connect(target.port, '127.0.0.1');
      const close = (): void => {
        upstream.destroy();
        socket.destroy();
        release();
      };
      const release = options.track(target.key, close);
      const onFailure = (): void => {
        release();
        refuse(socket, 502);
      };

      upstream.once('error', onFailure);
      upstream.once('connect', () => {
        upstream.off('error', onFailure);
        upstream.on('error', close);
        upstream.on('close', close);
        upstream.write(requestHead(request));
        upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      socket.on('close', close);

      return true;
    },
  };
};

/** Answers `status` with an empty body. */
const answer = (response: http.ServerResponse, status: number): void => {
  response.writeHead(status);
  response.end();
};

/** Writes `HTTP/1.1 <status>` to an upgrade's socket, then destroys it. */
const refuse = (socket: Duplex, status: number): void => {
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    () => socket.destroy(),
  );
};

/** The request line and headers of `request`, as it came. */
const requestHead = (request: http.IncomingMessage): string => {
  const lines = [
    `${request.method} ${request.url} HTTP/${request.httpVersion}`,
  ];
  const raw = request.rawHeaders;

  for (let at = 0; at + 1 < raw.length; at += 2) {
    lines.push(`${raw[at]}: ${raw[at + 1]}`);
  }

  return `${lines.join('\r\n')}\r\n\r\n`;
};
