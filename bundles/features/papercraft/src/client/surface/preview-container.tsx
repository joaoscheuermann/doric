// `preview-container.tsx` — the frame of one preview: the overlay header, the
// canvas that fills the frame and flows under it, the comment flow, pan/zoom,
// selection and layers (spec: "A UI no node e na janela").
//
// One surface, two moldings (`Uma superfície, duas molduras`). In the
// conversation (`chrome: 'node'`) the surface is the body of the `artifacts`
// registry's frame, and it draws its own header (the kind declares
// `header: 'body'`): the frame keeps only `Autorizar` below it. The node is
// a square — as tall as it is wide. The window (`chrome: 'canvas'`) draws
// the same surface full-screen, with the tree on the left and the command
// bar centred on the bottom edge.
//
// What is view state here — the armed tool, pan/zoom, selection, isolation,
// hidden layers, the open input — is local to the frame; what is durable stays
// in the events and is read back through `preview-data.ts`, in the preview's
// scope. The pins are both: the sent threads of the preview and its drafts,
// on every revision — a thread carries over to the next revision, keeps its
// number and re-places its pin through its anchor; a new comment is written
// against the revision on screen.
//
// The node lives inside the conversation, so it never takes the page's wheel
// or focus by passing over it: only the focused node shows its controls and
// the tool it had armed (`frame-focus.ts`), and the wheel pans only the
// focused node. The window is always focused.
//
// The preview itself renders in a sandboxed iframe (`preview-surface.tsx`,
// `live-frame.tsx`): the canvas reads what it rendered from the scene the
// frame reports, tells it which layers to hide, which cursor to show and
// whose input it is, and hears its pointer, wheel, keys and focus. In the
// conversation the node keeps a live frame only while it is one of the
// window's most recently used (`live-frames.ts`); otherwise the surface draws
// its snapshot (`snapshots.ts`), which the canvas takes with its own drawings
// concealed. The canvas window's revision is always live.
//
// The frame composes its parts: the scene (`scene.ts`), the fit (`fit.ts`),
// the focus (`frame-focus.ts`), the gestures and keys (`gestures.ts`), the
// comment flow (`comment-flow.ts`) and what it draws (`comment-overlay.tsx`),
// the conversation's requests (`thread-open.ts`) and the controller the
// commands act on (`controller.ts`). The children that do not move with the
// viewport — the header, the footer, the tree and the bar — are memoised on
// stable actions, so a pan or a zoom re-renders the canvas and its overlay,
// not the chrome around them.

import type { Services } from 'bundle/contracts';
import { TooltipProvider } from 'desktop/ui/tooltip';
import { cn } from 'desktop/ui/utils';
import { useCallback, useMemo, useRef, useState } from 'react';

import type { ChatFence } from '../../contracts/chat.js';
import {
  PAPERCRAFT_COMMENT_KIND,
  PapercraftSnapshotV1,
  PROGRAM_COMMENT_KIND,
  type PreviewScope,
  type PreviewTool,
} from '../../contracts/index.js';
import { touchController } from '../canvas-registry.js';
import { programFrameSrc } from '../frame-url.js';
import { type CanvasSource, canvasIdOf, targetKeyOf } from './canvas-source.js';
import { CommandToolbar } from './command-toolbar.js';
import { useCommentFlow, useCommentRequest } from './comment-flow.js';
import { CommentOverlay } from './comment-overlay.js';
import {
  type FrameReading,
  useCommandDispatch,
  usePreviewController,
} from './controller.js';
import { useFit } from './fit.js';
import { useFrameFocus } from './frame-focus.js';
import { canvasKeys, useCanvasGestures } from './gestures.js';
import type { ProgramContent } from './live-frame.js';
import { useLiveFrame } from './live-frames.js';
import { NodeFooter } from './node-footer.js';
import { HoverOutline, SelectionOutline } from './overlays.js';
import { anchorResolver } from './pin-geometry.js';
import type { CommentPin } from './pins-layer.js';
import { ensureRevisionCached, usePreviewData } from './preview-data.js';
import { PreviewHeader } from './preview-header.js';
import {
  type FrameInput,
  PreviewSurface,
  type SurfaceMode,
} from './preview-surface.js';
import { type OpenUIErrorOf, useProgramData } from './program-data.js';
import { useScene } from './scene.js';
import { targetBounds, targetById } from './scene-graph.js';
import type { SurfaceSnapshots } from './snapshots.js';
import { useThreadOpenRequests } from './thread-open.js';
import { DETACHED_STEP, openCountOf, pinsOf } from './threads-view.js';
import { TreePanel } from './tree-panel.js';
import {
  gridBackground,
  IDENTITY,
  type Viewport,
  viewportTransform,
  zoomPercent,
} from './viewport.js';

