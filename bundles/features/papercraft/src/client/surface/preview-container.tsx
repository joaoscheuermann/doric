// `preview-container.tsx` — the frame of one preview: the overlay header, the
// canvas that scrolls behind it, the comment gesture, pan/zoom, selection and
// layers (spec: "A UI no node e na janela").
//
// One surface, two mouldes (`Uma superfície, duas molduras`): the node frame
// (`chrome: 'node'`) draws the file name, the `[ abrir ]` button and the one
// comment button in the corner, with a fixed, draggable height; the window
// frame (`chrome: 'canvas'`) draws the same surface full-screen with the tree
// on the left and the command bar centred on the bottom edge, and no footer.
// The node has no approve button: under the `request` policy the conversation
// carries the request as a reading; the button lives in the window's bar only.
//
// What is view state here — the armed tool, pan/zoom, selection, isolation,
// hidden layers, pins — is local to the frame; what is durable stays in the
// events (comments, on flush; the approval, under `request`).

import { type Commands, CommandsV1, type Services } from 'bundle/contracts';
import { Badge } from 'desktop/ui/badge';
import { Button } from 'desktop/ui/button';
import { TooltipProvider } from 'desktop/ui/tooltip';
import { cn } from 'desktop/ui/utils';
import { ExternalLinkIcon, MessageSquarePlusIcon } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  type ArtifactRecord,
  ArtifactsV1,
  OPEN_CANVAS_COMMAND,
  PAPERCRAFT_COMMENT_KIND,
  PapercraftPreviewsV1,
  type PreviewState,
  type PreviewTool,
} from '../../contracts/index.js';
import { anchorOf, pointAnchorOf } from '../anchor.js';
import {
  type PreviewController,
  registerController,
} from '../canvas-registry.js';
import type { ComposerItem } from '../chat-contract.js';
import {
  beginComment,
  commentStackItemId,
  composer,
  type PendingComment,
  type PendingCommentData,
  threadIdOfLocation,
} from '../comment.js';
import { CommandToolbar } from './command-toolbar.js';
import { type CommentPin, PinsLayer } from './pins-layer.js';
import { PreviewSurface, type SurfaceMode } from './preview-surface.js';
import {
  type BoundsOf,
  boundsIndex,
  buildSceneGraph,
  contentBounds,
  hitTest,
  isolateHiddenIds,
  nearestNode,
  type SceneGraph,
  type SceneNode,
} from './scene-graph.js';
import { TreePanel } from './tree-panel.js';
import {
  fitViewport,
  IDENTITY,
  toContent,
  type Viewport,
  viewportTransform,
  ZOOM_STEP,
  zoomAt,
  zoomPercent,
} from './viewport.js';

/** Which frame the surface sits in. */
export type PreviewChrome = 'node' | 'canvas';

export interface PreviewContainerProps {
  readonly services: Services;
  readonly chrome: PreviewChrome;
  readonly artifactId: string;
  /** The node shows the revision its block was created with; the window opens at the newest. */
  readonly blockRevision?: number;
  /** The block's title, when chat's projector handed one to the node. */
  readonly blockTitle?: string;
}

const REQUEST_NOTICE = 'aguardando autorização';
const APPROVED_NOTICE = 'Autorizado';
const FALLBACK_NOTICE = 'o preview não carregou · mostrando o markup';

const DEFAULT_NODE_HEIGHT = 280;
const MIN_NODE_HEIGHT = 120;
const MAX_NODE_HEIGHT = 800;

const EMPTY_BOUNDS = { x: 0, y: 0, width: 0, height: 0 } as const;

