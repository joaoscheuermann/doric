// The diagram's canvas, in the node and in Revisar (spec "O node mostra a
// revisão", "O modal do diagrama", "Âncora"): the header,
// the drawing in the shared viewport, the pins re-anchored on the page on
// screen, the "célula alterada" outlines, the comment flow and the footer —
// wired as Papercraft's `preview-container.tsx` wires them, over
// `desktop/ui/canvas`.

import type { Services } from 'bundle/contracts';
import {
  type CanvasDraft,
  CanvasFooter,
  CanvasHeader,
  type CanvasKey,
  type CanvasThread,
  type CanvasTool,
  CommentOverlay,
  type ContentPoint,
  canvasKeys,
  draftRootsOf,
  IDENTITY,
  openCountOf,
  pinsOf,
  surfacePoint,
  useCanvasGestures,
  useCommentFlow,
  useCommentRequest,
  useFit,
  type Viewport,
  viewportTransform,
  ZOOM_STEP,
  zoomAt,
  zoomPercent,
} from 'desktop/ui/canvas';
import { TooltipProvider } from 'desktop/ui/tooltip';
import {
  type MutableRefObject,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  DIAGRAM_ENTRY,
  type DiagramAnchor,
  type DiagramScope,
} from '../contracts/index.js';
import {
  type DiagramView,
  diagramHitTester,
  parseDiagramSelector,
  placeAnchor,
} from './anchor.js';
import { drawioCommentStore } from './comment.js';
import type { DiagramData } from './diagram-data.js';
import type { DiagramBlockData } from './elements.js';

/**
 * The node's focus (a private copy of Papercraft's `useFrameFocus`, without
 * its frame reports): the node is focused while the focus is inside
 * `container`. Unfocused, the first press on the node only focuses its
 * canvas, and the click it makes is consumed. Disabled (the modal), it
 * listens to nothing and the canvas counts as always focused.
 */
const useNodeFocus = (
  container: RefObject<HTMLDivElement | null>,
  focusCanvas: () => void,
  enabled: boolean,
  onFocusChange: ((focused: boolean) => void) | undefined,
): { readonly focused: boolean; readonly focusedRef: RefObject<boolean> } => {
  const [focused, setFocused] = useState(!enabled);
  const focusedRef = useRef(!enabled);
  const onChange = useRef(onFocusChange);
  onChange.current = onFocusChange;

  useEffect(() => {
    const frame = container.current;

    if (!enabled || frame === null) return;

    let focusClick = false;

    const onFocusIn = () => {
      if (!focusedRef.current) onChange.current?.(true);
      focusedRef.current = true;
      setFocused(true);
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;

      if (next instanceof Node && frame.contains(next)) return;
      if (focusedRef.current) onChange.current?.(false);
      focusedRef.current = false;
      setFocused(false);
    };
    const focusFrame = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      focusCanvas();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (focusedRef.current) return;
      focusClick = true;
      focusFrame(event);
    };
    const onClick = (event: MouseEvent) => {
      if (!focusClick && focusedRef.current) return;
      focusClick = false;
      focusFrame(event);
    };

    frame.addEventListener('focusin', onFocusIn);
    frame.addEventListener('focusout', onFocusOut);
    frame.addEventListener('pointerdown', onPointerDown, { capture: true });
    frame.addEventListener('click', onClick, { capture: true });

    return () => {
      frame.removeEventListener('focusin', onFocusIn);
      frame.removeEventListener('focusout', onFocusOut);
      frame.removeEventListener('pointerdown', onPointerDown, {
        capture: true,
      });
      frame.removeEventListener('click', onClick, { capture: true });
    };
  }, [container, focusCanvas, enabled]);

  return { focused, focusedRef };
};

/** `text` as base64 of its UTF-8 bytes, for a `data:` URL. */
const base64Of = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';

  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }

  return btoa(binary);
};

/** What a failure says. */
const FAILURE_TEXT = {
  missing: 'O diagrama não pôde ser lido',
  unreadable: 'O diagrama não pôde ser lido',
  draw: 'O diagrama não pôde ser desenhado',
  unleased: 'O Project está sem sandbox ativo',
} as const;

