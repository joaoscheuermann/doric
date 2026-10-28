// `preview-surface.tsx` — the component that hosts the artifact (spec: "Uma
// superfície, duas molduras"; docs/architecture/bundles/papercraft/
// isolamento.md).
//
// Every preview renders in its own sandboxed, opaque-origin iframe
// (`live-frame.tsx`), which runs the bundle's preview runtime and speaks to
// the app only through the frame protocol. The surface:
//
//   - provisions nothing of the app's theme: the module's sheet carries its
//     own (the Project's, or the generic one), and only the reader's light or
//     dark mode reaches it — at `init`, and again whenever the app's mode
//     changes;
//   - when the revision's entries name a compiled module (`index.js`, path B),
//     first has the revision's entries written into the desktop's verified
//     cache (`ensure`, which reaches `artifacts.cache/v1`), and only then
//     initialises the frame with the module's URL —
//     `doric://app/artifacts/<artifactId>@<revision>/index.js` — its sheet's
//     (when named) and path A's markup as the fallback the frame renders when
//     the module does not load or mount; a revision that cannot be cached
//     renders that markup straight away. Either way the one-line notice of
//     decision 10 shows, because the canvas is never empty;
//   - when the entries name no module — path A's `index.html` only — renders
//     that markup in the frame, with no module to load and no notice;
//   - sizes the iframe by Storybook's layout, as the frame reports it: a
//     component hugs what it renders (`centered`: the reported width, up to
//     the canvas's), `padded` and `fullscreen` (and an html page) take the
//     canvas's width; the height is always the content's;
//   - hands on what the frame derives and reports (the scene, its input) and
//     keeps the last scene, size and mode of each revision (`frame-memory.ts`);
//   - keeps a live frame only while the preview holds one of the window's
//     live frames (`live`, `live-frames.ts`). A dead preview draws its
//     stand-in (`stand-in.tsx`): its snapshot, else a placeholder with its
//     size and title, and hands the canvas the last scene its frame reported,
//     so pins, outlines and comments keep drawing. A promoted preview keeps
//     its stand-in over the new frame until the frame says it mounted;
//   - captures a live frame once it is stable on screen (`snapshots.ts`);
//   - gives a frame `readyTimeout` to say it mounted: past it, the stand-in
//     shows and the surface reports `fallback`, so the canvas is never empty
//     and the failure notice of decision 10 shows; a later `mounted` clears
//     both.
//
// The frame is keyed by revision: a revision change, or the surface going,
// disposes the old frame (its unmount runs once, in the frame) and a stale
// frame's messages never reach the canvas, since its port is closed with it.

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  FrameContent,
  FrameMessage,
  InputCapture,
  PreviewLayout,
  PreviewTheme,
  SceneNodeData,
} from '../frame-protocol.js';
import { previewFrameSrc } from '../frame-url.js';
import { type FrameSize, lastFrameOf, rememberFrame } from './frame-memory.js';
import { type FrameCursor, LiveFrame } from './live-frame.js';
import {
  type SurfaceSnapshots,
  snapshotOf,
  useSnapshotCapture,
} from './snapshots.js';
import { StandIn } from './stand-in.js';

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

/** The theme the app is in now. */
export const appTheme = (): PreviewTheme =>
  typeof document !== 'undefined' &&
  document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'light';

/**
 * The theme the app is in, followed live: the app switches its mode by the
 * `dark` class of its root element, so the surface watches that class.
 */
