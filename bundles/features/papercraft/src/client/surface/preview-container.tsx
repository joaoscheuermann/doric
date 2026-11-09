// `preview-container.tsx` — the frame of one preview: the overlay header, the
// canvas that fills the frame and flows under it, the comment flow, pan/zoom,
// selection and layers (spec: "A UI no node e na janela").
//
// One surface, two moldings (`Uma superfície, duas molduras`). In the
// conversation (`chrome: 'node'`) the surface is a papercraft fence's node,
// and it draws its own header. The node is a square — as tall as it is wide.
// The window (`chrome: 'canvas'`) draws
// the same surface full-screen, with the tree on the left and the command
// bar centred on the bottom edge.
//
// What is view state here — the armed tool, pan/zoom, selection, isolation,
// hidden layers, the open input — is local to the frame; what is durable stays
// in the events and is read back through `program-data.ts`, in the program's
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
// and the controller the
// commands act on (`controller.ts`). The children that do not move with the
// viewport — the header, the footer, the tree and the bar — are memoised on
// stable actions, so a pan or a zoom re-renders the canvas and its overlay,
// not the chrome around them.

import type { Services } from 'bundle/contracts';
import { TooltipProvider } from 'desktop/ui/tooltip';
import { cn } from 'desktop/ui/utils';
import { CircleAlertIcon } from 'lucide-react';
import type { ShownError } from 'openui/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ChatFence } from '../../contracts/chat.js';
import {
  COMMENT_THREAD_OPEN_EVENT,
  type CommentThreadOpenDetail,
  PapercraftSnapshotV1,
  PROGRAM_COMMENT_KIND,
  type PreviewScope,
  type PreviewTool,
} from '../../contracts/index.js';
import { touchController } from '../canvas-registry.js';
import { programFrameSrc } from '../frame-url.js';
import { type CanvasSource, canvasIdOf, targetKeyOf } from './canvas-source.js';
import { CommandToolbar } from './command-toolbar.js';
import { useCommentFlow } from './comment-flow.js';
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
import { PreviewHeader } from './preview-header.js';
import { type FrameInput, PreviewSurface } from './preview-surface.js';
import { type OpenUIErrorOf, useProgramData } from './program-data.js';
import { ProgramErrorsCard } from './program-errors-card.js';
import { useScene } from './scene.js';
import { targetBounds, targetById } from './scene-graph.js';
import type { SurfaceSnapshots } from './snapshots.js';
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
  /** What the canvas shows (D26): a papercraft program's identity in one Thread. */
  readonly source: CanvasSource;
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
  readonly selectedRevision: number | undefined;
  readonly selectRevision: (revision: number) => void;
  readonly threads: ReturnType<typeof useProgramData>['threads'];
  readonly drafts: ReturnType<typeof useProgramData>['drafts'];
  readonly reloadComments: () => void;
  readonly canComment: boolean;
  readonly surface: {
    readonly content: ProgramContent | undefined;
    readonly onErrors?: (errors: readonly OpenUIErrorOf[]) => void;
    /** The card's lines, which the "Nothing to draw" notice reads (D26). */
    readonly errors: readonly ShownError[];
    /** The shown fence is `closed` or `unterminated`. */
    readonly complete: boolean;
  };
}