/** What the modal's toolbar and keys drive on the canvas; rebuilt each render. */
export interface DiagramCanvasControls {
  readonly tool: CanvasTool;
  /** As `DiagramData.canComment`. */
  readonly canComment: boolean;
  /** Sets the tool. `comment` is ignored while `!canComment`; leaving `comment` closes the open input and clears the hover. */
  readonly setTool: (tool: CanvasTool) => void;
  /** The canvas's own keydown (`canvasKeys`: Space, Esc, C), for keys typed elsewhere in the modal. */
  readonly canvasKey: (event: CanvasKey) => void;
  /** The zoom as a whole percentage (`viewport.scale * 100`, rounded); `zoomPercent` formats the same value. */
  readonly zoom: number;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  /** Scale 1 at the origin (IDENTITY). */
  readonly zoomReset: () => void;
  /** `useFit`'s fit of the page on screen. */
  readonly zoomFit: () => void;
}

export interface DiagramCanvasProps {
  /** `node`: the conversation node; `modal`: Revisar inside `CanvasModal`. */
  readonly host: 'node' | 'modal';
  readonly services: Services;
  readonly scope: DiagramScope | undefined;
  /** The revision on screen: the node's block, or the modal's chosen revision. */
  readonly block: DiagramBlockData;
  /** `useDiagramData` for `block` (and, in the modal, its page). */
  readonly data: DiagramData;
  /** Node only: bumped by the frame's comment gesture. */
  readonly commentRequest?: number;
  /** Node only: Expandir. `held` keeps the node active (controls shown) while its modal is open or handing the focus back. */
  readonly expand?: {
    readonly canExpand: boolean;
    readonly held: boolean;
    readonly onExpand: () => void;
  };
  /** Node only: told each time the focus enters or leaves the node. */
  readonly onFocusChange?: (focused: boolean) => void;
  /** Modal only: set to the current controls on every render. */
  readonly controlsRef?: MutableRefObject<DiagramCanvasControls | undefined>;
  /** Modal only: the bar drawn at the bottom centre, in place of `CanvasFooter`. */
  readonly toolbar?: (controls: DiagramCanvasControls) => ReactNode;
}

const noop = (): void => undefined;

/**
 * One diagram revision's canvas (spec "O node mostra a revisão", "O modal do diagrama"):
 * - `CanvasHeader host={host}`: title, `rev N`, Comentar, Expandir (node),
 *   `Enviar ao agente (n)` (modal, while drafts; `flow.sendNow`);
 * - `drawio-page` `pág P/N` under the header while the model has more than
 *   one page and a drawing is shown (P: `data.view.pageId`'s 1-based place);
 * - with `data.entry`: the viewport holding
 *   `<img data-testid="drawio-diagram-image" src="data:image/svg+xml;base64,…"
 *   width height alt="">` at the layout's size, fitted by `useFit` with
 *   `content = { x: 0, y: 0, width, height }`; `CommentOverlay` with
 *   `pinsOf(threads, drafts, showResolved, anchor => placeAnchor(anchor,
 *   view)?.point)`; `ChangedCells`; `CanvasFooter`;
 * - without one: `drawio-diagram-placeholder` with the title, `rev N`,
 *   "N páginas · M células" once the model is read, and a loading indicator
 *   while no failure;
 * - `missing` / `unreadable`: `drawio-diagram-error` "O diagrama não pôde
 *   ser lido"; `draw`: "O diagrama não pôde ser desenhado" and
 *   `drawio-diagram-retry` `Tentar de novo`; `unleased`: the line "O Project
 *   está sem sandbox ativo", plus `Tentar de novo` when there is no entry;
 * - node: `useNodeFocus`, `chrome: 'node'`, `CanvasFooter` while active,
 *   the block's `changeNote` under the canvas; modal: always active,
 *   `chrome: 'canvas'` (an `Esc` that cancels nothing is not taken),
 *   `toolbar(controls)`.
 * Comments go through `drawioCommentStore(services, scope)` on
 * `block.revision`, with the refs `{ title: block.title, source:
 * DIAGRAM_ENTRY }` and the hit-test `diagramHitTester(view)`. Never throws
 * while rendering.
 */
