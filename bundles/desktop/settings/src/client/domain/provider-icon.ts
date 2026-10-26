// What a configured provider is drawn as in the dashboard's Providers group
// and on its page: a local machine, its kind's brand, or a generic server.

const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

/** Whether a provider's endpoint points at this machine (Ollama, LM Studio…). */
export const isLocalEndpoint = (endpoint: string | undefined): boolean => {
  if (endpoint === undefined) return false;
  try {
    return localHosts.has(new URL(endpoint).hostname);
  } catch {
    return false;
  }
};

/** The marks a provider is drawn with. */
export type ProviderMark =
  | 'local'
  | 'openai'
  | 'openrouter'
  | 'claude'
  | 'codex'
  | 'server';

const brandMarks: ReadonlySet<string> = new Set<ProviderMark>([
  'openai',
  'openrouter',
  'claude',
  'codex',
]);

const isBrandMark = (kind: string): kind is ProviderMark =>
  brandMarks.has(kind);

/**
 * A provider's mark: `local` when its endpoint is on this machine whatever
 * its kind, else its kind's own brand, else `server` (kinds come from the host
 * and may be new).
 */
export const providerMark = (
  kind: string,
  endpoint: string | undefined,
): ProviderMark => {
  if (isLocalEndpoint(endpoint)) return 'local';
  return isBrandMark(kind) ? kind : 'server';
};

const sites: Readonly<
  Record<string, { readonly url: string; readonly label: string }>
> = {
  openrouter: { url: 'https://openrouter.ai', label: 'Open OpenRouter' },
};

/** The site a kind's page links out to, with the control's label; none for most kinds. */
export const providerSite = (
  kind: string,
): { readonly url: string; readonly label: string } | undefined =>
  Object.hasOwn(sites, kind) ? sites[kind] : undefined;
