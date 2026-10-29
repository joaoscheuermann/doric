// `preview-container.tsx` — the frame of one preview: the overlay header, the
// canvas that fills the frame and flows under it, the comment flow, pan/zoom,
// selection and layers (spec: "A UI no node e na janela").
//
// One surface, two moldings (`Uma superfície, duas molduras`). In the
// conversation (`chrome: 'node'`) the surface is the body of the `artifacts`
// registry's frame, and it draws its own header (the kind declares
// `header: 'body'`): the frame keeps only `Autorizar` below it. The node is
// a square — as tall as it is wide. The modal (`chrome: 'canvas'`) draws
// the same surface over the conversation, with the tree on the left and the
// command bar centred on the bottom edge.
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
// focused node. The modal is always focused.
//
// The preview itself renders in a sandboxed iframe (`preview-surface.tsx`,
// `live-frame.tsx`): the canvas reads what it rendered from the scene the
// frame reports, tells it which layers to hide, which cursor to show and
// whose input it is, and hears its pointer, wheel, keys and focus. In the
// conversation the node keeps a live frame only while it is one of the
// window's most recently used (`live-frames.ts`); otherwise the surface draws
// its snapshot (`snapshots.ts`), which the canvas takes with its own drawings
// concealed. The canvas modal's revision is always live.
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
import {
  CanvasFooter,
  CanvasHeader,
  CanvasModal,
  CommentOverlay,
  type CommentPin,
  canvasKeys,
  DETACHED_STEP,
  gridBackground,
  IDENTITY,
  openCountOf,
  pinsOf,
  useCanvasGestures,
  useCommentFlow,
  useCommentRequest,
  useFit,
  useThreadOpenRequests,
  type Viewport,
  viewportTransform,
  zoomPercent,
} from 'desktop/ui/canvas';
import { TooltipProvider } from 'desktop/ui/tooltip';
import { cn } from 'desktop/ui/utils';
import {
  type KeyboardEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  ArtifactsV1,
  COMMENT_THREAD_OPEN_EVENT,
  type CommentAnchor,
  callScopeOf,
  PapercraftSnapshotV1,
  type PreviewScope,
  type PreviewTool,
} from '../../contracts/index.js';
import { canvasOpen, touchController } from '../canvas-registry.js';
import { keyCommandOf } from '../commands.js';
import { papercraftCommentStore } from '../comment.js';
import { CommandToolbar } from './command-toolbar.js';
import {
  type FrameReading,
  useCommandDispatch,
  usePreviewController,
} from './controller.js';
import { useFrameFocus } from './frame-focus.js';
import { useLiveFrame } from './live-frames.js';
import { HoverOutline, SelectionOutline } from './overlays.js';
import { anchorResolver } from './pin-geometry.js';
import { ensureRevisionCached, usePreviewData } from './preview-data.js';
import {
  type FrameInput,
  PreviewSurface,
  type SurfaceMode,
} from './preview-surface.js';
import { useScene } from './scene.js';
import { targetBounds, targetById, visualBounds } from './scene-graph.js';
import { sceneHitTester } from './scene-hit.js';
import type { SurfaceSnapshots } from './snapshots.js';
import { anchorTextOf, anchorTitleOf } from './threads-view.js';
import { TreePanel } from './tree-panel.js';

/** Which frame the surface sits in. */
export type PreviewChrome = 'node' | 'canvas';

