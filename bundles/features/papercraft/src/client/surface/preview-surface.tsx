// `preview-surface.tsx` — the component that hosts the artifact (spec: "Uma
// superfície, duas molduras").
//
// No iframe, in either frame: the preview is mounted in the app itself, in a
// React-owned host with its own open shadow root. The surface:
//
//   - copies the app's theme variables onto the shadow host — the same set
//     `resolvedVariables` (packages/desktop/src/tokens/css.ts:33) resolves for
//     a window: the variant's palette, the shared tokens and the window
//     variables — so the artifact renders in the reader's theme;
//   - injects the revision's `index.css` by `<link rel="stylesheet">` (the CSP
//     allows `'self'` and `'unsafe-inline'`);
//   - imports the revision's compiled module from the app origin —
//     `doric://app/artifacts/<artifactId>@<revision>/index.js` (path B) — and
//     calls `mount(root, { theme })` on it, keeping the unmount it returns;
//   - falls back to the built markup of path A when the module does not load,
//     with the discreet one-line notice of decision 10, because the canvas is
//     never empty.
//
// The module shares the window's React through the import map, so errors inside
// it are contained here: the import and the mount are guarded, and any failure
// lands on the fallback.

import { tokens } from 'desktop/ui/tokens';
import { useEffect, useRef, useState } from 'react';

/** The contract a compiled artifact module exports ("O que o build entrega"). */
export interface PapercraftModule {
  mount(
    root: HTMLElement,
    context: { readonly theme: 'light' | 'dark' },
  ): undefined | (() => void);
}

/** The URL of one revision's module, as the desktop serves it. */
export const artifactModuleUrl = (
  artifactId: string,
  revision: number,
): string => `doric://app/artifacts/${artifactId}@${revision}/index.js`;

/** The URL of one revision's compiled Tailwind sheet. */
export const artifactStylesUrl = (
  artifactId: string,
  revision: number,
): string => `doric://app/artifacts/${artifactId}@${revision}/index.css`;

/**
 * `resolvedVariables` (packages/desktop/src/tokens/css.ts:33) as the client
 * resolves it: the variant's palette, the shared tokens and the window
 * variables the shell guarantees, stated once for the shadow host.
 */
export const resolvedThemeVariables = (
  variant: 'light' | 'dark',
): Readonly<Record<string, string>> => ({
  ...tokens.shared,
  ...tokens.variants[variant],
  '--doric-titlebar-height': `${String(tokens.window.titlebarHeight)}px`,
  '--doric-window-background': 'var(--background)',
  '--doric-safe-top': '0px',
  '--doric-safe-left': '0px',
  '--doric-safe-right': '0px',
});

/** The theme the app is in, as a mounted surface reads it. */
export const appTheme = (): 'light' | 'dark' =>
  typeof document !== 'undefined' &&
  document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'light';

/**
 * Renders one built markup document into a root. The built markup is a whole
 * document, and assigning it to `innerHTML` drops the `html`/`head`/`body`
 * wrappers, so the document's `body { … }` rules would match nothing. The
 * parser keeps the parts the shadow tree needs: the document's `style` nodes
 * become siblings of a real `body` element, which CSS selectors do match
 * inside a shadow root.
 */
export const renderMarkup = (surface: HTMLElement, markup: string): void => {
  const parsed = new DOMParser().parseFromString(markup, 'text/html');
  const body = document.createElement('body');
  body.innerHTML = parsed.body.innerHTML;

  surface.replaceChildren(...parsed.head.querySelectorAll('style'), body);
};

/** What the surface mounted: the live module, or the fallback markup. */
export type SurfaceMode = 'module' | 'fallback';

export interface PreviewSurfaceProps {
  readonly artifactId: string;
  readonly revision: number;
  /** The path-A built markup of the revision, as `papercraft.previews/v1` read it. */
  readonly markup: string | undefined;
  readonly height?: number;
  /**
   * Reports the shadow root once the revision's content is in it, so the
   * frame derives the scene graph of what is actually rendered.
   */
  readonly onContent?: (root: ShadowRoot | undefined) => void;
  /** Reports what the surface mounted: the live module, or the fallback. */
  readonly onMode?: (mode: SurfaceMode) => void;
}

/**
 * The artifact host. Everything inside the shadow root is imperative — React
 * renders the host div and never the shadow tree — because the module mounts
 * its own React root there.
 */
export function PreviewSurface({
  artifactId,
  revision,
  markup,
  height,
  onContent,
  onMode,
}: PreviewSurfaceProps) {
  const host = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<SurfaceMode>('fallback');

  useEffect(() => {
    const element = host.current;

    if (element === null) return;

    // One open shadow root per host, reused across revisions.
    const shadow =
      (element.shadowRoot as ShadowRoot | null) ??
      (element.attachShadow({ mode: 'open' }) as ShadowRoot);

    // The app's theme, copied to the host the module renders in.
    const theme = appTheme();

    for (const [name, value] of Object.entries(resolvedThemeVariables(theme))) {
      element.style.setProperty(name, value);
    }

    // The revision's compiled sheet; the CSP allows `'self'`.
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = artifactStylesUrl(artifactId, revision);
    shadow.append(link);

    const content = document.createElement('div');
    content.className = 'papercraft-content';
    shadow.append(content);

    let unmount: (() => void) | undefined;
    let settled = false;

    const settle = (next: SurfaceMode): void => {
      if (settled) return;
      settled = true;
      setMode(next);
      onMode?.(next);
      onContent?.(shadow);
    };

    void (async () => {
      try {
        const loaded = (await import(
          artifactModuleUrl(artifactId, revision)
        )) as PapercraftModule;

        if (typeof loaded.mount !== 'function')
          throw new TypeError('the artifact module exports no mount');

        const dispose = loaded.mount(content, { theme });

        unmount =
          typeof dispose === 'function'
            ? dispose
            : () => content.replaceChildren();

        settle('module');
      } catch {
        // The live module did not load — the canvas is never empty: the
        // built markup of path A stands in (decision 10).
        unmount = undefined;

        if (markup !== undefined) renderMarkup(content, markup);

        settle('fallback');
      }
    })();

    return () => {
      settled = true;

      try {
        unmount?.();
      } catch {
        // A module that fails to unmount takes nothing with it.
      }

      onContent?.(undefined);
      shadow.replaceChildren();
    };
  }, [artifactId, revision, markup, onContent, onMode]);

  return (
    <div
      ref={host}
      className="papercraft-surface-host"
      style={
        height === undefined ? undefined : { height: `${String(height)}px` }
      }
      data-mode={mode}
    />
  );
}
