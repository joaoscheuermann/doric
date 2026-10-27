// A fake OAuth 2.1 authorization server on 127.0.0.1:0, standing for the one
// an MCP server names in its protected-resource metadata: metadata,
// dynamic client registration, PKCE-checked authorization codes and refresh
// tokens. The "browser" is the test: `approve` reads an authorization URL as
// the user's consent would, and `followRedirect` follows the AS's redirect.

import { createHash, randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

export interface AuthorizationServerOptions {
  /**
   * `code_challenge_methods_supported` in the metadata; `null` leaves the
   * field out. `['S256']` by default.
   */
  readonly codeChallengeMethods?: readonly string[] | null;
  /** Advertises `authorization_response_iss_parameter_supported`. */
  readonly issParameterSupported?: boolean;
}

/** The pair of tokens one grant issued. */
export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

/** What the user's consent answers: the redirect the AS sends the browser to. */
export interface Approval {
  readonly code: string;
  readonly state: string;
  readonly redirectUri: string;
}

export interface FakeAuthorizationServer {
  readonly issuer: string;
  /** Every path the AS was asked for, in order. */
  readonly paths: readonly string[];
  /** Bodies of `/register` calls. */
  readonly registrations: readonly Readonly<Record<string, unknown>>[];
  /** Bodies of `/token` calls. */
  readonly tokenRequests: readonly Readonly<Record<string, string>>[];
  /** Tokens issued, oldest first. */
  readonly issued: readonly IssuedTokens[];
  /** Access tokens the protected MCP server accepts; delete one to expire it. */
  readonly accessTokens: Set<string>;
  /** Consents to an authorization URL and answers the redirect it earns. */
  approve(authorizationUrl: string): Approval;
  close(): Promise<void>;
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

export const authorizationServer = async (
  options: AuthorizationServerOptions = {},
): Promise<FakeAuthorizationServer> => {
  const paths: string[] = [];
  const registrations: Record<string, unknown>[] = [];
  const tokenRequests: Record<string, string>[] = [];
  const issued: IssuedTokens[] = [];
  const accessTokens = new Set<string>();
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const refreshTokens = new Set<string>();
  let issuer = '';

  const issue = (): IssuedTokens => {
    const tokens = {
      accessToken: `access-token-${issued.length + 1}-${randomUUID()}`,
      refreshToken: `refresh-token-${issued.length + 1}-${randomUUID()}`,
    };
    issued.push(tokens);
    accessTokens.add(tokens.accessToken);
    refreshTokens.add(tokens.refreshToken);

    return tokens;
  };

  const tokenResponse = (res: ServerResponse, tokens: IssuedTokens) =>
    json(res, 200, {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: tokens.refreshToken,
    });

  const metadata = () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    ...(options.codeChallengeMethods === null
      ? {}
      : {
          code_challenge_methods_supported: options.codeChallengeMethods ?? [
            'S256',
          ],
        }),
    ...(options.issParameterSupported === true
      ? { authorization_response_iss_parameter_supported: true }
      : {}),
  });

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const url = new URL(req.url ?? '/', issuer);
    paths.push(url.pathname);

    if (url.pathname === '/.well-known/oauth-authorization-server') {
      json(res, 200, metadata());
      return;
    }

    if (url.pathname === '/register' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      registrations.push(body);
      json(res, 201, {
        ...body,
        client_id: `client-${registrations.length}`,
        client_id_issued_at: Math.floor(Date.now() / 1000),
      });
      return;
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      const body = Object.fromEntries(new URLSearchParams(await readBody(req)));
      tokenRequests.push(body);

      if (body.grant_type === 'authorization_code') {
        const grant = codes.get(body.code ?? '');

        if (
          grant === undefined ||
          grant.redirectUri !== body.redirect_uri ||
          s256(body.code_verifier ?? '') !== grant.challenge
        ) {
          json(res, 400, { error: 'invalid_grant' });
          return;
        }

        codes.delete(body.code ?? '');
        tokenResponse(res, issue());
        return;
      }

      if (
        body.grant_type === 'refresh_token' &&
        refreshTokens.has(body.refresh_token ?? '')
      ) {
        refreshTokens.delete(body.refresh_token ?? '');
        tokenResponse(res, issue());
        return;
      }

      json(res, 400, { error: 'invalid_grant' });
      return;
    }

    json(res, 404, { error: 'not_found' });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        json(res, 500, { error: String(error) });
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    paths,
    registrations,
    tokenRequests,
    issued,
    accessTokens,
    approve: (authorizationUrl) => {
      const url = new URL(authorizationUrl);
      const code = `code-${randomUUID()}`;
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge') ?? '',
        redirectUri,
      });

      return { code, state: url.searchParams.get('state') ?? '', redirectUri };
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
};

/**
 * Follows the AS's redirect as the browser would: a GET to the redirect URI
 * with the code and state, plus any extra query parameters (`iss`, `error`).
 */
export const followRedirect = async (
  approval: Approval,
  extra: Readonly<Record<string, string>> = {},
): Promise<number> => {
  const url = new URL(approval.redirectUri);
  url.searchParams.set('code', approval.code);
  url.searchParams.set('state', approval.state);

  for (const [name, value] of Object.entries(extra)) {
    url.searchParams.set(name, value);
  }

  const response = await fetch(url);
  await response.text();

  return response.status;
};
