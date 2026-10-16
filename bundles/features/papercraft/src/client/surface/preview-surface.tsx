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
//   - when the revision's entries name a compiled module (`index.js`, path B),
//     first has the revision's entries written into the desktop's verified
//     cache (`ensure`, which reaches `artifacts.cache/v1`), then injects its
//     `index.css` (when named) by `<link rel="stylesheet">` and imports the
//     module from the app origin —
//     `doric://app/artifacts/<artifactId>@<revision>/index.js` — calling
//     `mount(root, { theme })` and keeping the unmount it returns; when that
//     revision cannot be cached or its module does not load, the built markup
//     of path A stands in, with the
//     discreet one-line notice of decision 10, because the canvas is never
//     empty;
//   - keeps the module's portal container (`[data-papercraft-portal]`, which
//     `mount` creates beside its React root) inside the content's containing
//     block, and reports the content again when an overlay opens in it;
//   - when the entries name no module — what the host builds today, which is
//     path A's `index.html` only — mounts that markup directly, with no import
//     to attempt and no notice to show.
//
// The module shares the window's React through the import map, so errors inside
// it are contained here: the import and the mount are guarded, a stale import
// (the revision changed, or the surface unmounted, while it loaded) is never
// mounted, and the unmount runs once.

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

  // The body's own attributes (its origin stamp, a class the styles key on)
  // survive the mount, as its children do.
  for (const attribute of [...parsed.body.attributes]) {
    body.setAttribute(attribute.name, attribute.value);
  }

  body.innerHTML = parsed.body.innerHTML;

  surface.replaceChildren(...parsed.head.querySelectorAll('style'), body);
};

/**
 * The shadow root's first sheet. Inherited properties cross a shadow
 * boundary, so without it the artifact would take the conversation's text
 * colour and font; the host starts from initial values instead, as a
 * standalone document does, and the artifact's own rules come after this one
 * and win. Custom properties are not reset, so the theme variables the host
 * carries still reach the artifact.
 */
export const SURFACE_RESET = [
  // `all` resets the cursor too; the canvas's cursor still reaches inside.
  ':host { all: initial; display: block; color-scheme: light; cursor: inherit; }',
  // While a tool owns the pointer, no element of the artifact overrides it.
  ':host([data-cursor="locked"]) * { cursor: inherit !important; }',
  // The content is the containing block of the module's portaled overlays
  // (`fixed`/`absolute` dialogs, popovers): they stay inside the preview,
  // under the canvas's zoom, instead of spanning the window.
  '.papercraft-content { display: block; min-height: 100%; position: relative; contain: layout; }',
  'body { display: block; margin: 8px; background: Canvas; color: CanvasText; }',
].join('\n');

const resetSheet = (): HTMLStyleElement => {
  const style = document.createElement('style');
  style.textContent = SURFACE_RESET;

  return style;
};

/** The window's own dynamic import, resolved against the import map. */
const importModule = (url: string): Promise<unknown> => import(url);

/** The entry a revision names when it carries path B's compiled module. */
export const MODULE_ENTRY = 'index.js';

/** The entry of path B's compiled Tailwind sheet. */
export const STYLES_ENTRY = 'index.css';

/**
 * What the surface mounted: the live module, the markup of a revision that
 * has no module, or the markup standing in for a module that did not load.
 */
export type SurfaceMode = 'module' | 'markup' | 'fallback';