export interface PreviewContainerProps {
  readonly services: Services;
  readonly chrome: PreviewChrome;
  /** The Project and Thread of the preview: every host call's scope. */
  readonly scope: PreviewScope | undefined;
  readonly artifactId: string;
  /** The node shows the revision its block was created with; the modal opens at the one the node shows, else the newest. */
  readonly blockRevision?: number;
  /**
   * Bumped by each comment gesture of the registry's frame (the node is the
   * body inside it): every change toggles the comment tool.
   */
  readonly commentRequest?: number;
  /** An `Esc` reported by the preview's frame that nothing on the canvas took: the modal's close request. */
  readonly onFrameEscape?: () => void;
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

/** One frame of a preview: header, canvas, gesture, tree (modal), bar (modal). */
export function PreviewContainer({
  services,
  chrome,
  scope,
  artifactId,
  blockRevision,
  commentRequest,
  onFrameEscape,
}: PreviewContainerProps) {
  const {
    record,
    policy,
    preview,
    selectedRevision,
    selectRevision,
    reload,
    threads,
    drafts,
    reloadComments,
    canComment,
    approved,
  } = usePreviewData({
    services,
    chrome,
    scope,
    artifactId,
    ...(blockRevision === undefined ? {} : { blockRevision }),
  });

  const [tool, setTool] = useState<PreviewTool>('select');
  const [viewport, setViewport] = useState<Viewport>(IDENTITY);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [hoverId, setHoverId] = useState<string | undefined>(undefined);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>('markup');
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [showResolved, setShowResolved] = useState(true);
  /**
   * The node's modal: open, or closing until the focus is back on the node's
   * `expandir` (the node stays active so the button is there to take it).
   */
  const [modal, setModal] = useState<'closed' | 'open' | 'closing'>('closed');

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

  /**
   * Whether the frame shows its controls and tools: the modal always is, and
   * the node while its modal is open or handing the focus back.
   */
  const active = chrome === 'canvas' || focused || modal !== 'closed';
  if (modal === 'closing' && focused) setModal('closed');

  const recordTitle = record?.title;
  const recordPath = record?.path;
  /** The preview's title and source, for the stack's line to name. */
  const refs = useMemo(
    () => ({
      ...(recordTitle === undefined ? {} : { title: recordTitle }),
      ...(recordPath === undefined ? {} : { source: recordPath }),
    }),
    [recordTitle, recordPath],
  );
  const showResolvedPins = useCallback(() => setShowResolved(true), []);

  const store = useMemo(
    () => papercraftCommentStore(services, scope),
    [services, scope],
  );

  const flow = useCommentFlow<CommentAnchor>({
    store,
    threadId: scope?.threadId,
    artifactId,
    revision: selectedRevision,
    threads,
    drafts,
    refs,
    reloadComments,
    showResolvedPins,
    container,
  });
  const inputOpen = flow.open !== undefined;

  // The newest revision, asked of the registry: a node's own reading may
  // predate a later revision.
  const latestRevision = useCallback(async (): Promise<number | undefined> => {
    if (scope === undefined) return undefined;

    const latest = await services
      .use(ArtifactsV1, callScopeOf(scope))
      .read({ artifactId });

    return latest?.revision;
  }, [services, scope, artifactId]);

  useThreadOpenRequests({
    chrome,
    artifactId,
    ownRevision: blockRevision ?? selectedRevision,
    knownRevisions: record?.revisions,
    latestRevision,
    eventName: COMMENT_THREAD_OPEN_EVENT,
    // While the node's modal is open, the modal's canvas opens the thread.
    showThread: (id) => {
      if (chrome !== 'node' || !canvasOpen(artifactId)) flow.showThread(id);
    },
  });

  const contentKey = `${artifactId}@${String(selectedRevision ?? blockRevision ?? 1)}`;

  // The node holds a live frame only among the window's most recently used;
  // the canvas modal's revision stays live outside that count.
  const { live, use: markUsed } = useLiveFrame(
    chrome === 'node' ? contentKey : undefined,
    container,
  );
  // What the fit frames: the element, not the page around it — one
  // measurement per scene.
  const content = useMemo(
    () =>
      scene === undefined ? undefined : visualBounds(scene.graph, scene.bounds),
    [scene],
  );
  const { areaSize, area, fitContent } = useFit({
    wrapper,
    content,
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
  const { execute } = useCommandDispatch(services);

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

  const hits = useMemo(() => sceneHitTester(scene, hidden), [scene, hidden]);

  const { panning, framePointer, frameWheel } = useCanvasGestures({
    wrapper,
    chrome,
    focusedRef,
    hits,
    viewport,
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

          let taken = false;
          handle({
            ...message,
            preventDefault: () => {
              taken = true;
            },
          });
          // An `Esc` nothing on the canvas took is the modal's to close on.
          if (message.type === 'keydown' && message.key === 'Escape' && !taken)
            onFrameEscape?.();

          return;
        }
        case 'focus':
          onFrameFocus(message.focused);

          return;
      }
    },
    [
      consumeFramePointer,
      framePointer,
      frameWheel,
      onFrameFocus,
      markUsed,
      onFrameEscape,
    ],
  );

  // A snapshot is taken only while nothing moves the canvas or covers it,
  // with the canvas's drawings concealed for the capture (styles.css). The
  // canvas modal's frame never dies while it is open, so it takes none.
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

  /** The popover's title: the component the anchor names, else the source's. */
  const sourcePath = record?.path;
  const titleOf = useCallback(
    (anchor: CommentAnchor) => anchorTitleOf(anchor, sourcePath),
    [sourcePath],
  );

  /** What the comment control counts: the open threads and the draft pins. */
  const commentCount = openCountOf(threads, drafts);

  /** Whether a thread of the preview is resolved: the eye shows then. */
  const hasResolved = threads.some((candidate) => candidate.state === 'done');

  /* What the frame reads for its chrome ----------------------------------------- */

  // The header names the file (else the title) and the revision on screen.
  const title = record?.path ?? record?.title ?? artifactId;
  const revisionTotal = record?.revisions ?? 1;
  const recordRevision = record?.revision;

  const revisions = useMemo(
    () => ({
      current: selectedRevision ?? recordRevision ?? 1,
      total: revisionTotal,
      list: Array.from({ length: revisionTotal }, (_, index) => index + 1),
      approved,
    }),
    [selectedRevision, recordRevision, revisionTotal, approved],
  );

  const resolvedToggle = useMemo(
    () =>
      hasResolved
        ? { shown: showResolved, onToggle: toggleShowResolved }
        : undefined,
    [hasResolved, showResolved, toggleShowResolved],
  );

  /* The node's modal: its canvas expanded over the conversation ------------- */

  const expand = useCallback(() => setModal('open'), []);
  const collapse = useCallback(
    () => setModal((current) => (current === 'open' ? 'closing' : current)),
    [],
  );
  /** The bar's keys typed in the modal, as commands on this artifact. */
  const modalKeys = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const command = keyCommandOf(event);
      if (command === undefined) return;

      event.preventDefault();
      execute(command, { artifactId });
    },
    [execute, artifactId],
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
        <CanvasHeader
          host={chrome === 'node' ? 'node' : 'modal'}
          title={title}
          controls={active}
          {...(selectedRevision === undefined
            ? {}
            : { revision: selectedRevision })}
          canExpand={scopeThread !== undefined}
          onExpand={expand}
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
              markup={preview?.markup}
              entries={preview?.files.map((file) => file.path)}
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
            titleOf={titleOf}
            textOf={anchorTextOf}
            threaded={scopeThread !== undefined}
            showResolved={showResolved}
            onToggleShowResolved={toggleShowResolved}
            focusCanvas={focusCanvas}
          />
        </div>

        {/* The one-line notice of a module that did not load (decision 10). */}
        {surfaceMode === 'fallback' && preview !== undefined ? (
          <div
            data-testid="papercraft-notice"
            className="absolute inset-x-0 bottom-9 z-10 mx-auto w-fit rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
          >
            {FALLBACK_NOTICE}
          </div>
        ) : null}

        {chrome === 'node' && active ? (
          <CanvasFooter
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

      {chrome === 'node' ? (
        <CanvasModal
          open={modal === 'open'}
          title={title}
          onCloseRequest={collapse}
          onKeyDown={modalKeys}
        >
          <PreviewContainer
            services={services}
            scope={scope}
            artifactId={artifactId}
            chrome="canvas"
            {...(selectedRevision === undefined && blockRevision === undefined
              ? {}
              : { blockRevision: selectedRevision ?? blockRevision })}
            onFrameEscape={collapse}
          />
        </CanvasModal>
      ) : null}
    </TooltipProvider>
  );
}