export function DiagramCanvas({
  host,
  services,
  scope,
  block,
  data,
  commentRequest,
  expand,
  onFocusChange,
  controlsRef,
  toolbar,
}: DiagramCanvasProps): ReactElement {
  const {
    entry,
    model,
    view,
    failure,
    threads,
    drafts,
    reloadComments,
    canComment,
    retry,
  } = data;
  const node = host === 'node';
  const chrome = node ? 'node' : 'canvas';

  const [tool, setTool] = useState<CanvasTool>('select');
  const [viewport, setViewport] = useState<Viewport>(IDENTITY);
  const [hoverId, setHoverId] = useState<string | undefined>(undefined);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [showResolved, setShowResolved] = useState(true);

  const container = useRef<HTMLDivElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const toolRef = useRef(tool);
  toolRef.current = tool;

  const focusCanvas = useCallback(() => {
    wrapper.current?.focus?.({ preventScroll: true });
  }, []);
  const { focused, focusedRef } = useNodeFocus(
    container,
    focusCanvas,
    node,
    onFocusChange,
  );
  const active = node ? focused || (expand?.held ?? false) : true;

  const store = useMemo(
    () => drawioCommentStore(services, scope),
    [services, scope],
  );
  const refs = useMemo(
    () => ({ title: block.title, source: DIAGRAM_ENTRY }),
    [block.title],
  );
  const showResolvedPins = useCallback(() => setShowResolved(true), []);

  const flow = useCommentFlow<DiagramAnchor>({
    store,
    threadId: scope?.threadId,
    artifactId: block.artifactId,
    revision: block.revision,
    threads,
    drafts,
    refs,
    reloadComments,
    showResolvedPins,
    container,
  });
  const inputOpen = flow.open !== undefined;

  const width = entry?.layout.width;
  const height = entry?.layout.height;
  const content = useMemo(
    () =>
      width === undefined || height === undefined
        ? undefined
        : { x: 0, y: 0, width, height },
    [width, height],
  );
  const requestMeasure = useCallback(() => undefined, []);
  const { areaSize, fitContent } = useFit({
    wrapper,
    content,
    viewport,
    contentKey: `${block.artifactId}@${String(block.revision)}/${view?.pageId ?? ''}`,
    requestMeasure,
    setViewport,
  });

  const setCommentMode = useCallback(
    (on: boolean) => {
      if (!on) flow.closeInput();
      setHoverId(undefined);
      setTool(on ? 'comment' : 'select');
    },
    [flow.closeInput],
  );
  const toggleCommentMode = useCallback(
    () => setCommentMode(toolRef.current !== 'comment'),
    [setCommentMode],
  );
  const toggleShowResolved = useCallback(
    () => setShowResolved((shown) => !shown),
    [],
  );

  const hits = useMemo(
    () => (view === undefined ? undefined : diagramHitTester(view)),
    [view],
  );

  useCanvasGestures({
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
    onSelect: () => undefined,
    focusCanvas,
    resolveInput: flow.resolveInput,
    onComment: flow.beginNew,
  });

  const release = useCallback(() => {
    const focus =
      typeof document === 'undefined' ? null : document.activeElement;

    if (focus instanceof HTMLElement && container.current?.contains(focus)) {
      focus.blur();
    }
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

  useCommentRequest(commentRequest, {
    canComment,
    armed: () => toolRef.current === 'comment',
    toggle: () =>
      setTool((current) => (current === 'comment' ? 'select' : 'comment')),
    focusCanvas,
    closeInput: flow.closeInput,
  });

  const resolve = useCallback(
    (anchor: DiagramAnchor, fallback?: ContentPoint) =>
      (view === undefined ? undefined : placeAnchor(anchor, view)?.point) ??
      fallback,
    [view],
  );
  const pins = useMemo(
    () =>
      pinsOf(threads, drafts, showResolved, (anchor) =>
        view === undefined ? undefined : placeAnchor(anchor, view)?.point,
      ),
    [threads, drafts, showResolved, view],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const area = areaSize();

      setViewport((current) =>
        zoomAt(current, factor, { x: area.width / 2, y: area.height / 2 }),
      );
    },
    [areaSize],
  );
  const zoomIn = useCallback(() => zoomBy(ZOOM_STEP), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / ZOOM_STEP), [zoomBy]);
  const zoomReset = useCallback(() => setViewport(IDENTITY), []);
  const zoomFit = useCallback(() => {
    fitContent();
  }, [fitContent]);
  const send = useCallback(() => {
    void flow.sendNow();
  }, [flow.sendNow]);

  const controls: DiagramCanvasControls = {
    tool,
    canComment,
    setTool: (next) => {
      if (next === 'comment') {
        if (canComment) setCommentMode(true);
        return;
      }
      if (toolRef.current === 'comment') setCommentMode(false);
      setTool(next);
    },
    canvasKey: keys.onKeyDown,
    zoom: Math.round(viewport.scale * 100),
    zoomIn,
    zoomOut,
    zoomReset,
    zoomFit,
  };

  if (controlsRef !== undefined) controlsRef.current = controls;

  const hasResolved = threads.some((thread) => thread.state === 'done');
  const pageCount = model?.pages.length;
  const pageAt =
    model?.pages.findIndex((page) => page.id === view?.pageId) ?? -1;
  const pageLabel =
    pageCount !== undefined && pageCount > 1 && pageAt >= 0
      ? `pág ${String(pageAt + 1)}/${String(pageCount)}`
      : undefined;
  const cellCount = model?.cellCount;
  const src = useMemo(
    () =>
      entry === undefined
        ? undefined
        : `data:image/svg+xml;base64,${base64Of(entry.svg)}`,
    [entry],
  );

  return (
    <TooltipProvider>
      <div
        className={['flex w-full flex-col gap-1', node ? '' : 'h-full'].join(
          ' ',
        )}
      >
        <div
          ref={container}
          className={
            node
              ? [
                  'relative aspect-square w-full overflow-hidden rounded-lg border border-border bg-card',
                  focused ? 'outline-2 outline-primary' : '',
                ].join(' ')
              : 'relative h-full w-full overflow-hidden bg-card'
          }
          data-tool={tool}
          data-active={active ? 'true' : 'false'}
        >
          <CanvasHeader
            host={host}
            title={block.title}
            controls={active}
            revision={block.revision}
            canExpand={expand?.canExpand ?? false}
            onExpand={expand?.onExpand ?? noop}
            commentActive={tool === 'comment'}
            canComment={canComment}
            commentCount={openCountOf(threads, drafts)}
            onToggleComment={toggleCommentMode}
            {...(hasResolved
              ? {
                  resolvedToggle: {
                    shown: showResolved,
                    onToggle: toggleShowResolved,
                  },
                }
              : {})}
            draftCount={drafts.length}
            onSend={send}
          />

          {pageLabel === undefined ? null : (
            <span
              data-testid="drawio-page"
              className="pointer-events-none absolute top-9 left-2 z-30 font-mono text-[11px] text-muted-foreground"
            >
              {pageLabel}
            </span>
          )}

          <div
            ref={wrapper}
            role="application"
            aria-label="canvas do diagrama"
            tabIndex={-1}
            className="absolute inset-0 overflow-hidden outline-none"
            style={
              active && tool === 'comment' && !spaceHeld
                ? { cursor: 'crosshair' }
                : undefined
            }
            onKeyDown={keys.onKeyDown}
            onKeyUp={keys.onKeyUp}
          >
            {entry !== undefined && src !== undefined ? (
              <>
                <div
                  className="absolute inset-0"
                  style={{
                    transform: viewportTransform(viewport),
                    transformOrigin: '0 0',
                  }}
                >
                  <img
                    data-testid="drawio-diagram-image"
                    src={src}
                    width={entry.layout.width}
                    height={entry.layout.height}
                    alt=""
                    draggable={false}
                    className="pointer-events-auto block max-w-none select-none"
                  />
                </div>
                {view === undefined ? null : (
                  <ChangedCells
                    threads={threads}
                    drafts={drafts}
                    showResolved={showResolved}
                    view={view}
                    viewport={viewport}
                  />
                )}
                <CommentOverlay
                  flow={flow}
                  pins={pins}
                  resolve={resolve}
                  viewport={viewport}
                  area={areaSize()}
                  titleOf={diagramAnchorTitleOf}
                  textOf={diagramAnchorTextOf}
                  threaded={scope?.threadId !== undefined}
                  showResolved={showResolved}
                  onToggleShowResolved={toggleShowResolved}
                  focusCanvas={focusCanvas}
                />
              </>
            ) : (
              <div
                data-testid="drawio-diagram-placeholder"
                className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground text-xs"
              >
                <span className="font-medium text-foreground">
                  {block.title}
                </span>
                <span>{`rev ${String(block.revision)}`}</span>
                {pageCount === undefined || cellCount === undefined ? null : (
                  <span>{`${String(pageCount)} páginas · ${String(cellCount)} células`}</span>
                )}
                {failure === undefined ? (
                  <span role="status" aria-label="carregando">
                    …
                  </span>
                ) : null}
              </div>
            )}
          </div>

          {node ? (
            active && entry !== undefined ? (
              <CanvasFooter
                zoom={zoomPercent(viewport)}
                onZoomOut={zoomOut}
                onZoomReset={zoomReset}
                onZoomIn={zoomIn}
                onCenter={zoomFit}
              />
            ) : null
          ) : (
            toolbar?.(controls)
          )}
        </div>

        {failure === undefined ? null : (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <span
              {...(failure === 'unleased'
                ? {}
                : { 'data-testid': 'drawio-diagram-error' })}
            >
              {FAILURE_TEXT[failure]}
            </span>
            {failure === 'draw' ||
            (failure === 'unleased' && entry === undefined) ? (
              <button
                type="button"
                data-testid="drawio-diagram-retry"
                className="underline"
                onClick={retry}
              >
                Tentar de novo
              </button>
            ) : null}
          </div>
        )}

        {!node || block.changeNote === undefined ? null : (
          <p className="text-muted-foreground text-xs">{block.changeNote}</p>
        )}
      </div>
    </TooltipProvider>
  );
}