/** One frame of a preview: header, canvas, gesture, tree (window), bar (window). */
export function PreviewContainer({
  services,
  chrome,
  artifactId,
  blockRevision,
  blockTitle,
}: PreviewContainerProps) {
  const [record, setRecord] = useState<ArtifactRecord | undefined>(undefined);
  const [policy, setPolicy] = useState<'proceed' | 'request'>('proceed');
  const [preview, setPreview] = useState<PreviewState | undefined>(undefined);
  const [selectedRevision, setSelectedRevision] = useState<number | undefined>(
    blockRevision,
  );
  const [reloadTick, setReloadTick] = useState(0);

  const [tool, setTool] = useState<PreviewTool>('select');
  const [viewport, setViewport] = useState<Viewport>(IDENTITY);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [hoverId, setHoverId] = useState<string | undefined>(undefined);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [pins, setPins] = useState<readonly CommentPin[]>([]);
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>('module');
  const [graphTick, setGraphTick] = useState(0);
  const [nodeHeight, setNodeHeight] = useState(DEFAULT_NODE_HEIGHT);
  const [draft, setDraft] = useState<PendingComment | undefined>(undefined);
  const [spaceHeld, setSpaceHeld] = useState(false);

  const wrapper = useRef<HTMLDivElement>(null);
  const noteFormRef = useRef<HTMLFormElement>(null);
  const viewportRef = useRef(viewport);
  const revisionRef = useRef(selectedRevision);
  const selectedRef = useRef(selectedId);
  const graphRef = useRef<SceneGraph | undefined>(undefined);
  const boundsRef = useRef<BoundsOf | undefined>(undefined);
  const heightDrag = useRef<
    { readonly y: number; readonly height: number } | undefined
  >(undefined);
  const panDrag = useRef<
    | {
        readonly x: number;
        readonly y: number;
        readonly tx: number;
        readonly ty: number;
      }
    | undefined
  >(undefined);

  viewportRef.current = viewport;
  revisionRef.current = selectedRevision;
  selectedRef.current = selectedId;

  /* Reading the durable state ---------------------------------------------- */

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const next = await services
        .use(ArtifactsV1)
        .read(
          chrome === 'node' && blockRevision !== undefined
            ? { artifactId, revision: blockRevision }
            : { artifactId },
        );

      if (cancelled) return;
      setRecord(next);

      // The node stays at its block's revision; the window opens at the newest.
      if (chrome === 'node' && blockRevision !== undefined) return;
      setSelectedRevision(next?.revision);
    })();

    void services
      .use(ArtifactsV1)
      .policy()
      .then((answer) => {
        if (!cancelled) setPolicy(answer.policy);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [services, artifactId, blockRevision, chrome, reloadTick]);

  useEffect(() => {
    const revision = selectedRevision;

    if (revision === undefined) return;
    let cancelled = false;

    void services
      .use(PapercraftPreviewsV1)
      .read({ artifactId, revision })
      .then((state) => {
        if (!cancelled) setPreview(state);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [services, artifactId, selectedRevision, reloadTick]);

  /* The scene graph, derived from what the revision rendered ---------------- */

  const onContent = useCallback((root: ShadowRoot | undefined) => {
    if (root === undefined) {
      graphRef.current = undefined;
      boundsRef.current = undefined;

      return;
    }

    const content = root.querySelector(
      '.papercraft-content',
    ) as HTMLElement | null;
    const base: ParentNode = content ?? root;
    const graph = buildSceneGraph(base);

    graphRef.current = graph;
    boundsRef.current = boundsIndex((node) => {
      const rect = node.element.getBoundingClientRect();
      const origin = content?.getBoundingClientRect() ?? { x: 0, y: 0 };
      const scale = viewportRef.current.scale;

      return {
        x: (rect.x - origin.x) / scale,
        y: (rect.y - origin.y) / scale,
        width: rect.width / scale,
        height: rect.height / scale,
      };
    });
    setGraphTick((tick) => tick + 1);
  }, []);

  const onMode = useCallback((mode: SurfaceMode) => {
    setSurfaceMode(mode);
  }, []);

  // A hidden layer is view state, applied to the artifact's DOM: hidden nodes
  // never answer a pointer.
  useEffect(() => {
    for (const node of graphRef.current?.nodes ?? []) {
      (node.element as HTMLElement).style.visibility = hidden.has(node.id)
        ? 'hidden'
        : '';
    }
  }, [hidden, preview, graphTick, selectedRevision]);

  /* The composer stack: the pins of this revision ---------------------------- */

  useEffect(() => {
    const api = composer();
    const threadId = threadIdOfLocation();

    if (api === undefined || threadId === undefined) return;

    let items: readonly ComposerItem[] = [];

    const publish = (): void => {
      const mine: CommentPin[] = [];

      for (const item of items) {
        if (item.kind !== PAPERCRAFT_COMMENT_KIND) continue;

        const data = item.data as PendingCommentData | undefined;

        if (
          data?.artifactId !== artifactId ||
          data.revision !== selectedRevision
        ) {
          continue;
        }

        mine.push({
          pin: data.pin,
          point: data.point,
          note: item.note,
        });
      }

      setPins(mine);
    };

    // The portrait first, then the deltas — the shape of
    // `runtime.threads/v1.watchThread`.
    const subscription = api.watch(threadId, (watch) => {
      switch (watch.kind) {
        case 'snapshot':
          items = watch.items;
          break;
        case 'added':
          items = [...items, watch.item];
          break;
        case 'updated':
          items = items.map((candidate) =>
            candidate.id === watch.item.id ? watch.item : candidate,
          );
          break;
        case 'removed':
          items = items.filter((candidate) => candidate.id !== watch.id);
          break;
        case 'text':
          return;
      }

      publish();
    });

    return () => subscription.dispose();
  }, [artifactId, selectedRevision]);

  /* Pointer questions --------------------------------------------------------- */

  const contentPointOf = (event: {
    readonly clientX: number;
    readonly clientY: number;
  }) => {
    const rect = wrapper.current?.getBoundingClientRect();

    // Surface pixels, then the inverse of the viewport's transform: the
    // content point the pointer is over, under any pan/zoom.
    return toContent(viewportRef.current, {
      x: event.clientX - (rect?.x ?? 0),
      y: event.clientY - (rect?.y ?? 0),
    });
  };

  const nodeOfEvent = (event: Event): SceneNode | undefined => {
    const graph = graphRef.current;

    if (graph === undefined) return undefined;

    const path =
      typeof event.composedPath === 'function' ? event.composedPath() : [];

    for (const part of path) {
      if (part === wrapper.current) break;
      if (part instanceof Element) {
        const found = graph.nodes.find((node) => node.element === part);

        if (found !== undefined) return found;
      }
    }

    // The pointer missed everything in the path: the derived tree answers —
    // the hit-test under the transform, else the nearest node.
    const bounds = boundsRef.current;

    if (bounds === undefined) return undefined;

    const pointer = event as unknown as { clientX?: number; clientY?: number };

    if (
      typeof pointer.clientX !== 'number' ||
      typeof pointer.clientY !== 'number'
    )
      return undefined;

    const point = contentPointOf({
      clientX: pointer.clientX,
      clientY: pointer.clientY,
    });

    return (
      hitTest(graph, point, bounds, hidden) ??
      nearestNode(graph, point, bounds, hidden)
    );
  };

  /* The comment gesture: the click falls into the composer stack ------------- */

  const gestureClick = (event: MouseEvent) => {
    if (tool === 'pan') return;

    const node = nodeOfEvent(event);

    if (tool === 'select') {
      setSelectedId(node?.id);

      return;
    }

    const revision = revisionRef.current;

    if (revision === undefined) return;

    const bounds = boundsRef.current;
    const point = contentPointOf(event);
    const anchor =
      node === undefined
        ? pointAnchorOf(point, nearestNodeOf(point))
        : anchorOf(node.element);

    const box = node === undefined ? undefined : bounds?.(node);
    const pinPoint = box === undefined ? point : { x: box.x, y: box.y };
    const pin = pins.length + 1;

    const pending: PendingComment = {
      id: commentStackItemId(artifactId, revision, pin),
      data: { artifactId, revision, anchor, pin, point: pinPoint },
      note: '',
    };

    if (composer() !== undefined && threadIdOfLocation() !== undefined) {
      // The stack is the only place a draft is written; the note is written
      // there too, above the prompt. Nothing is durable yet.
      void beginComment(services, pending, originOf())
        .then(() => {
          setPins((current) => [
            ...current.filter((candidate) => candidate.pin !== pin),
            { pin, point: pinPoint, note: '' },
          ]);
        })
        .catch(() => undefined);

      return;
    }

    // No stack to join: the gesture keeps the fallback note form, and the
    // submit records through `comments/v1` directly.
    setDraft(pending);
  };

  const nearestNodeOf = (point: {
    readonly x: number;
    readonly y: number;
  }): Element | undefined => {
    const graph = graphRef.current;
    const bounds = boundsRef.current;

    if (graph === undefined || bounds === undefined) return undefined;

    return nearestNode(graph, point, bounds, hidden)?.element;
  };

  /** The canvas the reader clicked: the origin the comment intent bubbles from. */
  const originOf = (): EventTarget => wrapper.current ?? globalThis;

  const submitDraft = (event: Event) => {
    event.preventDefault();

    const form = event.target as HTMLFormElement;
    const input = form.querySelector<HTMLInputElement>(
      '.papercraft-note-input',
    );
    const text = input?.value.trim() ?? '';
    const pending = draft;

    if (pending === undefined || text === '') return;

    void beginComment(services, { ...pending, note: text }, originOf())
      .then(() => {
        setPins((current) => [
          ...current.filter((candidate) => candidate.pin !== pending.data.pin),
          { pin: pending.data.pin, point: pending.data.point, note: text },
        ]);
      })
      .catch(() => undefined);

    setDraft(undefined);
  };

  // The fallback's note form submits natively: the canvas sits under a shadow
  // root of its own, and a delegated submit that React carries through its own
  // tree is one more thing a foreign shadow root can break.
  useEffect(() => {
    const form = noteFormRef.current;

    if (form === null || form === undefined) return;

    form.addEventListener('submit', submitDraft);

    return () => form.removeEventListener('submit', submitDraft);
  }, [draft]);

  /* Pan with the space bar, zoom with the wheel -------------------------------- */

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === ' ') {
      event.preventDefault();
      setSpaceHeld(true);
    }
  };

  const onKeyUp = (event: ReactKeyboardEvent) => {
    if (event.key === ' ') setSpaceHeld(false);
  };

  const handlersRef = useRef<{
    onClick: (event: MouseEvent) => void;
    onPointerMove: (event: PointerEvent) => void;
    onPointerDown: (event: PointerEvent) => void;
    onPointerUp: () => void;
  }>({
    onClick: () => undefined,
    onPointerMove: () => undefined,
    onPointerDown: () => undefined,
    onPointerUp: () => undefined,
  });

  const onHoverMove = (event: PointerEvent) => {
    if (tool !== 'comment') return;

    const id = nodeOfEvent(event)?.id;

    if (id !== hoverId) setHoverId(id);
  };

  const onPanPointerDown = (event: PointerEvent) => {
    if (!spaceHeld && tool !== 'pan') return;

    panDrag.current = {
      x: event.clientX,
      y: event.clientY,
      tx: viewportRef.current.tx,
      ty: viewportRef.current.ty,
    };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };

  const onPanPointerMove = (event: PointerEvent) => {
    const drag = panDrag.current;

    if (drag === undefined) return;

    setViewport((current) => ({
      ...current,
      tx: drag.tx + (event.clientX - drag.x),
      ty: drag.ty + (event.clientY - drag.y),
    }));
  };

  const onPanPointerUp = () => {
    panDrag.current = undefined;
  };

  // The pointer questions are native listeners on the canvas: a click born
  // inside the preview's shadow root crosses the shadow boundary, and the
  // delegation React does for its own tree does not reach it. A native
  // listener does — and the resolution itself is `composedPath`, not a
  // position. The wheel is the same: a zoom the canvas owns must not scroll
  // the document under it.
  useEffect(() => {
    const area = wrapper.current;

    if (area === null || area === undefined) return;

    const onClick = (event: MouseEvent) => handlersRef.current.onClick(event);
    const onPointerMove = (event: PointerEvent) =>
      handlersRef.current.onPointerMove(event);
    const onPointerDown = (event: PointerEvent) =>
      handlersRef.current.onPointerDown(event);
    const onPointerUp = () => handlersRef.current.onPointerUp();
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();

      if (event.ctrlKey || event.metaKey) {
        const rect = area.getBoundingClientRect();

        setViewport((current) =>
          zoomAt(current, event.deltaY < 0 ? 1.1 : 1 / 1.1, {
            x: event.clientX - rect.x,
            y: event.clientY - rect.y,
          }),
        );

        return;
      }

      setViewport((current) => ({
        ...current,
        tx: current.tx - event.deltaX,
        ty: current.ty - event.deltaY,
      }));
    };

    area.addEventListener('click', onClick);
    area.addEventListener('pointermove', onPointerMove);
    area.addEventListener('pointerdown', onPointerDown);
    area.addEventListener('pointerup', onPointerUp);
    area.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      area.removeEventListener('click', onClick);
      area.removeEventListener('pointermove', onPointerMove);
      area.removeEventListener('pointerdown', onPointerDown);
      area.removeEventListener('pointerup', onPointerUp);
      area.removeEventListener('wheel', onWheel);
    };
  }, []);

  handlersRef.current = {
    onClick: gestureClick,
    onPointerMove: (event) => {
      onHoverMove(event);
      onPanPointerMove(event);
    },
    onPointerDown: onPanPointerDown,
    onPointerUp: onPanPointerUp,
  };

  /* The window's controller, and the [ abrir ] of the node --------------------- */

  const areaSize = useCallback(() => {
    const area = wrapper.current;

    return {
      width: area?.clientWidth ?? 0,
      height: area?.clientHeight ?? 0,
    };
  }, []);

  const controller = useMemo<PreviewController>(
    () => ({
      artifactId,
      setTool: (next) => setTool(next),
      isolate: () => {
        const graph = graphRef.current;
        const selected = selectedRef.current;

        if (graph === undefined || selected === undefined) return;

        setHidden(isolateHiddenIds(graph, selected));
      },
      showAll: () => setHidden(new Set()),
      zoomOut: () => {
        const area = areaSize();

        setViewport((current) =>
          zoomAt(
            current,
            1 / ZOOM_STEP,
            area.width > 0
              ? { x: area.width / 2, y: area.height / 2 }
              : { x: 0, y: 0 },
          ),
        );
      },
      zoomReset: () => setViewport(IDENTITY),
      zoomIn: () => {
        const area = areaSize();

        setViewport((current) =>
          zoomAt(
            current,
            ZOOM_STEP,
            area.width > 0
              ? { x: area.width / 2, y: area.height / 2 }
              : { x: 0, y: 0 },
          ),
        );
      },
      zoomFit: () => {
        const graph = graphRef.current;
        const bounds = boundsRef.current;

        if (graph === undefined || bounds === undefined) return;

        const content = contentBounds(graph, bounds);
        const area = areaSize();

        if (content === undefined || area.width <= 0) return;

        setViewport(fitViewport(content, area));
      },
      selectRevision: (revision) => {
        setSelectedId(undefined);
        setHidden(new Set());
        setSelectedRevision(revision);
      },
      currentRevision: () => revisionRef.current ?? undefined,
      reload: () => setReloadTick((tick) => tick + 1),
    }),
    [artifactId, areaSize],
  );

  useEffect(() => {
    if (chrome !== 'canvas') return;

    return registerController(controller);
  }, [chrome, controller]);

  const execute = useCallback(
    (command: Parameters<Commands['execute']>[0], input?: unknown) => {
      void services
        .use(CommandsV1)
        .execute(command, input)
        .catch(() => undefined);
    },
    [services],
  );

  const open = () => {
    execute(OPEN_CANVAS_COMMAND, { artifactId });
  };

  /* The resizable height of the node ------------------------------------------- */

  const onHeightPointerDown = (event: ReactPointerEvent) => {
    heightDrag.current = { y: event.clientY, height: nodeHeight };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };

  const onHeightPointerMove = (event: ReactPointerEvent) => {
    const drag = heightDrag.current;

    if (drag === undefined) return;

    const next = drag.height + (event.clientY - drag.y);

    setNodeHeight(Math.min(MAX_NODE_HEIGHT, Math.max(MIN_NODE_HEIGHT, next)));
  };

  const onHeightPointerUp = () => {
    heightDrag.current = undefined;
  };

  /* What the frame reads for its chrome ----------------------------------------- */

  const title =
    chrome === 'node'
      ? (record?.path ?? blockTitle ?? artifactId)
      : (record?.path ?? record?.title ?? artifactId);

  const revisionTotal = record?.revisions ?? 1;
  const approved =
    selectedRevision !== undefined &&
    record !== undefined &&
    record.state === 'approved' &&
    selectedRevision === record.revision;

  const requestNotice =
    policy === 'request'
      ? approved
        ? APPROVED_NOTICE
        : REQUEST_NOTICE
      : undefined;

  const selectedNode =
    selectedId === undefined
      ? undefined
      : graphRef.current?.byId.get(selectedId);

  const hoverNode =
    hoverId === undefined ? undefined : graphRef.current?.byId.get(hoverId);

  const outlineOf = (node: SceneNode | undefined) => {
    if (node === undefined || boundsRef.current === undefined)
      return EMPTY_BOUNDS;

    const box = boundsRef.current(node);

    return {
      left: `${String(box.x * viewport.scale + viewport.tx)}px`,
      top: `${String(box.y * viewport.scale + viewport.ty)}px`,
      width: `${String(box.width * viewport.scale)}px`,
      height: `${String(box.height * viewport.scale)}px`,
    };
  };

  return (
    <TooltipProvider>
      <div
        className={cn(
          'papercraft-container relative overflow-hidden rounded-lg border border-border bg-card',
          chrome === 'node' && 'w-full',
          chrome === 'canvas' && 'h-full w-full rounded-none border-0',
        )}
        data-chrome={chrome}
        data-tool={tool}
      >
        <div className="papercraft-header absolute inset-x-0 top-0 z-10 flex h-8 items-center gap-2 border-b border-border/60 bg-background/80 px-2 backdrop-blur">
          <span
            className={cn(
              'truncate font-medium',
              chrome === 'canvas' && 'ml-(--doric-safe-left)',
            )}
          >
            {title}
          </span>
          {requestNotice === undefined ? null : (
            <span
              className="papercraft-request shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              data-testid="papercraft-request"
            >
              {requestNotice}
            </span>
          )}
          {chrome === 'node' ? (
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <span
                className="papercraft-revision font-mono text-[10px] text-muted-foreground tabular-nums"
                data-testid="papercraft-revision"
              >
                rev {String(selectedRevision ?? '–')}/{String(revisionTotal)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label="abrir"
                data-testid="papercraft-open"
                onClick={open}
              >
                <ExternalLinkIcon aria-hidden="true" />
                abrir
              </Button>
            </span>
          ) : null}
        </div>

        {/* The canvas: the transform the content and the pins ride. Its role
            is an interactive graphical region — the canvas owns the space
            bar while the pointer is over it. */}
        <div
          ref={wrapper}
          role="application"
          aria-label="canvas do preview"
          tabIndex={-1}
          className={cn(
            'papercraft-canvas absolute overflow-hidden',
            chrome === 'node' && 'top-8 right-0 bottom-1.5 left-0',
            chrome === 'canvas' &&
              'top-(--doric-titlebar-height) right-0 bottom-0 left-0',
            (spaceHeld || tool === 'pan') && 'cursor-grab',
            panDrag.current !== undefined && 'cursor-grabbing',
          )}
          style={
            chrome === 'node'
              ? { height: `${String(nodeHeight)}px` }
              : undefined
          }
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onMouseEnter={() => wrapper.current?.focus?.()}
        >
          <div
            className="papercraft-viewport absolute inset-0"
            style={{ transform: viewportTransform(viewport) }}
          >
            <PreviewSurface
              artifactId={artifactId}
              revision={selectedRevision ?? blockRevision ?? 1}
              markup={preview?.markup}
              onContent={onContent}
              onMode={onMode}
            />
          </div>

          {/* What the armed comment points at, before the click. */}
          {tool === 'comment' && hoverNode !== undefined ? (
            <div
              data-testid="papercraft-hover"
              className="pointer-events-none absolute z-10 border-2 border-primary/60"
              style={outlineOf(hoverNode)}
            />
          ) : null}

          {/* The selection: the element with its outline. */}
          {selectedNode !== undefined ? (
            <div
              data-testid="papercraft-selection"
              className="pointer-events-none absolute z-10 border-2 border-primary"
              style={outlineOf(selectedNode)}
            />
          ) : null}

          <PinsLayer pins={pins} viewport={viewport} />
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

        {/* The fallback's note form: only without a composer stack. */}
        {draft === undefined ? null : (
          <form
            ref={noteFormRef}
            className="papercraft-note absolute inset-x-0 bottom-2 z-10 mx-auto flex w-fit gap-1"
            data-testid="papercraft-note"
          >
            <input
              type="text"
              className="papercraft-note-input h-7 w-56 rounded border border-border bg-background px-2 text-xs"
              placeholder="Comente o elemento…"
            />
            <Button type="submit" size="sm">
              Comentar
            </Button>
          </form>
        )}

        {/* The node's one comment button, in the corner. */}
        {chrome === 'node' ? (
          <Button
            variant="outline"
            size="icon-sm"
            aria-pressed={tool === 'comment'}
            data-testid="papercraft-comment"
            className="absolute right-2 bottom-2 z-10 rounded-full"
            onClick={() => setTool(tool === 'comment' ? 'select' : 'comment')}
          >
            <MessageSquarePlusIcon aria-hidden="true" />
            {pins.length === 0 ? null : (
              <Badge
                variant="secondary"
                className="ml-1 h-4 min-w-4 px-0.5 text-[9px]"
              >
                {String(pins.length)}
              </Badge>
            )}
          </Button>
        ) : null}

        {/* The node's fixed height is the reader's, dragged. */}
        {chrome === 'node' ? (
          <div
            className="papercraft-resize absolute inset-x-0 bottom-0 z-10 h-1.5 cursor-row-resize"
            onPointerDown={onHeightPointerDown}
            onPointerMove={onHeightPointerMove}
            onPointerUp={onHeightPointerUp}
          />
        ) : null}

        {chrome === 'canvas' ? (
          <>
            <TreePanel
              graph={graphRef.current}
              selectedId={selectedId}
              hidden={hidden}
              onSelect={(nodeId) => setSelectedId(nodeId)}
              onToggleHidden={(nodeId) =>
                setHidden((current) => {
                  const next = new Set(current);

                  if (next.has(nodeId)) next.delete(nodeId);
                  else next.add(nodeId);

                  return next;
                })
              }
            />
            <CommandToolbar
              artifactId={artifactId}
              execute={execute}
              tool={tool}
              pinCount={pins.length}
              hasSelection={selectedId !== undefined}
              hasHidden={hidden.size > 0}
              zoom={zoomPercent(viewport)}
              revisions={{
                current: selectedRevision ?? record?.revision ?? 1,
                total: revisionTotal,
                list: Array.from(
                  { length: revisionTotal },
                  (_, index) => index + 1,
                ),
                approved,
              }}
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