/** Which frame the surface sits in. */
export type PreviewChrome = 'node' | 'canvas';

export interface PreviewContainerProps {
  readonly services: Services;
  readonly chrome: PreviewChrome;
  /** The Project and Thread of the preview: every host call's scope. */
  readonly scope: PreviewScope | undefined;
  readonly artifactId: string;
  /** The node shows the revision its block was created with; the window opens at the newest. */
  readonly blockRevision?: number;
  /**
   * Bumped by each comment gesture of the registry's frame (the node is the
   * body inside it): every change toggles the comment tool.
   */
  readonly commentRequest?: number;
  /**
   * What the canvas shows (D26): a papercraft program's identity in one
   * Thread; `artifactId`'s artifact when absent.
   */
  readonly source?: CanvasSource;
  /** A program's node: the fences chat handed it, and its own fence's key. */
  readonly fences?: readonly ChatFence[];
  readonly fenceKey?: string;
}

/** What the canvas draws, read by the source's own data hook. */
interface CanvasData {
  readonly source: CanvasSource;
  /** The header's name: the file, else the title. */
  readonly title: string;
  readonly sourcePath: string | undefined;
  /** The canvas's title and source, for the stack's line to name. */
  readonly refs: { readonly title?: string; readonly source?: string };
  readonly revisions: {
    readonly current: number;
    readonly total: number;
    readonly list: readonly number[];
  };
  /** How many revisions the record read knows of (the old path). */
  readonly knownRevisions: number | undefined;
  readonly policy: 'proceed' | 'request';
  readonly selectedRevision: number | undefined;
  readonly selectRevision: (revision: number) => void;
  readonly reload: () => void;
  readonly threads: ReturnType<typeof usePreviewData>['threads'];
  readonly drafts: ReturnType<typeof usePreviewData>['drafts'];
  readonly reloadComments: () => void;
  readonly canComment: boolean;
  readonly approved: boolean;
  readonly surface:
    | {
        readonly kind: 'artifact';
        readonly markup: string | undefined;
        readonly entries: readonly string[] | undefined;
        readonly read: boolean;
      }
    | {
        readonly kind: 'program';
        readonly content: ProgramContent | undefined;
        readonly onErrors?: (errors: readonly OpenUIErrorOf[]) => void;
      };
}

/** One frame of a preview: an artifact's revisions, or a papercraft program's (D26). */
export function PreviewContainer(props: PreviewContainerProps) {
  return props.source?.kind === 'program' ? (
    <ProgramContainer {...props} source={props.source} />
  ) : (
    <ArtifactContainer {...props} />
  );
}

