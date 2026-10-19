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

import type { PreviewScope, PreviewTool } from '../../contracts/index.js';
import { touchController } from '../canvas-registry.js';
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
import { NodeFooter } from './node-footer.js';
import { HoverOutline, SelectionOutline } from './overlays.js';
import { anchorResolver } from './pin-geometry.js';
import type { CommentPin } from './pins-layer.js';
import { ensureRevisionCached, usePreviewData } from './preview-data.js';
import { PreviewHeader } from './preview-header.js';
import { PreviewSurface, type SurfaceMode } from './preview-surface.js';
import { useHiddenLayers, useScene } from './scene.js';
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

/** One frame of a preview: header, canvas, gesture, tree (window), bar (window). */
export function PreviewContainer({
  services,
  chrome,
  scope,
  artifactId,
  blockRevision,
  commentRequest,
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

  const container = useRef<HTMLDivElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  const latest = useRef<Latest>({
    viewport: IDENTITY,
    tool: 'select',
    selectedId: undefined,
    revision: undefined,
    scene: undefined,
  });
  const scale = useCallback(() => latest.current.viewport.scale, []);

  /* The scene graph, derived from what the revision rendered ---------------- */

  const { scene, onContent, remeasure } = useScene(scale);

  latest.current = {
    viewport,
    tool,
    selectedId,
    revision: selectedRevision,
    scene,
  };

  useHiddenLayers(scene, hidden);

  /* The focus, the comment flow, the fit and the controller ------------------ */

  const focusCanvas = useCallback(() => {
    wrapper.current?.focus?.({ preventScroll: true });
    touchController(artifactId);
  }, [artifactId]);

  const { focused, focusedRef } = useFrameFocus({
    container,
    chrome,
    focusCanvas,
  });

  /** Whether the frame shows its controls and tools: the window always is. */
  const active = chrome === 'canvas' || focused;

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

  const flow = useCommentFlow({
    services,
    scope,
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

  useThreadOpenRequests({
    chrome,
    artifactId,
    ownRevision: blockRevision ?? selectedRevision,
    knownRevisions: record?.revisions,
    services,
    scope,
    showThread: flow.showThread,
  });

  const contentKey = `${artifactId}@${String(selectedRevision ?? blockRevision ?? 1)}`;
  const { areaSize, fitContent } = useFit({
    wrapper,
    scene,
    viewport,
    contentKey,
    remeasure,
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
    artifactId,
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

  const { panning } = useCanvasGestures({
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
  });

  const keys = canvasKeys({
    chrome,
    tool,
    inputOpen,
    canComment,
    wrapper,
    setSpaceHeld,
    setCommentMode,
    closeInput: flow.closeInput,
  });

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
    () => anchorResolver(scene?.graph, scene?.bounds),
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

  const selectedNode =
    selectedId === undefined ? undefined : scene?.graph.byId.get(selectedId);
  const hoverNode =
    hoverId === undefined ? undefined : scene?.graph.byId.get(hoverId);

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
              markup={preview?.markup}
              entries={preview?.files.map((file) => file.path)}
              // Path B: the revision's entries reach the desktop's verified
              // cache before the surface imports its module.
              ensure={(id, revision) =>
                ensureRevisionCached(services, scope, id, revision)
              }
              onContent={onContent}
              onMode={setSurfaceMode}
              // The comment balloon (and the pan hand) stays over the
              // artifact's own elements, whatever cursor they declare.
              lockCursor={
                active && (tool === 'comment' || tool === 'pan' || spaceHeld)
              }
            />
          </div>

          {hoverNode !== undefined ? (
            <HoverOutline
              node={hoverNode}
              bounds={scene?.bounds}
              viewport={viewport}
              withLabel={!inputOpen}
            />
          ) : null}

          {active && selectedNode !== undefined ? (
            <SelectionOutline
              node={selectedNode}
              bounds={scene?.bounds}
              viewport={viewport}
            />
          ) : null}

          <CommentOverlay
            flow={flow}
            pins={pins}
            resolve={resolve}
            viewport={viewport}
            area={areaSize()}
            sourcePath={record?.path}
            threaded={scopeThread !== undefined}
            showResolved={showResolved}
            onToggleShowResolved={toggleShowResolved}
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
              selectedId={selectedId}
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
