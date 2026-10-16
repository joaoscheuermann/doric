// `preview-container.tsx` — the frame of one preview: the overlay header, the
// canvas that fills the frame and flows under it, the comment flow, pan/zoom,
// selection and layers (spec: "A UI no node e na janela").
//
// One surface, two moldings (`Uma superfície, duas molduras`). In the
// conversation (`chrome: 'node'`) the surface is the body of the `artifacts`
// registry's frame, and it draws its own header (the kind declares
// `header: 'body'`): the frame keeps only `Autorizar` below it. The node is
// a square — as tall as it is wide. The window
// (`chrome: 'canvas'`) draws the same surface full-screen, with the tree on
// the left and the command bar centred on the bottom edge.
//
// The comment flow is Figma's: the comment control (or `C` on the focused
// canvas) arms comment mode; the element under the pointer gets a dashed
// outline and a label naming it and its source line (`Alt` forces a free
// point); a click drops a pin with an inline input beside it, and only
// confirming it (`Enter` or ↑) adds the draft to the Thread's composer stack.
// A pin that holds its first comment opens its thread: the messages, the
// state, resolve/reopen, and a reply row whose replies join the stack too. A
// draft stays a draft until a prompt is sent; `Cmd/Ctrl+Enter` sends the
// stack now, through chat's own send path.
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
// or focus by passing over it. The reader's first click on the node only
// focuses it — the frame takes the app's primary outline and the click does
// nothing else — and only the focused node shows its controls (the header's
// buttons, the footer) and the tool it had armed: the cursor, the outlines.
// That view state survives the blur and returns with the focus; `Esc` with
// nothing open hands the focus back. The wheel pans only the focused node (or
// zooms with the modifier). The window is always focused.

import { type Commands, CommandsV1, type Services } from 'bundle/contracts';
import { TooltipProvider } from 'desktop/ui/tooltip';
import { cn } from 'desktop/ui/utils';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  ARTIFACT_TARGET_KIND,
  ArtifactsV1,
  COMMENT_THREAD_OPEN_EVENT,
  type CommentThreadOpenDetail,
  callScopeOf,
  OPEN_CANVAS_COMMAND,
  type PreviewScope,
  type PreviewTool,
} from '../../contracts/index.js';
import { anchorOf, pointAnchorOf, targetOf } from '../anchor.js';
import {
  type PreviewController,
  registerController,
  touchController,
} from '../canvas-registry.js';
import {
  beginComment,
  editComment,
  type PendingCommentData,
  removeComment,
  resolveComment,
  sendComments,
} from '../comment.js';
import { CommandToolbar } from './command-toolbar.js';
import { NodeFooter } from './node-footer.js';
import { anchorIndexOf, offsetIn, pinPointOf } from './pin-geometry.js';
import {
  type CommentInputProps,
  type CommentPin,
  OVERLAY_ATTRIBUTE,
  PinsLayer,
} from './pins-layer.js';
import { ensureRevisionCached, usePreviewData } from './preview-data.js';
import { PreviewHeader } from './preview-header.js';
import { PreviewSurface, type SurfaceMode } from './preview-surface.js';
import {
  type BoundsOf,
  boundsIndex,
  buildSceneGraph,
  hitTest,
  isolateHiddenIds,
  nearestNode,
  nodeLabel,
  type SceneGraph,
  type SceneNode,
  visualBounds,
} from './scene-graph.js';
import { ThreadPopover } from './thread-popover.js';
import {
  anchorTextOf,
  anchorTitleOf,
  DETACHED_STEP,
  nextPinOf,
  openCountOf,
  pinsOf,
  threadViewOf,
} from './threads-view.js';
import { TreePanel } from './tree-panel.js';
import {
  fitViewport,
  gridBackground,
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

/** The room a fit leaves around the element, clear of the header and footer. */
const FIT_MARGIN = 48;

const EMPTY_BOUNDS = { x: 0, y: 0, width: 0, height: 0 } as const;

/** The comment balloon the pointer becomes in comment mode; its tip is the hotspot. */
const COMMENT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M2 22V12a10 10 0 1 1 10 10z" fill="#2563eb" stroke="white" stroke-width="1.5"/></svg>',
)}") 2 22, crosshair`;