/** The old path's canvas: an artifact's revisions, read by `usePreviewData`. */
function ArtifactContainer(props: PreviewContainerProps) {
  const { services, chrome, scope, artifactId, blockRevision } = props;
  const data = usePreviewData({
    services,
    chrome,
    scope,
    artifactId,
    ...(blockRevision === undefined ? {} : { blockRevision }),
  });
  const { record, preview, selectedRevision } = data;
  const recordTitle = record?.title;
  const recordPath = record?.path;
  const refs = useMemo(
    () => ({
      ...(recordTitle === undefined ? {} : { title: recordTitle }),
      ...(recordPath === undefined ? {} : { source: recordPath }),
    }),
    [recordTitle, recordPath],
  );
  const total = record?.revisions ?? 1;
  const source = useMemo<CanvasSource>(
    () => ({ kind: 'artifact', artifactId }),
    [artifactId],
  );

  return (
    <CanvasFrame
      {...props}
      data={{
        ...data,
        source,
        title: record?.path ?? record?.title ?? artifactId,
        sourcePath: record?.path,
        refs,
        revisions: {
          current: selectedRevision ?? record?.revision ?? 1,
          total,
          list: Array.from({ length: total }, (_, index) => index + 1),
        },
        knownRevisions: record?.revisions,
        surface: {
          kind: 'artifact',
          markup: preview?.markup,
          entries: preview?.files.map((file) => file.path),
          read: preview !== undefined,
        },
      }}
    />
  );
}

/** A papercraft program's canvas, read by `useProgramData` (D6, D26). */
function ProgramContainer(
  props: PreviewContainerProps & {
    readonly source: Extract<CanvasSource, { kind: 'program' }>;
  },
) {
  const { services, chrome, scope, source, fences, fenceKey } = props;
  const data = useProgramData({
    services,
    chrome,
    scope,
    threadId: source.threadId,
    identity: source.identity,
    ...(fenceKey === undefined ? {} : { fenceKey }),
    ...(fences === undefined ? {} : { fences }),
  });
  const refs = useMemo(() => ({ title: source.identity }), [source.identity]);
  const list = useMemo(
    () => (data.revisions ?? []).map((one) => one.revision.revision),
    [data.revisions],
  );
  const selectedRevision = data.selected?.revision.revision;
  const noop = useCallback(() => undefined, []);

  // The window names an identity no fence of the Thread has (yet).
  if (
    chrome === 'canvas' &&
    data.revisions !== undefined &&
    data.selected === undefined
  ) {
    return (
      <div
        data-testid="papercraft-no-ui"
        className="flex h-full w-full items-center justify-center text-sm text-muted-foreground"
      >
        {`No UI named ${source.identity} in this thread.`}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-1">
      <CanvasFrame
        {...props}
        data={{
          source,
          title: source.identity,
          sourcePath: undefined,
          refs,
          revisions: {
            current: selectedRevision ?? list.at(-1) ?? 1,
            total: list.length,
            list,
          },
          knownRevisions: list.length,
          policy: 'proceed',
          selectedRevision,
          selectRevision: data.selectRevision,
          reload: noop,
          threads: data.threads,
          drafts: data.drafts,
          reloadComments: data.reloadComments,
          canComment: data.canComment,
          approved: false,
          surface: {
            kind: 'program',
            content: data.content,
            ...(data.onErrors === undefined ? {} : { onErrors: data.onErrors }),
          },
        }}
      />
      {data.notes.map((note) => (
        <p
          key={note}
          data-testid="papercraft-program-note"
          className="text-xs text-destructive"
        >
          {note}
        </p>
      ))}
    </div>
  );
}

const FALLBACK_NOTICE = 'o preview não carregou · mostrando o markup';

/** The comment balloon the pointer becomes in comment mode; its tip is the hotspot. */
const COMMENT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M2 22V12a10 10 0 1 1 10 10z" fill="#2563eb" stroke="white" stroke-width="1.5"/></svg>',
)}") 2 22, crosshair`;

/** What the listeners bound once read of the latest render. */
interface Latest extends FrameReading {
  readonly viewport: Viewport;
  readonly tool: PreviewTool;
}

