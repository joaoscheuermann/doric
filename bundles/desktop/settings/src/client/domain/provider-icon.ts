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
