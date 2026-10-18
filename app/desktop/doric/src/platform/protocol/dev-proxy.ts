// Development (decision 73): windows still load `doric://app/<path>`; the
// shell template and `/platform/shell@<v>/*` (the legacy renderer's webpack
// output and its hot updates) come from the renderer dev server.

/** The renderer dev server; `DORIC_RENDERER_DEV_URL` overrides it. */
export const DEFAULT_DEV_SERVER_ORIGIN = 'http://localhost:4200';

export interface DevProxy {
  readonly origin: string;
  /** `GET <origin>/platform/shell@<v>/shell.html`. */
  template(): Promise<string>;
  /** `GET <origin><path>`, status and content-type copied. */
  forward(path: string): Promise<Response>;
}

export const createDevProxy = (input: {
  readonly origin: string;
  readonly shellPrefix: string;
  readonly fetch: (url: string) => Promise<Response>;
}): DevProxy => {
  const origin = input.origin.replace(/\/+$/, '');

  return {
    origin,
    template: async () => {
      const response = await input.fetch(
        `${origin}${input.shellPrefix}shell.html`,
      );

      if (!response.ok) {
        throw new Error(
          `The renderer dev server answered ${response.status} for shell.html.`,
        );
      }

      return await response.text();
    },
    forward: async (path) => {
      const response = await input.fetch(`${origin}${path}`);
      const type = response.headers.get('content-type');

      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: type === null ? {} : { 'content-type': type },
      });
    },
  };
};