/** One frame of a canvas: header, canvas, gesture, tree (window), bar (window). */
function CanvasFrame({
  services,
  chrome,
  scope,
  blockRevision,
  commentRequest,
  data,
}: PreviewContainerProps & { readonly data: CanvasData }) {
  const {
    source,
    policy,
    selectedRevision,
    selectRevision,
    reload,
    threads,
    drafts,
    reloadComments,
    canComment,
    approved,
    refs,
    surface,
  } = data;
  /** The canvas's key for every per-canvas store (D26). */
  const artifactId = canvasIdOf(source);
  const program = source.kind === 'program';
  const target = useMemo(() => targetKeyOf(source), [source]);
  const segment = useMemo(
    () =>
      source.kind === 'artifact'
        ? { artifactId: source.artifactId }
        : { identity: source.identity },
    [source],
  );

  const [tool, setTool] = useState<PreviewTool>('select');
  const [viewport, setViewport] = useState<Viewport>(IDENTITY);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [hoverId, setHoverId] = useState<string | undefined>(undefined);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>('markup');
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [showResolved, setShowResolved] = useState(true);

  const container = useRef<HTMLDivElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  const [measureRequest, setMeasureRequest] = useState(0);

  const latest = useRef<Latest>({
    viewport: IDENTITY,
    tool: 'select',
    selectedId: undefined,
    revision: undefined,
    scene: undefined,
  });

  /* The scene graph, derived by the frame from what the revision rendered --- */

  const { scene, onScene } = useScene();
  const requestMeasure = useCallback(
    () => setMeasureRequest((count) => count + 1),
    [],
  );

  latest.current = {
    viewport,
    tool,
    selectedId,
    revision: selectedRevision,
    scene,
  };

  /* The focus, the comment flow, the fit and the controller ------------------ */

  const focusCanvas = useCallback(() => {
    wrapper.current?.focus?.({ preventScroll: true });
    touchController(artifactId);
  }, [artifactId]);

  const { focused, capture, focusedRef, consumeFramePointer, onFrameFocus } =
    useFrameFocus({
      container,
      chrome,
      focusCanvas,
    });

  /** Whether the frame shows its controls and tools: the window always is. */
  const active = chrome === 'canvas' || focused;

  const showResolvedPins = useCallback(() => setShowResolved(true), []);

  const flow = useCommentFlow({
    services,
    scope,
    target,
    itemKind: program ? PROGRAM_COMMENT_KIND : PAPERCRAFT_COMMENT_KIND,
    revision: selectedRevision,
    threads,
    drafts,
    refs,
    reloadComments,
    showResolvedPins,
    container,
  });
  const inputOpen = flow.open !== undefined;

  useThreadOpenRequests({
    chrome,
    artifactId,
    ownRevision: blockRevision ?? selectedRevision,
    knownRevisions: data.knownRevisions,
    services,
    scope,
    showThread: flow.showThread,
  });

  const contentKey = `${artifactId}@${String(selectedRevision ?? blockRevision ?? 1)}`;

  // The node holds a live frame only among the window's most recently used;
  // the canvas window's revision stays live outside that count.
  const { live, use: markUsed } = useLiveFrame(
    chrome === 'node' ? contentKey : undefined,
    container,
  );
  const { areaSize, area, fitContent } = useFit({
    wrapper,
    scene,
    viewport,
    contentKey,
    requestMeasure,
    setViewport,
  });

  // The scope's members, not its identity, which may change every render.
  const scopeProject = scope?.projectId;
  const scopeThread = scope?.threadId;

  const controller = usePreviewController({
    chrome,
    artifactId,
    scopeProject,
    scopeThread,
    latest,
    setTool,
    setHidden,
    setViewport,
    setSelectedId,
    areaSize,
    fitContent,
    selectRevision,
    reload,
    sendNow: flow.sendNow,
  });
  const { execute, openCanvas } = useCommandDispatch(
    services,
    segment,
    scopeProject,
    scopeThread,
  );

  /* The view-state actions the chrome and the gestures share ------------------ */

  const setCommentMode = useCallback(
    (on: boolean) => {
      if (!on) flow.closeInput();
      setHoverId(undefined);
      setTool(on ? 'comment' : 'select');
    },
    [flow.closeInput],
  );
  const toggleCommentMode = useCallback(
    () => setCommentMode(latest.current.tool !== 'comment'),
    [setCommentMode],
  );
  const toggleShowResolved = useCallback(
    () => setShowResolved((shown) => !shown),
    [],
  );
  const toggleHidden = useCallback((nodeId: string) => {
    setHidden((current) => {
      const next = new Set(current);

      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);

      return next;
    });
  }, []);

  const { panning, framePointer, frameWheel } = useCanvasGestures({
    wrapper,
    chrome,
    focusedRef,
    scene,
    viewport,
    hidden,
    tool,
    active,
    spaceHeld,
    hoverId,
    inputOpen,
    canComment,
    setViewport,
    setSpaceHeld,
    onHover: setHoverId,
    onSelect: setSelectedId,
    focusCanvas,
    resolveInput: flow.resolveInput,
    onComment: flow.beginNew,
    program,
  });

  /** The node lets go of the focus: the canvas's, or the preview's frame's. */
  const release = useCallback(() => {
    const focus =
      typeof document === 'undefined' ? null : document.activeElement;

    if (focus instanceof HTMLElement && container.current?.contains(focus))
      focus.blur();
  }, []);

  const keys = canvasKeys({
    chrome,
    tool,
    inputOpen,
    canComment,
    release,
    setSpaceHeld,
    setCommentMode,
    closeInput: flow.closeInput,
  });

  // The frame's input, as the canvas's own: its first press only focuses an
  // unfocused node; then its pointer and wheel are the gestures', its keys
  // the canvas's (typed while the preview has the focus).
  const latestKeys = useRef(keys);
  latestKeys.current = keys;
  const onFrameInput = useCallback(
    (message: FrameInput) => {
      switch (message.kind) {
        case 'pointer':
          markUsed();
          if (!consumeFramePointer(message)) framePointer(message);

          return;
        case 'wheel':
          frameWheel(message);

          return;
        case 'key': {
          const handle =
            message.type === 'keydown'
              ? latestKeys.current.onKeyDown
              : latestKeys.current.onKeyUp;

          handle({ ...message, preventDefault: () => undefined });

          return;
        }
        case 'focus':
          onFrameFocus(message.focused);

          return;
      }
    },
    [consumeFramePointer, framePointer, frameWheel, onFrameFocus, markUsed],
  );

  // A snapshot is taken only while nothing moves the canvas or covers it,
  // with the canvas's drawings concealed for the capture (styles.css). The
  // canvas window's frame never dies, so it takes none.
  const busy = useRef<() => boolean>(() => false);
  busy.current = () => panning() || inputOpen;
  const snapshots = useMemo<SurfaceSnapshots | undefined>(
    () =>
      chrome !== 'node'
        ? undefined
        : {
            capture: async (rect) =>
              services.use(PapercraftSnapshotV1).capture({ rect }),
            busy: () => busy.current(),
            conceal: () => {
              const element = container.current;

              element?.setAttribute('data-capturing', 'true');

              return () => element?.removeAttribute('data-capturing');
            },
          },
    [services, chrome],
  );

  useCommentRequest(commentRequest, {
    canComment,
    armed: () => latest.current.tool === 'comment',
    toggle: () =>
      setTool((current) => (current === 'comment' ? 'select' : 'comment')),
    focusCanvas: () => wrapper.current?.focus?.({ preventScroll: true }),
    closeInput: flow.closeInput,
  });

  /* The pins: the preview's threads, on whatever revision, then its drafts --- */

  // Each anchor is placed once per scene; a pin whose anchor no longer
  // resolves is stacked by the content's edge, a fixed surface step apart
  // whatever the zoom.
  const resolve = useMemo(
    () => anchorResolver(scene?.graph, scene?.bounds, scene?.pseudoBounds),
    [scene],
  );
  const pins = useMemo<readonly CommentPin[]>(
    () =>
      pinsOf(
        threads,
        drafts,
        showResolved,
        resolve,
        DETACHED_STEP / viewport.scale,
      ),
    [threads, drafts, showResolved, resolve, viewport.scale],
  );

  /** What the comment control counts: the open threads and the draft pins. */
  const commentCount = openCountOf(threads, drafts);

  /** Whether a thread of the preview is resolved: the eye shows then. */
  const hasResolved = threads.some((candidate) => candidate.state === 'done');

  /* What the frame reads for its chrome ----------------------------------------- */

  // The header names the file (else the title) and the revision on screen.
  const title = data.title;
  const { current, total, list } = data.revisions;

  const revisions = useMemo(
    () => ({ current, total, list, approved }),
    [current, total, list, approved],
  );

  const resolvedToggle = useMemo(
    () =>
      hasResolved
        ? { shown: showResolved, onToggle: toggleShowResolved }
        : undefined,
    [hasResolved, showResolved, toggleShowResolved],
  );

  /** The canvas's cursor: the frame's own document shows it over the preview. */
  const cursorLocked =
    active && (tool === 'comment' || tool === 'pan' || spaceHeld);
  // `panning` reads a ref: each move of a drag renders with the new view,
  // and the frame is told only when the keyword changes.
  const cursor = cursorLocked
    ? {
        locked: true,
        cursor: panning()
          ? 'grabbing'
          : spaceHeld || tool === 'pan'
            ? 'grab'
            : 'crosshair',
      }
    : { locked: false };

  const selectedTarget =
    selectedId === undefined || scene === undefined
      ? undefined
      : targetById(scene.graph, selectedId);
  const hoverTarget =
    hoverId === undefined || scene === undefined
      ? undefined
      : targetById(scene.graph, hoverId);

  return (
    <TooltipProvider>
      <div
        ref={container}
        className={cn(
          // `papercraft-container` carries the chrome's face (styles.css).
          'papercraft-container relative overflow-hidden rounded-lg border border-border bg-card',
          // The node is a square: as tall as the conversation is wide. Every
          // child is absolute, so the ratio is the container's own.
          chrome === 'node' && 'aspect-square w-full',
          chrome === 'canvas' && 'h-full w-full rounded-none border-0',
          // The focused node says so in the app's primary colour.
          chrome === 'node' && focused && 'outline-2 outline-primary',
        )}
        data-chrome={chrome}
        data-tool={tool}
        data-active={active ? 'true' : 'false'}
      >
        <PreviewHeader
          chrome={chrome}
          title={title}
          controls={active}
          {...(selectedRevision === undefined
            ? {}
            : { revision: selectedRevision })}
          canOpen={scopeThread !== undefined}
          onOpen={openCanvas}
          commentActive={tool === 'comment'}
          canComment={canComment}
          commentCount={commentCount}
          onToggleComment={toggleCommentMode}
          {...(resolvedToggle === undefined ? {} : { resolvedToggle })}
          draftCount={drafts.length}
          onSend={flow.sendNow}
        />

        {/* The canvas: the transform the content and the pins ride. It fills
            the frame and flows under the header. Its role is an interactive
            graphical region — the canvas owns the space bar and its keys once
            the reader clicked it. */}
        <div
          ref={wrapper}
          role="application"
          aria-label="canvas do preview"
          tabIndex={-1}
          className={cn(
            'papercraft-canvas absolute inset-0 overflow-hidden outline-none',
            active && (spaceHeld || tool === 'pan') && 'cursor-grab',
            panning() && 'cursor-grabbing',
          )}
          // The dot grid rides the viewport, so it pans and zooms with the
          // content over the container's own background colour.
          style={{
            ...gridBackground(viewport),
            ...(active && tool === 'comment' && !spaceHeld
              ? { cursor: COMMENT_CURSOR }
              : {}),
          }}
          onKeyDown={keys.onKeyDown}
          onKeyUp={keys.onKeyUp}
        >
          <div
            className="papercraft-viewport absolute inset-0"
            style={{
              transform: viewportTransform(viewport),
              // The viewport math maps content to surface from the top-left
              // corner (`toContent`, `zoomAt`): so must the transform.
              transformOrigin: '0 0',
            }}
          >
            <PreviewSurface
              artifactId={artifactId}
              revision={selectedRevision ?? blockRevision ?? 1}
              markup={surface.kind === 'artifact' ? surface.markup : undefined}
              {...(surface.kind === 'artifact' && surface.entries !== undefined
                ? { entries: surface.entries }
                : {})}
              {...(surface.kind === 'program'
                ? {
                    protocol: 2 as const,
                    frameSrc: programFrameSrc(),
                    adopt: chrome === 'node',
                    ...(surface.content === undefined
                      ? {}
                      : { program: surface.content }),
                    ...(surface.onErrors === undefined
                      ? {}
                      : { onErrors: surface.onErrors }),
                  }
                : {})}
              // Path B: the revision's entries reach the desktop's verified
              // cache before the surface imports its module.
              ensure={(id, revision) =>
                ensureRevisionCached(services, scope, id, revision)
              }
              area={area}
              capture={capture}
              hidden={hidden}
              measureRequest={measureRequest}
              onScene={onScene}
              onMode={setSurfaceMode}
              onInput={onFrameInput}
              // The comment cursor (and the pan hand) stays over the
              // artifact's own elements, whatever cursor they declare.
              cursor={cursor}
              live={live}
              title={title}
              {...(snapshots === undefined ? {} : { snapshots })}
            />
          </div>

          {scene !== undefined && hoverTarget !== undefined ? (
            <HoverOutline
              target={hoverTarget}
              box={targetBounds(hoverTarget, scene.bounds, scene.pseudoBounds)}
              viewport={viewport}
              withLabel={!inputOpen}
            />
          ) : null}

          {active && scene !== undefined && selectedTarget !== undefined ? (
            <SelectionOutline
              box={targetBounds(
                selectedTarget,
                scene.bounds,
                scene.pseudoBounds,
              )}
              viewport={viewport}
            />
          ) : null}

          <CommentOverlay
            flow={flow}
            pins={pins}
            resolve={resolve}
            viewport={viewport}
            area={areaSize()}
            sourcePath={data.sourcePath}
            threaded={scopeThread !== undefined}
            showResolved={showResolved}
            onToggleShowResolved={toggleShowResolved}
            focusCanvas={focusCanvas}
          />
        </div>

        {/* The one-line notice of a module that did not load (decision 10). */}
        {surfaceMode === 'fallback' &&
        surface.kind === 'artifact' &&
        surface.read ? (
          <div
            data-testid="papercraft-notice"
            className="absolute inset-x-0 bottom-9 z-10 mx-auto w-fit rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
          >
            {FALLBACK_NOTICE}
          </div>
        ) : null}

        {chrome === 'node' && active ? (
          <NodeFooter
            zoom={zoomPercent(viewport)}
            onZoomOut={controller.zoomOut}
            onZoomReset={controller.zoomReset}
            onZoomIn={controller.zoomIn}
            onCenter={controller.zoomFit}
          />
        ) : null}

        {chrome === 'canvas' ? (
          <>
            <TreePanel
              graph={scene?.graph}
              selectedId={selectedTarget?.node.id ?? selectedId}
              hidden={hidden}
              onSelect={setSelectedId}
              onToggleHidden={toggleHidden}
            />
            <CommandToolbar
              artifactId={artifactId}
              execute={execute}
              tool={tool}
              pinCount={commentCount}
              hasSelection={selectedId !== undefined}
              hasHidden={hidden.size > 0}
              zoom={zoomPercent(viewport)}
              revisions={revisions}
              approvalNeeded={
                policy === 'request' &&
                selectedRevision !== undefined &&
                !approved
              }
            />
          </>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