/**
 * What is open over the canvas, if anything: the inline input of a new
 * comment, or the thread of a pin that holds its first comment (keyed by its
 * root's id, which a draft keeps once it is sent).
 */
type OpenComment =
  | { readonly kind: 'new'; readonly data: PendingCommentData }
  | { readonly kind: 'thread'; readonly rootId: string };

/** The label the armed comment tool shows over an element: `button#pay · Checkout.tsx:42`. */
export const hoverLabelOf = (node: SceneNode): string => {
  const element = nodeLabel(node);

  if (node.stamp === undefined) return element;

  const file = node.stamp.path.split('/').pop() ?? node.stamp.path;

  return node.stamp.line === undefined
    ? `${element} · ${file}`
    : `${element} · ${file}:${String(node.stamp.line)}`;
};

/** Copies a text to the clipboard, when the window lets it. */
const copyText = (text: string): void => {
  void globalThis.navigator?.clipboard?.writeText(text).catch(() => undefined);
};

/** Whether an event came from the overlay (pins, the inline input). */
const fromOverlay = (event: Event): boolean =>
  (typeof event.composedPath === 'function' ? event.composedPath() : []).some(
    (part) => part instanceof Element && part.hasAttribute(OVERLAY_ATTRIBUTE),
  );

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
  const [graphTick, setGraphTick] = useState(0);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [open, setOpen] = useState<OpenComment | undefined>(undefined);
  const [text, setText] = useState('');
  /** The draft of the open thread whose note the field edits, if any. */
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [showResolved, setShowResolved] = useState(true);
  const [focused, setFocused] = useState(false);

  /** Whether the frame shows its controls and tools: the window always is. */
  const active = chrome === 'canvas' || focused;

  const container = useRef<HTMLDivElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const viewportRef = useRef(viewport);
  const revisionRef = useRef(selectedRevision);
  const selectedRef = useRef(selectedId);
  const chromeRef = useRef(chrome);
  const toolRef = useRef(tool);
  /** Whether the focus is in the frame, read before the render it causes. */
  const focusedRef = useRef(false);
  const graphRef = useRef<SceneGraph | undefined>(undefined);
  const boundsRef = useRef<BoundsOf | undefined>(undefined);
  /** A pointer-down that resolved the open input consumes its click. */
  const consumeClick = useRef(false);
  /** A pointer-down that only focused the node consumes its click. */
  const focusClick = useRef(false);
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
  chromeRef.current = chrome;
  toolRef.current = tool;

  /* The scene graph, derived from what the revision rendered ---------------- */

  const contentRef = useRef<HTMLElement | null>(null);

  /**
   * A fresh cache of node bounds, in content coordinates. The artifact's
   * layout follows the canvas's width (its page is as wide as the canvas), so
   * a cache is only good for the size it was measured at.
   */
  const measureBounds = useCallback(
    (content: HTMLElement | null) =>
      boundsIndex((node) => {
        const rect = node.element.getBoundingClientRect();
        const origin = content?.getBoundingClientRect() ?? { x: 0, y: 0 };
        const scale = viewportRef.current.scale;

        return {
          x: (rect.x - origin.x) / scale,
          y: (rect.y - origin.y) / scale,
          width: rect.width / scale,
          height: rect.height / scale,
        };
      }),
    [],
  );

  const onContent = useCallback(
    (root: ShadowRoot | undefined) => {
      if (root === undefined) {
        graphRef.current = undefined;
        boundsRef.current = undefined;
        contentRef.current = null;

        return;
      }

      const content = root.querySelector(
        '.papercraft-content',
      ) as HTMLElement | null;
      const base: ParentNode = content ?? root;
      const graph = buildSceneGraph(base);

      graphRef.current = graph;
      contentRef.current = content;
      boundsRef.current = measureBounds(content);
      setGraphTick((tick) => tick + 1);
    },
    [measureBounds],
  );

  // Path B: the revision's entries reach the desktop's verified cache before
  // the surface imports its module.
  const ensure = useCallback(
    (id: string, revision: number) =>
      ensureRevisionCached(services, scope, id, revision),
    [services, scope],
  );

  const onMode = useCallback((mode: SurfaceMode) => {
    setSurfaceMode(mode);
  }, []);

  // A hidden layer is view state, applied to the artifact's DOM: hidden nodes
  // never answer a pointer. The graph is read through a ref, so the readings
  // that rebuild it are what re-apply the layers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new graph re-applies the hidden layers
  useEffect(() => {
    for (const node of graphRef.current?.nodes ?? []) {
      (node.element as HTMLElement).style.visibility = hidden.has(node.id)
        ? 'hidden'
        : '';
    }
  }, [hidden, preview, graphTick, selectedRevision]);

  /* The frame's comment gesture: each request toggles the comment tool ------ */

  const handledRequest = useRef(commentRequest);

  useEffect(() => {
    if (commentRequest === handledRequest.current) return;

    handledRequest.current = commentRequest;
    if (!canComment) return;

    // Arming the tool from outside chooses the canvas too: its tools only
    // show on the focused node.
    if (toolRef.current !== 'comment')
      wrapper.current?.focus?.({ preventScroll: true });
    setTool((current) => (current === 'comment' ? 'select' : 'comment'));
    setOpen(undefined);
    setText('');
  }, [commentRequest, canComment]);

  /* The pins: the preview's threads, on whatever revision, then its drafts --- */

  // The graph is read through refs; its tick is what changes. A pin whose
  // anchor no longer resolves is stacked by the content's edge, a fixed
  // surface step apart whatever the zoom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: graphTick re-derives the pins over a new graph
  const pins = useMemo<readonly CommentPin[]>(
    () =>
      pinsOf(
        threads,
        drafts,
        showResolved,
        (anchor, fallback) =>
          pinPointOf(anchor, graphRef.current, boundsRef.current, fallback),
        DETACHED_STEP / viewport.scale,
      ),
    [threads, drafts, showResolved, graphTick, viewport.scale],
  );

  /** What the comment control counts: the open threads and the draft pins. */
  const commentCount = openCountOf(threads, drafts);

  /** Whether a thread of the preview is resolved: the eye shows then. */
  const hasResolved = threads.some((thread) => thread.state === 'done');

  /** The next pin's number: never one the preview already shows. */
  const nextPin = (): number => nextPinOf(threads, drafts);

  /** The thread open over the canvas, as its popover shows it. */
  // A reply's id names its thread too: the thread opens at its root.
  const openRootId =
    open?.kind === 'thread'
      ? (threads.find((candidate) =>
          candidate.replies.some((reply) => reply.commentId === open.rootId),
        )?.root.commentId ?? open.rootId)
      : undefined;

  // A reply answers the root on the root's own target, the revision it was
  // written on, whatever revision is on screen.
  const thread =
    openRootId !== undefined
      ? threadViewOf(openRootId, threads, drafts, {
          artifactId,
          ...(selectedRevision === undefined
            ? {}
            : { revision: selectedRevision }),
        })
      : undefined;

  /** The preview's title and source, for the stack's line to name. */
  const refs = {
    ...(record?.title === undefined ? {} : { title: record.title }),
    ...(record?.path === undefined ? {} : { source: record.path }),
  };

  /* The inline input: confirm, cancel, send ----------------------------------- */

  const closeInput = () => {
    setOpen(undefined);
    setText('');
    setEditing(undefined);
  };

  /** Removes one draft of the stack, and the draft replies that answer it. */
  const removeDraft = (itemId: string): void => {
    const ids = [
      itemId,
      ...drafts
        .filter((draft) => draft.inReplyTo === itemId)
        .map((draft) => draft.id),
    ];

    for (const id of ids) {
      void removeComment(services, scope, id).catch(() => undefined);
    }

    if (open?.kind === 'thread' && open.rootId === itemId) closeInput();
    if (editing !== undefined && ids.includes(editing)) {
      setEditing(undefined);
      setText('');
    }
  };

  /**
   * Confirms what the open field holds. A new note joins the stack as a draft
   * (only now — nothing touched the stack while it was typed). In a thread, a
   * reply joins the stack answering the thread's root, and an edit updates its
   * draft — an emptied one is removed. An empty note confirms nothing.
   * `close` closes the thread too; a new comment's input always closes.
   */
  const confirmInput = async (close = true): Promise<void> => {
    const current = open;
    const note = text.trim();
    const edited = editing;

    if (current?.kind !== 'thread' || close) closeInput();
    else {
      setText('');
      setEditing(undefined);
    }

    try {
      if (current?.kind === 'new') {
        if (note !== '')
          await beginComment(services, scope, { data: current.data, note });

        return;
      }

      if (current?.kind !== 'thread') return;

      if (edited !== undefined) {
        const original = drafts.find((draft) => draft.id === edited);

        if (note === '') removeDraft(edited);
        else if (original !== undefined && note !== original.note)
          await editComment(services, scope, edited, note);

        return;
      }

      if (note === '' || thread === undefined) return;

      await beginComment(services, scope, {
        data: {
          target: thread.target,
          pin: thread.pin,
          inReplyTo: thread.rootId,
          refs,
        },
        note,
      });
    } catch {
      // The stack is unreachable: the gesture leaves nothing behind.
    }
  };

  /** Click outside or focus leaving: a note is kept as a draft, an empty one discarded. */
  const resolveInput = (): void => {
    void confirmInput();
  };

  /** Sends the stack now, after confirming what the open field holds. */
  const sendNow = async (): Promise<void> => {
    await confirmInput();
    await sendComments(services, scope);
  };

  /** A pin opens its thread; the field opens empty, to reply. */
  const openPin = (pin: CommentPin) => {
    if (open?.kind === 'thread' && open.rootId === pin.key) return;

    if (open !== undefined) void confirmInput();
    setOpen({ kind: 'thread', rootId: pin.key });
    setText('');
    setEditing(undefined);
  };

  /** Loads one draft of the open thread into the field, to edit it. */
  const editDraft = (itemId: string) => {
    const draft = drafts.find((candidate) => candidate.id === itemId);

    if (draft === undefined) return;

    setEditing(itemId);
    setText(draft.note);
  };

  /** Opens one thread asked for from outside the canvas, and shows the frame. */
  const showThread = (commentId: string): void => {
    if (open !== undefined) void confirmInput();
    setOpen({ kind: 'thread', rootId: commentId });
    setText('');
    setEditing(undefined);
    // A resolved thread opens with its pin shown.
    if (
      threads.some(
        (candidate) =>
          candidate.root.commentId === commentId && candidate.state === 'done',
      )
    )
      setShowResolved(true);
    container.current?.scrollIntoView?.({
      block: 'center',
      behavior: 'smooth',
    });
  };

  const showThreadRef = useRef(showThread);
  showThreadRef.current = showThread;

  /**
   * The conversation asks to see a thread (`doric:comment-thread-open`): when
   * it is one of this preview's, the frame comes into view and opens the
   * root's thread. Every revision shows every thread, so the window keeps the
   * revision on screen. Of the conversation's nodes only one answers: the
   * node of the revision the target names, or — a target without a revision
   * means the latest — the node of the preview's newest revision, which it
   * asks the registry for, since a node's own reading may predate a later
   * revision.
   */
  const openFromConversation = (detail: CommentThreadOpenDetail): void => {
    const revision = detail.target.revision;
    const own = blockRevision ?? selectedRevision;

    if (detail.target.kind !== ARTIFACT_TARGET_KIND) return;
    if (detail.target.id !== artifactId) return;

    if (chrome !== 'node') {
      showThread(detail.commentId);

      return;
    }

    if (revision !== undefined) {
      if (revision === own) showThread(detail.commentId);

      return;
    }

    const known = record?.revisions;
    const newest = async (): Promise<number | undefined> => {
      if (scope === undefined) return known;

      try {
        const latest = await services
          .use(ArtifactsV1, callScopeOf(scope))
          .read({ artifactId });

        return latest?.revision ?? known;
      } catch {
        return known;
      }
    };

    void newest().then((latest) => {
      if (latest !== undefined && latest === own)
        showThreadRef.current(detail.commentId);
    });
  };

  const threadOpenRef = useRef(openFromConversation);
  threadOpenRef.current = openFromConversation;

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<CommentThreadOpenDetail>).detail;

      if (
        typeof detail?.commentId !== 'string' ||
        typeof detail.target?.id !== 'string'
      )
        return;

      threadOpenRef.current(detail);
    };

    document.addEventListener(COMMENT_THREAD_OPEN_EVENT, onOpen);

    return () =>
      document.removeEventListener(COMMENT_THREAD_OPEN_EVENT, onOpen);
  }, []);

  /** Resolves or reopens the open thread's sent root, under its own prompt. */
  const toggleResolved = () => {
    const root = thread?.sent?.root;

    if (root === undefined) return;

    void resolveComment(services, scope, {
      commentId: root.commentId,
      promptId: root.promptId,
      resolved: !root.resolved,
    }).then(() => reloadComments());
  };

  const setCommentMode = (on: boolean) => {
    if (!on) closeInput();
    setHoverId(undefined);
    setTool(on ? 'comment' : 'select');
  };

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

  const nodeOfEvent = (event: Event, nearest = true): SceneNode | undefined => {
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
      (nearest ? nearestNode(graph, point, bounds, hidden) : undefined)
    );
  };

  /**
   * The element a comment would land on: the one under the pointer, never the
   * document's own body — empty space is a free point — and none at all while
   * `Alt` is held, which forces a free point over an element.
   */
  const commentNodeOf = (event: MouseEvent): SceneNode | undefined => {
    if (event.altKey) return undefined;

    const node = nodeOfEvent(event, false);

    return node === undefined || node.tag === 'body' || node.tag === 'html'
      ? undefined
      : node;
  };

  /* The click: select, or drop a pin with its inline input ------------------- */

  const gestureClick = (event: MouseEvent) => {
    // A click whose element left the document as it was handled (a menu item
    // of an open thread, say) was never a click on the preview.
    if (event.target instanceof Node && !event.target.isConnected) return;
    if (fromOverlay(event)) return;
    if (consumeClick.current) {
      consumeClick.current = false;

      return;
    }
    if (tool === 'pan') return;

    // The preview is being inspected, not used: a link or a submit under the
    // pointer must not navigate the window away.
    event.preventDefault();

    if (tool === 'select') {
      setSelectedId(nodeOfEvent(event)?.id);

      return;
    }

    const revision = revisionRef.current;

    if (revision === undefined || !canComment) return;

    const node = commentNodeOf(event);
    const point = contentPointOf(event);
    const box = node === undefined ? undefined : boundsRef.current?.(node);
    const anchor =
      node === undefined
        ? pointAnchorOf(point, nearestNodeOf(point))
        : anchorOf(
            node.element,
            box === undefined ? undefined : offsetIn(box, point),
            point,
            graphRef.current === undefined
              ? undefined
              : anchorIndexOf(graphRef.current, node),
          );

    // The balloon and its input open at the click; the stack is untouched
    // until the note is confirmed.
    setOpen({
      kind: 'new',
      data: {
        target: targetOf(artifactId, revision, anchor),
        pin: nextPin(),
        point,
        refs,
      },
    });
    setText('');
    setEditing(undefined);
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

  /* Pan with the space bar, zoom with the wheel -------------------------------- */

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === ' ') {
      event.preventDefault();
      setSpaceHeld(true);

      return;
    }

    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void sendNow();

      return;
    }

    if (event.key === 'Escape') {
      if (open !== undefined) closeInput();
      else if (tool === 'comment') setCommentMode(false);
      // Nothing left to cancel: the node gives the focus back.
      else if (chrome === 'node') wrapper.current?.blur?.();

      return;
    }

    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;

    if (plain && (event.key === 'c' || event.key === 'C') && canComment) {
      event.preventDefault();
      setCommentMode(tool !== 'comment');
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
    if (!active || tool !== 'comment' || fromOverlay(event)) return;

    const id = commentNodeOf(event)?.id;

    if (id !== hoverId) setHoverId(id);
  };

  const onPanPointerDown = (event: PointerEvent) => {
    if (fromOverlay(event)) return;

    // A click outside the open input resolves it — a note stays as a draft,
    // an empty one is discarded — and that click starts nothing else.
    if (open !== undefined) {
      consumeClick.current = true;
      resolveInput();
    }

    // A click is the reader choosing the canvas: it takes the focus (the
    // space bar and, in the node, the wheel are the canvas's from then on)
    // and becomes the canvas a keybinding acts on.
    wrapper.current?.focus?.({ preventScroll: true });
    touchController(artifactId);

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
    const onBlur = () => setSpaceHeld(false);
    const onWheel = (event: WheelEvent): void => {
      const zoom = event.ctrlKey || event.metaKey;

      // An open thread scrolls its own messages.
      if (!zoom && fromOverlay(event)) return;

      // In the conversation the wheel scrolls the conversation: the node pans
      // only once the reader clicked it, and zooms only with the modifier.
      if (chromeRef.current === 'node' && !zoom && !focusedRef.current) return;

      event.preventDefault();

      if (zoom) {
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
    area.addEventListener('blur', onBlur);

    return () => {
      area.removeEventListener('blur', onBlur);
      area.removeEventListener('click', onClick);
      area.removeEventListener('pointermove', onPointerMove);
      area.removeEventListener('pointerdown', onPointerDown);
      area.removeEventListener('pointerup', onPointerUp);
      area.removeEventListener('wheel', onWheel);
    };
  }, []);

  // The node's focus is the frame's: the canvas, the open input, the header's
  // and the footer's controls all keep it. Unfocused, the first press on the
  // frame only focuses it — captured before anything inside sees it, the
  // artifact's own handlers included — and the click it makes is consumed.
  useEffect(() => {
    const frame = container.current;

    if (frame === null) return;

    const onFocusIn = () => {
      focusedRef.current = true;
      setFocused(true);
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;

      if (next instanceof Node && frame.contains(next)) return;
      focusedRef.current = false;
      setFocused(false);
    };
    const focusFrame = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      wrapper.current?.focus?.({ preventScroll: true });
      touchController(artifactId);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (chromeRef.current !== 'node' || focusedRef.current) return;
      focusClick.current = true;
      focusFrame(event);
    };
    const onClick = (event: MouseEvent) => {
      if (chromeRef.current !== 'node') return;
      if (!focusClick.current && focusedRef.current) return;
      focusClick.current = false;
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
  }, [artifactId]);

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

  /** The last view a fit set; while it is still the view, nobody moved it. */
  const autoFit = useRef<Viewport | undefined>(undefined);

  /**
   * Centres what the artifact shows — the element, not the page around it —
   * scaled down to fit and never blown up. False while nothing is measurable.
   */
  const fitContent = useCallback((): boolean => {
    const graph = graphRef.current;
    const bounds = boundsRef.current;

    if (graph === undefined || bounds === undefined) return false;

    const content = visualBounds(graph, bounds);
    const area = areaSize();

    if (content === undefined || area.width <= 0 || area.height <= 0)
      return false;

    const fitted = fitViewport(content, area, FIT_MARGIN);

    autoFit.current = fitted;
    setViewport(fitted);

    return true;
  }, [areaSize]);

  // The canvas changing size relays the artifact out: the cached bounds are
  // measured again (outlines, pins and hit-tests follow the new layout), and a
  // view nobody moved since it was fitted is fitted again, so it stays centred.
  useEffect(() => {
    const area = wrapper.current;

    if (area === null || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (graphRef.current === undefined) return;

      boundsRef.current = measureBounds(contentRef.current);
      setGraphTick((tick) => tick + 1);

      if (
        autoFit.current !== undefined &&
        viewportRef.current === autoFit.current
      ) {
        fitContent();
      }
    });

    observer.observe(area);

    return () => observer.disconnect();
  }, [fitContent, measureBounds]);

  // Every revision opens centred: the first time its content is measured, the
  // view fits it. Pan and zoom after that are the reader's.
  const centredFor = useRef<string | undefined>(undefined);
  const contentKey = `${artifactId}@${String(selectedRevision ?? blockRevision ?? 1)}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: graphTick is when a revision's content is measured
  useEffect(() => {
    if (centredFor.current === contentKey) return;
    if (fitContent()) centredFor.current = contentKey;
  }, [contentKey, fitContent, graphTick]);

  // The scope's members, not its identity, which may change every render.
  const scopeProject = scope?.projectId;
  const scopeThread = scope?.threadId;

  const controller = useMemo<PreviewController>(
    () => ({
      artifactId,
      scope:
        scopeProject === undefined
          ? undefined
          : {
              projectId: scopeProject,
              ...(scopeThread === undefined ? {} : { threadId: scopeThread }),
            },
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
        fitContent();
      },
      selectRevision: (revision) => {
        setSelectedId(undefined);
        setHidden(new Set());
        selectRevision(revision);
      },
      currentRevision: () => revisionRef.current ?? undefined,
      reload,
    }),
    [
      artifactId,
      areaSize,
      fitContent,
      scopeProject,
      scopeThread,
      selectRevision,
      reload,
    ],
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

  const canOpen = scope?.threadId !== undefined;

  const open_ = () => {
    if (scope?.threadId === undefined) return;

    execute(OPEN_CANVAS_COMMAND, {
      artifactId,
      projectId: scope.projectId,
      threadId: scope.threadId,
    });
  };

  /* What the frame reads for its chrome ----------------------------------------- */

  // The header names the file (else the title) and the revision on screen.
  const title = record?.path ?? record?.title ?? artifactId;

  const revisionTotal = record?.revisions ?? 1;

  const selectedNode =
    selectedId === undefined
      ? undefined
      : graphRef.current?.byId.get(selectedId);

  const hoverNode =
    hoverId === undefined ? undefined : graphRef.current?.byId.get(hoverId);

  /** The hover label sits on the outline's top edge, inside the canvas. */
  const hoverLabelPlacement = (node: SceneNode) => {
    const box = boundsRef.current?.(node) ?? EMPTY_BOUNDS;
    const left = box.x * viewport.scale + viewport.tx;
    const top = box.y * viewport.scale + viewport.ty;

    return {
      left: `${String(Math.max(4, left))}px`,
      top: `${String(top >= 22 ? top - 20 : top + box.height * viewport.scale + 4)}px`,
    };
  };

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

  /* The open inline input, positioned on its pin -------------------------------- */

  const input: CommentInputProps | undefined =
    open?.kind !== 'new' || open.data.point === undefined
      ? undefined
      : {
          point:
            pinPointOf(
              open.data.target.anchor,
              graphRef.current,
              boundsRef.current,
              open.data.point,
            ) ?? open.data.point,
          value: text,
          onChange: setText,
          onConfirm: () => void confirmInput(),
          onCancel: closeInput,
          onSend: () => void sendNow(),
          onBlurOutside: resolveInput,
        };

  /* The open thread, beside its pin ---------------------------------------------- */

  const threadPoint =
    thread === undefined
      ? undefined
      : (pins.find((pin) => pin.key === thread.rootId)?.point ??
        pinPointOf(
          thread.target.anchor,
          graphRef.current,
          boundsRef.current,
          thread.point,
        ));

  const threadPopover =
    thread === undefined || threadPoint === undefined ? null : (
      <ThreadPopover
        point={threadPoint}
        viewport={viewport}
        area={areaSize()}
        pin={thread.pin}
        title={anchorTitleOf(thread.target.anchor, record?.path)}
        anchor={anchorTextOf(thread.target.anchor, thread.target.revision)}
        messages={thread.messages}
        {...(thread.sent === undefined
          ? {}
          : { state: thread.sent.state, onResolve: toggleResolved })}
        canResolve={
          scope?.threadId !== undefined &&
          thread.sent?.root.promptId !== undefined
        }
        showResolved={showResolved}
        onToggleShowResolved={() => setShowResolved((shown) => !shown)}
        value={text}
        editing={editing !== undefined}
        onChange={setText}
        onConfirm={() => void confirmInput(false)}
        onCancel={closeInput}
        onClose={resolveInput}
        onSend={() => void sendNow()}
        onEdit={editDraft}
        onRemove={removeDraft}
        onCopy={copyText}
      />
    );

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
          canOpen={canOpen}
          onOpen={open_}
          commentActive={tool === 'comment'}
          canComment={canComment}
          commentCount={commentCount}
          onToggleComment={() => setCommentMode(tool !== 'comment')}
          {...(hasResolved
            ? {
                resolvedToggle: {
                  shown: showResolved,
                  onToggle: () => setShowResolved((shown) => !shown),
                },
              }
            : {})}
          draftCount={drafts.length}
          onSend={() => void sendNow()}
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
            panDrag.current !== undefined && 'cursor-grabbing',
          )}
          // The dot grid rides the viewport, so it pans and zooms with the
          // content over the container's own background colour.
          style={{
            ...gridBackground(viewport),
            ...(active && tool === 'comment' && !spaceHeld
              ? { cursor: COMMENT_CURSOR }
              : {}),
          }}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
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
              ensure={ensure}
              onContent={onContent}
              onMode={onMode}
              // The comment balloon (and the pan hand) stays over the
              // artifact's own elements, whatever cursor they declare.
              lockCursor={
                active && (tool === 'comment' || tool === 'pan' || spaceHeld)
              }
            />
          </div>

          {/* What the armed comment lands on, before the click: a dashed
              outline, never the selection's solid one, and a label naming
              the element and the source line it came from — the label only
              while nothing is open over the canvas, so it never covers the
              input, its pending pin or a thread. */}
          {active && tool === 'comment' && hoverNode !== undefined ? (
            <>
              <div
                data-testid="papercraft-hover"
                className="pointer-events-none absolute z-10 rounded-sm border-[1.5px] border-dashed border-primary"
                style={outlineOf(hoverNode)}
              />
              {open === undefined ? (
                <span
                  data-testid="papercraft-hover-label"
                  className="pointer-events-none absolute z-10 rounded-sm bg-primary px-1.5 font-mono text-[10.5px] leading-4 whitespace-nowrap text-primary-foreground"
                  style={hoverLabelPlacement(hoverNode)}
                >
                  {hoverLabelOf(hoverNode)}
                </span>
              ) : null}
            </>
          ) : null}

          {/* The selection: the element with its outline. */}
          {active && selectedNode !== undefined ? (
            <div
              data-testid="papercraft-selection"
              className="pointer-events-none absolute z-10 border-2 border-primary"
              style={outlineOf(selectedNode)}
            />
          ) : null}

          <PinsLayer
            pins={pins}
            viewport={viewport}
            area={areaSize()}
            {...(input === undefined ? {} : { input })}
            {...(thread === undefined ? {} : { activeKey: thread.rootId })}
            onOpenPin={openPin}
          >
            {threadPopover}
          </PinsLayer>
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
              pinCount={commentCount}
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
