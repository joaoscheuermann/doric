// `preview-surface.tsx` — the component that hosts a papercraft program
// (spec: "Uma superfície, duas molduras"; docs/architecture/bundles/papercraft/
// isolamento.md).
//
// Every program renders in its own sandboxed, opaque-origin iframe
// (`live-frame.tsx`), which runs the bundle's program runtime and speaks to
// the app only through the frame protocol (2, D6). The surface:
//
//   - provisions nothing of the app's theme: the program's sheets carry their
//     own, and only the reader's light or dark mode reaches it — at `init`,
//     and again whenever the app's mode changes;
//   - tells the frame its program (`program`), and draws no frame before it
//     has one;
//   - sizes the iframe by the layout the frame reports: `centered` hugs what
//     it renders (the reported width, up to the canvas's), `padded` and
//     `fullscreen` take the canvas's width; the height is always the
//     content's;
//   - hands on what the frame derives and reports (the scene, its input, its
//     errors) and keeps the last scene, size and mode of each revision
//     (`frame-memory.ts`);
//   - keeps a live frame only while the preview holds one of the window's
//     live frames (`live`, `live-frames.ts`). A dead preview draws its
//     stand-in (`stand-in.tsx`): its snapshot, else a placeholder with its
//     size and title, and hands the canvas the last scene its frame reported,
//     so pins, outlines and comments keep drawing. A promoted preview keeps
//     its stand-in over the new frame until the frame says it mounted;
//   - captures a live frame once it is stable on screen (`snapshots.ts`);
//   - gives a frame `readyTimeout` to say it mounted: past it, the stand-in
//     shows and the surface reports `fallback`, so the canvas is never empty;
//     a later `mounted` clears both.
//
// The frame is keyed by revision: a revision change, or the surface going,
// disposes the old frame (its unmount runs once, in the frame) and a stale
// frame's messages never reach the canvas, since its port is closed with it.

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  FrameErrorsMessage,
  InputCapture,
  PreviewLayout,
  PreviewTheme,
  ProgramFrameMessage,
  SceneNodeData,
} from '../frame-protocol.js';
import { programFrameSrc } from '../frame-url.js';
import { type FrameSize, lastFrameOf, rememberFrame } from './frame-memory.js';
import {
  type FrameCursor,
  LiveFrame,
  type ProgramContent,
} from './live-frame.js';
import {
  type SurfaceSnapshots,
  snapshotOf,
  useSnapshotCapture,
} from './snapshots.js';
import { StandIn } from './stand-in.js';

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
  ProgramFrameMessage,
  { kind: 'pointer' | 'wheel' | 'key' | 'focus' }
>;

export interface PreviewSurfaceProps {
  readonly artifactId: string;
  readonly revision: number;
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
  /** The frame document; the bundle's program runtime by default. */
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
  /** The frame's `init` and current `program`; no frame is drawn before it. */
  readonly program?: ProgramContent;
  /** Each `errors` message of the frame. */
  readonly onErrors?: (errors: FrameErrorsMessage['errors']) => void;
  /** The frame may be the window's warm frame (a fence's node). */
  readonly adopt?: boolean;
}

/** What the surface knows of the revision's content, per mount. */
interface Content {
  /** One per mount of the revision: the frame's key; 0 before the first. */
  readonly generation: number;
  /** The revision the content is of. */
  readonly artifactId: string;
  readonly revision: number;
}

const NOTHING_HIDDEN: ReadonlySet<string> = new Set();
const UNLOCKED: FrameCursor = { locked: false };

/** The program host: the live frame, sized by the layout it reports. */
export function PreviewSurface({
  artifactId,
  revision,
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
  program,
  onErrors,
  adopt = false,
}: PreviewSurfaceProps) {
  const [mode, setMode] = useState<SurfaceMode>('markup');
  const [layout, setLayout] = useState<SurfaceLayout>('fullscreen');
  const [size, setSize] = useState<FrameSize | undefined>(undefined);
  const [content, setContent] = useState<Content>({
    generation: 0,
    artifactId,
    revision,
  });
  const theme = useAppTheme();
  const src = useRef(frameSrc ?? programFrameSrc()).current;
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
  const reporters = useRef({ onScene, onMode, onInput, onErrors });
  reporters.current = { onScene, onMode, onInput, onErrors };

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
    generations.current += 1;

    reported.current = undefined;
    setSize(undefined);
    setLayout('fullscreen');
    setContent({ generation: generations.current, artifactId, revision });

    return () => {
      reporters.current.onScene?.(undefined);
    };
  }, [artifactId, revision]);

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
      setStalledKey(frameKey);
      report('fallback');
    }, readyTimeout);

    return () => clearTimeout(timer);
  }, [live, content.generation, mounted, frameKey, readyTimeout, report]);

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

  const onMessage = (message: ProgramFrameMessage): void => {
    switch (message.kind) {
      case 'errors':
        reporters.current.onErrors?.(message.errors);

        return;
      case 'mounted': {
        // A program that did not mount, by the frame's word, is the
        // fallback; it hugs what it shows as a component does.
        const next: SurfaceMode = message.mode;
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
      {content.generation === 0 || !live || program === undefined ? null : (
        <LiveFrame
          key={frameKey}
          src={src}
          program={program}
          adopt={adopt}
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