/** What `ChangedCells` reads: the same pins `pinsOf` draws, and the page on screen. */
export interface ChangedCellsProps {
  readonly threads: readonly CanvasThread<DiagramAnchor>[];
  readonly drafts: readonly CanvasDraft<DiagramAnchor>[];
  /** Whether resolved threads show, as for their pins. */
  readonly showResolved: boolean;
  readonly view: DiagramView;
  readonly viewport: Viewport;
}

/**
 * The "célula alterada" mark (Q2, confirmed: drawio's own outline; kept in
 * this one component so the platform alternative — `changed?` on
 * `CommentPin` — could replace it): for each cell that `placeAnchor` places a
 * shown pin on with `changed: true` (the threads `pinsOf` shows, and the
 * draft roots), one dashed outline over the cell's layout box, following the
 * viewport, with `data-testid="drawio-cell-changed"`, `data-cell-id` and the
 * title "A célula mudou desde o comentário". One outline per cell however
 * many pins sit on it. The outline takes no pointer events: a click on it
 * reaches the canvas. Renders nothing when no pin is changed.
 */
export function ChangedCells({
  threads,
  drafts,
  showResolved,
  view,
  viewport,
}: ChangedCellsProps): ReactElement | null {
  const anchors = [
    ...threads.flatMap((thread) =>
      (thread.state === 'done' && !showResolved) ||
      thread.root.anchor === undefined
        ? []
        : [thread.root.anchor],
    ),
    ...draftRootsOf(threads, drafts).map((draft) => draft.target.anchor),
  ];
  const changed = new Set(
    anchors.flatMap((anchor) => {
      const placement = placeAnchor(anchor, view);

      return placement?.changed === true && placement.cellId !== undefined
        ? [placement.cellId]
        : [];
    }),
  );
  const boxes = view.layout.cells.filter((cell) => changed.has(cell.id));

  if (boxes.length === 0) return null;

  return (
    <>
      {boxes.map((box) => {
        const at = surfacePoint(box, viewport);

        return (
          <div
            key={box.id}
            data-testid="drawio-cell-changed"
            data-cell-id={box.id}
            title={CELL_CHANGED_TITLE}
            className="pointer-events-none absolute z-10"
            style={{
              left: `${String(at.x)}px`,
              top: `${String(at.y)}px`,
              width: `${String(box.width * viewport.scale)}px`,
              height: `${String(box.height * viewport.scale)}px`,
              border: '1px dashed #00a8ff',
            }}
          />
        );
      })}
    </>
  );
}