export interface PreviewSurfaceProps {
  readonly artifactId: string;
  readonly revision: number;
  /** The path-A built markup of the revision, as `papercraft.previews/v1` read it. */
  readonly markup: string | undefined;
  /** The paths of the revision's entries; a module is imported only when named. */
  readonly entries?: readonly string[];
  /** How a module URL is imported; the window's own `import()` by default. */
  readonly load?: (url: string) => Promise<unknown>;
  /**
   * Makes the revision's entries servable at the app origin before its module
   * is imported (the desktop's verified cache); a rejection falls back to the
   * markup. Called only when the entries name a module; read when the
   * revision mounts, so a new identity never remounts the artifact.
   */
  readonly ensure?: (artifactId: string, revision: number) => Promise<void>;
  readonly height?: number;
  /**
   * Reports the shadow root once the revision's content is in it, so the
   * frame derives the scene graph of what is actually rendered.
   */
  readonly onContent?: (root: ShadowRoot | undefined) => void;
  /** Reports what the surface mounted: the live module, or the fallback. */
  readonly onMode?: (mode: SurfaceMode) => void;
  /** The canvas's cursor wins over every cursor the artifact declares. */
  readonly lockCursor?: boolean;
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
  entries,
  load = importModule,
  ensure,
  height,
  onContent,
  onMode,
  lockCursor = false,
}: PreviewSurfaceProps) {
  const host = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<SurfaceMode>('markup');

  // The reporters are read when a mount settles, so a new callback identity
  // never remounts the artifact.
  const reporters = useRef({ onContent, onMode, ensure });
  reporters.current = { onContent, onMode, ensure };

  const hasModule = entries?.includes(MODULE_ENTRY) === true;
  const hasStyles = entries?.includes(STYLES_ENTRY) === true;

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

    const content = document.createElement('div');
    content.className = 'papercraft-content';

    let disposed = false;
    let unmount: (() => void) | undefined;

    const settle = (next: SurfaceMode): void => {
      if (disposed) return;
      setMode(next);
      reporters.current.onMode?.(next);
      reporters.current.onContent?.(shadow);
    };

    const showMarkup = (next: SurfaceMode): void => {
      if (markup !== undefined) renderMarkup(content, markup);
      settle(next);
    };

    // An overlay the module portals into its portal container (inside the
    // content) opens after the mount: the content is reported again, so the
    // frame's scene graph — and comments — reach it.
    let portalObserver: MutationObserver | undefined;

    const watchPortal = (): void => {
      const portal = content.querySelector('[data-papercraft-portal]');

      if (portal === null || typeof MutationObserver === 'undefined') return;

      let queued = false;
      portalObserver = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (!disposed) reporters.current.onContent?.(shadow);
        });
      });
      portalObserver.observe(portal, { childList: true, subtree: true });
    };

    shadow.replaceChildren(resetSheet(), content);

    if (!hasModule) {
      // A revision without a module: path A's markup is the revision.
      showMarkup('markup');
    } else {
      void (async () => {
        try {
          // The route serves only what the cache verified: the revision's
          // entries reach it first.
          await reporters.current.ensure?.(artifactId, revision);

          if (disposed) return;

          if (hasStyles) {
            // The revision's compiled sheet, once cached; the CSP allows
            // `'self'`.
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = artifactStylesUrl(artifactId, revision);
            shadow.insertBefore(link, content);
          }

          const loaded = (await load(
            artifactModuleUrl(artifactId, revision),
          )) as PapercraftModule;

          // The revision changed, or the surface unmounted, while the module
          // loaded: a stale module is never mounted.
          if (disposed) return;

          if (typeof loaded.mount !== 'function')
            throw new TypeError('the artifact module exports no mount');

          const dispose = loaded.mount(content, { theme });

          unmount =
            typeof dispose === 'function'
              ? dispose
              : () => content.replaceChildren();

          settle('module');
          watchPortal();
        } catch {
          // The revision could not be cached, or its module did not load —
          // the canvas is never empty: the built markup of path A stands in
          // (decision 10).
          if (!disposed) showMarkup('fallback');
        }
      })();
    }

    return () => {
      disposed = true;
      portalObserver?.disconnect();

      const release = unmount;
      unmount = undefined;

      try {
        release?.();
      } catch {
        // A module that fails to unmount takes nothing with it.
      }

      reporters.current.onContent?.(undefined);
      shadow.replaceChildren();
    };
  }, [artifactId, revision, markup, hasModule, hasStyles, load]);

  return (
    <div
      ref={host}
      className="papercraft-surface-host"
      style={
        height === undefined ? undefined : { height: `${String(height)}px` }
      }
      data-mode={mode}
      data-cursor={lockCursor ? 'locked' : undefined}
    />
  );
}