/** One frame of a papercraft program's canvas, read by `useProgramData` (D6, D26). */
export function PreviewContainer(props: PreviewContainerProps) {
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
          selectedRevision,
          selectRevision: data.selectRevision,
          threads: data.threads,
          drafts: data.drafts,
          reloadComments: data.reloadComments,
          canComment: data.canComment,
          surface: {
            content: data.content,
            onErrors: data.onErrors,
            errors: data.errors.lines,
            complete:
              data.selected?.fence.state === 'closed' ||
              data.selected?.fence.state === 'unterminated',
          },
        }}
      />
      {data.errors.lines.length === 0 ? null : (
        <ProgramErrorsCard lines={data.errors.lines} sent={data.errors.sent} />
      )}
    </div>
  );
}

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
  data,
}: PreviewContainerProps & { readonly data: CanvasData }) {
  const {
    source,
    selectedRevision,
    selectRevision,
    threads,
    drafts,
    reloadComments,
    canComment,
    refs,
    surface,
  } = data;
  /** The canvas's key for every per-canvas store (D26). */
  const canvasId = canvasIdOf(source);
  const target = useMemo(() => targetKeyOf(source), [source]);
  const segment = useMemo(
    () => ({ identity: source.identity }),
    [source.identity],
  );

  const [tool, setTool] = useState<PreviewTool>('select');
  const [viewport, setViewport] = useState<Viewport>(IDENTITY);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [hoverId, setHoverId] = useState<string | undefined>(undefined);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
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

  const { scene, onScene: setScene } = useScene();
  // Whether the revision's last scene had no node; `undefined` before one.
  const [sceneEmpty, setSceneEmpty] = useState<{
    readonly revision: number | undefined;
    readonly empty: boolean | undefined;
  }>({ revision: undefined, empty: undefined });
  const onScene = useCallback(
    (nodes: Parameters<typeof setScene>[0]) => {
      setScene(nodes);
      setSceneEmpty({
        revision: selectedRevision,
        empty: nodes === undefined ? undefined : nodes.length === 0,
      });
    },
    [setScene, selectedRevision],
  );
  // D26's "Nothing to draw": a complete revision whose errors leave it blank.
  const nothingDrawn =
    surface.complete &&
    surface.errors.some(({ code }) => code !== undefined) &&
    (surface.errors.some(
      ({ code }) => code === 'no-root' || code === 'parse-failed',
    ) ||
      (sceneEmpty.revision === selectedRevision && sceneEmpty.empty === true));
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
    touchController(canvasId);
  }, [canvasId]);

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
    itemKind: PROGRAM_COMMENT_KIND,
    revision: selectedRevision,
    threads,
    drafts,
    refs,
    reloadComments,
    showResolvedPins,
    container,
  });
  const inputOpen = flow.open !== undefined;

  /* The conversation asking to see a thread (`doric:comment-thread-open`) --- */

  // When the target is this canvas's (its kind and id, D19), the frame opens
  // the root's thread. Every revision shows every thread, so the window keeps
  // the revision on screen. Of the conversation's nodes only one answers: the
  // node of the revision the target names, or — a target without a revision
  // means the latest — the node of the newest revision.
  const threadOpen = useRef({
    target,
    ownRevision: selectedRevision,
    newestRevision: data.revisions.list.at(-1),
    showThread: flow.showThread,
  });
  threadOpen.current = {
    target,
    ownRevision: selectedRevision,
    newestRevision: data.revisions.list.at(-1),
    showThread: flow.showThread,
  };

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<CommentThreadOpenDetail>).detail;
      const {
        target: own,
        ownRevision,
        newestRevision,
        showThread,
      } = threadOpen.current;

      if (
        typeof detail?.commentId !== 'string' ||
        detail.target?.kind !== own.kind ||
        detail.target.id !== own.id
      )
        return;

      if (chrome === 'node') {
        const asked = detail.target.revision ?? newestRevision;

        if (asked === undefined || asked !== ownRevision) return;
      }

      showThread(detail.commentId);
    };

    document.addEventListener(COMMENT_THREAD_OPEN_EVENT, onOpen);

    return () =>
      document.removeEventListener(COMMENT_THREAD_OPEN_EVENT, onOpen);
  }, [chrome]);

  const contentKey = `${canvasId}@${String(selectedRevision ?? 1)}`;

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
    canvasId,
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
    program: true,
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
    () => ({ current, total, list }),
    [current, total, list],
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
          'papercraft-container relative overflow-hidden bg-card',
          // The node is a card (Figma `82:59323`): radius 10, `shadow-sm`, no
          // border. It is a square: as tall as the conversation is wide.
          // Every child is absolute, so the ratio is the container's own.
          chrome === 'node' && 'aspect-square w-full rounded-xl shadow-sm',
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
              canvasId={canvasId}
              revision={selectedRevision ?? 1}
              frameSrc={programFrameSrc()}
              adopt={chrome === 'node'}
              {...(surface.content === undefined
                ? {}
                : { program: surface.content })}
              {...(surface.onErrors === undefined
                ? {}
                : { onErrors: surface.onErrors })}
              area={area}
              capture={capture}
              hidden={hidden}
              measureRequest={measureRequest}
              onScene={onScene}
              onInput={onFrameInput}
              // The comment cursor (and the pan hand) stays over the
              // artifact's own elements, whatever cursor they declare.
              cursor={cursor}
              live={live}
              title={title}
              {...(snapshots === undefined ? {} : { snapshots })}
            />
          </div>

          {nothingDrawn ? (
            <div
              data-testid="papercraft-nothing-drawn"
              className="pointer-events-none absolute inset-0 flex items-center justify-center"
            >
              <div className="flex items-center gap-2 rounded-lg border border-border bg-background/80 px-3 py-2 text-xs text-muted-foreground">
                <CircleAlertIcon className="size-3.5 text-destructive" />
                Nothing to draw: this program has errors.
              </div>
            </div>
          ) : null}

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
              canvasId={canvasId}
              execute={execute}
              tool={tool}
              pinCount={commentCount}
              hasSelection={selectedId !== undefined}
              hasHidden={hidden.size > 0}
              zoom={zoomPercent(viewport)}
              revisions={revisions}
            />
          </>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