export const useAppTheme = (): PreviewTheme => {
  const [theme, setTheme] = useState<PreviewTheme>(appTheme);

  useEffect(() => {
    setTheme(appTheme());

    if (
      typeof document === 'undefined' ||
      typeof MutationObserver === 'undefined'
    )
      return;

    const observer = new MutationObserver(() => setTheme(appTheme()));

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  return theme;
};

/**
 * How long a frame has to say it mounted, once it was told what to render,
 * before the surface shows its stand-in and reports the fallback.
 */
export const READY_TIMEOUT_MS = 10_000;

/**
 * Says on the window's console why a revision fell back to its markup: the
 * notice on the canvas names no cause, and each one has its own remedy.
 */
const warnFallback = (
  artifactId: string,
  revision: number,
  reason: string,
): void => {
  console.warn(
    `papercraft: ${artifactId}@${String(revision)} shows its markup: ${reason}`,
  );
};

/** The entry a revision names when it carries path B's compiled module. */
export const MODULE_ENTRY = 'index.js';

/** The entry of path B's compiled Tailwind sheet. */
export const STYLES_ENTRY = 'index.css';

/**
 * What the surface mounted: the live module, the markup of a revision that
 * has no module, or the markup standing in for a module that did not load.
 */
export type SurfaceMode = 'module' | 'markup' | 'fallback';

/**
 * Storybook's layout the preview is sized by: `centered` hugs the content;
 * `padded` and `fullscreen` lay it out at the canvas's width.
 */
export type SurfaceLayout = PreviewLayout;

/** The frame's messages the canvas acts on: its input and its focus. */
export type FrameInput = Extract<
  FrameMessage,
  { kind: 'pointer' | 'wheel' | 'key' | 'focus' }
>;

export interface PreviewSurfaceProps {
  readonly artifactId: string;
  readonly revision: number;
  /** The path-A built markup of the revision, as `papercraft.previews/v1` read it. */
  readonly markup: string | undefined;
  /** The paths of the revision's entries; a module is loaded only when named. */
  readonly entries?: readonly string[];
  /**
   * Makes the revision's entries servable at the app origin before the frame
   * loads its module (the desktop's verified cache); a rejection falls back
   * to the markup. Called only when the entries name a module; read when the
   * revision mounts, so a new identity never remounts the artifact.
   */
  readonly ensure?: (artifactId: string, revision: number) => Promise<void>;
  /** A fixed height for the iframe; the content's height otherwise. */
  readonly height?: number;
  /** The canvas's size, in surface pixels: the width a page lays out at. */
  readonly area?: { readonly width: number; readonly height: number };
  /** Who handles the preview's pointer and keys. */
  readonly capture?: InputCapture;
  /** The ids of the current scene's nodes to hide. */
  readonly hidden?: ReadonlySet<string>;
  /** The canvas's cursor, which wins over every cursor the artifact declares. */
  readonly cursor?: FrameCursor;
  /** Bumped to ask the frame for a fresh scene (the canvas resized). */
  readonly measureRequest?: number;
  /** Reports each scene the frame derives; undefined when the frame goes. */
  readonly onScene?: (nodes: readonly SceneNodeData[] | undefined) => void;
  /** Reports what the surface mounted: the live module, or the fallback. */
  readonly onMode?: (mode: SurfaceMode) => void;
  /** Reports the frame's pointer, wheel, keys and focus. */
  readonly onInput?: (message: FrameInput) => void;
  /** The frame document; the bundle's preview runtime by default. */
  readonly frameSrc?: string;
  /**
   * Whether the preview holds one of the window's live frames
   * (`live-frames.ts`); a dead preview draws its stand-in. Live by default.
   */
  readonly live?: boolean;
  /** The preview's name, which its placeholder shows. */
  readonly title?: string;
  /** The window's capture of a stable live frame; without it, none is taken. */
  readonly snapshots?: SurfaceSnapshots;
  /** How long a frame may take to say it mounted (`READY_TIMEOUT_MS`). */
  readonly readyTimeout?: number;
}

/** What the surface knows of the revision's content, per mount. */
interface Content {
  /** One per mount of the revision: the frame's key; 0 before the first. */
  readonly generation: number;
  /** The revision the content is of. */
  readonly artifactId: string;
  readonly revision: number;
  readonly content: FrameContent | undefined;
  /** The cache refused the revision: its markup stands in. */
  readonly uncached: boolean;
}

const NOTHING_HIDDEN: ReadonlySet<string> = new Set();
const UNLOCKED: FrameCursor = { locked: false };

/** The artifact host: the live frame, sized by the layout it reports. */
export function PreviewSurface({
  artifactId,
  revision,
  markup,
  entries,
  ensure,
  height,
  area,
  capture = 'all',
  hidden = NOTHING_HIDDEN,
  cursor = UNLOCKED,
  measureRequest = 0,
  onScene,
  onMode,
  onInput,
  frameSrc,
  live = true,
  title,
  snapshots,
  readyTimeout = READY_TIMEOUT_MS,
}: PreviewSurfaceProps) {
  const hasModule = entries?.includes(MODULE_ENTRY) === true;
  const hasStyles = entries?.includes(STYLES_ENTRY) === true;

  const [mode, setMode] = useState<SurfaceMode>('markup');
  const [layout, setLayout] = useState<SurfaceLayout>(
    hasModule ? 'centered' : 'fullscreen',
  );
  const [size, setSize] = useState<FrameSize | undefined>(undefined);
  const [content, setContent] = useState<Content>({
    generation: 0,
    artifactId,
    revision,
    content: undefined,
    uncached: false,
  });
  const theme = useAppTheme();
  const src = useRef(frameSrc ?? previewFrameSrc()).current;
  const host = useRef<HTMLDivElement>(null);

  // Each time the preview turns live again its frame is a new one: the
  // frame's key counts the mounts of the revision and the promotions.
  const [epoch, setEpoch] = useState({ live, count: 0 });

  if (epoch.live !== live) {
    setEpoch({ live, count: live ? epoch.count + 1 : epoch.count });
  }

  const frameKey = `${String(content.generation)}.${String(epoch.count)}`;
  /** The frame that said it mounted, and the one that did not in time. */
  const [mountedKey, setMountedKey] = useState<string | undefined>(undefined);
  const [stalledKey, setStalledKey] = useState<string | undefined>(undefined);
  const mounted = mountedKey === frameKey;
  const stalled = stalledKey === frameKey;

  // The reporters are read when a message arrives, so a new callback
  // identity never remounts the artifact.
  const reporters = useRef({ onScene, onMode, onInput, ensure });
  reporters.current = { onScene, onMode, onInput, ensure };

  /** The frame (its key) that last said what it mounted, or failed to. */
  const settled = useRef<string | undefined>(undefined);
  /** The mode last reported for the current mount, reported once each. */
  const reported = useRef<SurfaceMode | undefined>(undefined);
  const generations = useRef(0);

  const report = useCallback((next: SurfaceMode): void => {
    setMode(next);
    if (reported.current === next) return;
    reported.current = next;
    reporters.current.onMode?.(next);
  }, []);

  useEffect(() => {
    let disposed = false;
    generations.current += 1;
    const generation = generations.current;

    reported.current = undefined;
    setSize(undefined);
    setLayout(hasModule ? 'centered' : 'fullscreen');
    setContent({
      generation,
      artifactId,
      revision,
      content: undefined,
      uncached: false,
    });

    const settle = (next: SurfaceMode): void => {
      setMode(next);
      reported.current = next;
      reporters.current.onMode?.(next);
    };

    const show = (next: FrameContent | undefined, uncached = false): void => {
      if (disposed) return;
      setContent({ generation, artifactId, revision, content: next, uncached });
    };

    const markupContent: FrameContent | undefined =
      markup === undefined ? undefined : { kind: 'markup', markup };

    if (!hasModule) {
      // A revision without a module: path A's markup is the revision.
      settle('markup');
      show(markupContent);
    } else {
      void (async () => {
        try {
          // The route serves only what the cache verified: the revision's
          // entries reach it before the frame is told the module's URL.
          await reporters.current.ensure?.(artifactId, revision);

          show({
            kind: 'module',
            module: artifactModuleUrl(artifactId, revision),
            ...(hasStyles
              ? { styles: artifactStylesUrl(artifactId, revision) }
              : {}),
            ...(markup === undefined ? {} : { fallback: markup }),
          });
        } catch (error) {
          if (disposed) return;
          // The revision could not be cached — the canvas is never empty:
          // the built markup of path A stands in (decision 10).
          warnFallback(
            artifactId,
            revision,
            `the revision could not be cached (${error instanceof Error ? error.message : String(error)})`,
          );
          settle('fallback');
          setLayout('centered');
          show(markupContent, true);
        }
      })();
    }

    return () => {
      disposed = true;
      reporters.current.onScene?.(undefined);
    };
  }, [artifactId, revision, markup, hasModule, hasStyles]);

  const uncached = content.uncached;

  const areaWidth =
    area !== undefined && area.width > 0 ? area.width : undefined;
  const areaHeight =
    area !== undefined && area.height > 0 ? area.height : undefined;

  // `centered` hugs the reported width, up to the canvas's; the layouts that
  // fill take the canvas's width. Before the first size the frame lays out
  // at the canvas's size, so a page has a viewport to fill.
  const frameWidth =
    layout === 'centered' && size !== undefined
      ? areaWidth === undefined
        ? size.width
        : Math.min(size.width, areaWidth)
      : areaWidth;
  const frameHeight = height ?? size?.height ?? areaHeight;

  // A frame that never says it mounted — its document did not load, its
  // runtime never answered, its content never came — would leave the canvas
  // empty: past the timeout its stand-in shows, with the failure notice.
  useEffect(() => {
    if (!live || content.generation === 0 || mounted) return;

    const timer = setTimeout(() => {
      warnFallback(
        artifactId,
        revision,
        `its frame did not say it mounted within ${String(readyTimeout)} ms`,
      );
      setStalledKey(frameKey);
      report('fallback');
    }, readyTimeout);

    return () => clearTimeout(timer);
  }, [
    live,
    content.generation,
    mounted,
    frameKey,
    readyTimeout,
    report,
    artifactId,
    revision,
  ]);

  // A dead preview hands the canvas the last scene its frame reported, so
  // the pins, outlines and comments keep drawing over its stand-in.
  useEffect(() => {
    if (live || content.generation === 0) return;

    const record = lastFrameOf(artifactId, revision);

    if (record?.scene !== undefined) reporters.current.onScene?.(record.scene);
    if (record?.mode !== undefined) report(record.mode);
  }, [live, content.generation, artifactId, revision, report]);

  const { sceneChanged } = useSnapshotCapture({
    host,
    target:
      live &&
      mounted &&
      hidden.size === 0 &&
      frameWidth !== undefined &&
      frameWidth > 0 &&
      frameHeight !== undefined &&
      frameHeight > 0
        ? {
            artifactId,
            revision,
            theme,
            width: frameWidth,
            height: frameHeight,
          }
        : undefined,
    snapshots,
  });

  /* The stand-in: what the frame last showed, at the size it had ----------- */

  const memory =
    content.generation === 0 ? undefined : lastFrameOf(artifactId, revision);
  const standInWidth = memory?.width ?? frameWidth;
  const snapshot =
    standInWidth === undefined
      ? undefined
      : snapshotOf({ artifactId, revision, theme, width: standInWidth });
  const standIn: 'none' | 'alone' | 'over' =
    content.generation === 0
      ? 'none'
      : !live
        ? 'alone'
        : !mounted && (snapshot !== undefined || stalled)
          ? 'over'
          : 'none';

  const onMessage = (message: FrameMessage): void => {
    switch (message.kind) {
      case 'mounted': {
        // A module that did not load, by the frame's word or the cache's,
        // is the fallback; it hugs its markup as a component does.
        const next: SurfaceMode = uncached ? 'fallback' : message.mode;

        if (message.mode === 'fallback') {
          warnFallback(
            content.artifactId,
            content.revision,
            'its frame could not load or mount the module (see the frame console)',
          );
        }
        const shown: SurfaceLayout =
          next === 'fallback' ? 'centered' : message.layout;

        settled.current = frameKey;
        setMountedKey(frameKey);
        report(next);
        setLayout(shown);
        rememberFrame(content.artifactId, content.revision, {
          mode: next,
          layout: shown,
          theme,
        });

        return;
      }
      case 'error':
        // A revision that fails before it mounted is the fallback's case;
        // an error after it rendered is the preview's own, contained.
        if (settled.current !== frameKey) {
          warnFallback(
            content.artifactId,
            content.revision,
            `its frame failed before it mounted (${message.message})`,
          );
          settled.current = frameKey;
          report('fallback');
        }

        return;
      case 'size':
        setSize({ width: message.width, height: message.height });
        rememberFrame(content.artifactId, content.revision, {
          size: { width: message.width, height: message.height },
        });

        return;
      case 'scene':
        reporters.current.onScene?.(message.nodes);
        sceneChanged();
        rememberFrame(content.artifactId, content.revision, {
          scene: message.nodes,
          theme,
          ...(frameWidth === undefined ? {} : { width: frameWidth }),
        });

        return;
      case 'ready':
        return;
      default:
        reporters.current.onInput?.(message);
    }
  };

  return (
    <div
      ref={host}
      className="papercraft-surface-host relative"
      data-mode={mode}
      data-layout={layout}
      data-cursor={cursor.locked ? 'locked' : undefined}
      data-live={live ? 'true' : 'false'}
    >
      {standIn === 'none' ? null : (
        <StandIn
          snapshot={snapshot}
          width={standInWidth}
          height={height ?? memory?.size?.height ?? frameHeight}
          title={title}
          over={standIn === 'over'}
        />
      )}
      {/* The live boundary: one frame per mount of a revision, while the
          preview holds one of the window's live frames. */}
      {content.generation === 0 || !live ? null : (
        <LiveFrame
          key={frameKey}
          src={src}
          content={content.content}
          theme={theme}
          capture={capture}
          hidden={[...hidden]}
          cursor={cursor}
          measureRequest={measureRequest}
          style={{
            ...(frameWidth === undefined
              ? {}
              : { width: `${String(frameWidth)}px` }),
            ...(frameHeight === undefined
              ? {}
              : { height: `${String(frameHeight)}px` }),
            // The frame document's scheme (the runtime sets the same one):
            // an iframe whose scheme differs from its document's is painted
            // opaque. Until the frame mounted, its document is still the
            // blank one loading, so the frame is not shown at all.
            colorScheme: theme,
            ...(mounted ? {} : { visibility: 'hidden' }),
          }}
          onMessage={onMessage}
        />
      )}
    </div>
  );
}