/** The title of a changed cell's outline. */
export const CELL_CHANGED_TITLE = 'A célula mudou desde o comentário' as const;

/**
 * Where an anchor points, short, for the thread popover's title
 * (`CommentOverlay.titleOf`): the cell's label, else its cell id; a free
 * point is `label (x, y)` rounded, or `(x, y)` without a label. Pure.
 */
export const diagramAnchorTitleOf: (anchor: DiagramAnchor) => string = (
  anchor,
) => {
  if ('cellKind' in anchor) {
    const parsed = parseDiagramSelector(anchor.selector);
    const cellId =
      parsed !== undefined && 'cellId' in parsed ? parsed.cellId : '';

    return anchor.label === '' ? cellId : anchor.label;
  }

  const point = `(${String(Math.round(anchor.x))}, ${String(Math.round(anchor.y))})`;

  return anchor.label === '' ? point : `${anchor.label} ${point}`;
};

/**
 * The whole anchor for the title's tooltip and the copy
 * (`CommentOverlay.textOf`): `selector · label · rev N`, leaving out an empty
 * label and an undefined revision. Pure.
 */
export const diagramAnchorTextOf: (
  anchor: DiagramAnchor,
  revision: number | undefined,
) => string = (anchor, revision) =>
  [
    anchor.selector,
    ...(anchor.label === '' ? [] : [anchor.label]),
    ...(revision === undefined ? [] : [`rev ${String(revision)}`]),
  ].join(' · ');
