// The diagram's modal (spec "O modal do diagrama"): Revisar (state machine
// rows 1, 2, 3, 6) — the node's canvas expanded over the conversation, with a
// page menu, a revision menu and the Revisar keys — and Editar (rows 4–30):
// the draw.io editor over the revision on screen, its saves, the exit dialog
// (D1–D4) that asks before an unsaved edit is lost, and the new-revision
// banner.

import { DrawioError } from '@drawio/react';
import {
  ContractError,
  type DoricConnection,
  DoricConnectionV1,
  type Services,
} from 'bundle/contracts';
import { Button } from 'desktop/ui/button';
import {
  CanvasHeader,
  CanvasModal,
  type CanvasModalCloseReason,
  type CanvasTool,
  CanvasToolbar,
  type ThreadWatchSource,
  ToolbarButton,
  ToolbarGroup,
  ToolbarSeparator,
  useAppTheme,
  watchArtifactRevisions,
} from 'desktop/ui/canvas';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from 'desktop/ui/dropdown-menu';
import { Input } from 'desktop/ui/input';
import { toast } from 'desktop/ui/sonner';
import {
  CheckIcon,
  FolderDownIcon,
  HandIcon,
  MaximizeIcon,
  MessageSquarePlusIcon,
  MousePointer2Icon,
  PencilIcon,
  SaveIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type MutableRefObject,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  type ArtifactRecord,
  ArtifactsV1,
  callScopeOf,
  DIAGRAM_ENTRY,
  type DiagramSaved,
  type DiagramScope,
  DrawioDiagramsV1,
  DrawioSvgV1,
  EDITOR_HEARTBEAT_MS,
  EDITOR_LOAD_TIMEOUT_MS,
  type ExportResult,
  RuntimeThreadsV1,
} from '../contracts/index.js';
import { type DiagramData, useDiagramData } from './diagram-data.js';
import { DiagramCanvas, type DiagramCanvasControls } from './diagram-view.js';
import type { DiagramDrawing } from './drawing.js';
import {
  type EditorClient,
  type EditorEvent,
  EditorFrame,
} from './editor-frame.js';
import type { DiagramBlockData } from './elements.js';
import type { DiagramPage } from './model.js';

export interface DiagramModalProps {
  readonly open: boolean;
  readonly services: Services;
  readonly scope: DiagramScope | undefined;
  /** The node's block: the revision Revisar opens on. */
  readonly block: DiagramBlockData;
  readonly drawing: DiagramDrawing;
  /**
   * Called only when the modal's machine reaches `fechado`, with the reason
   * of the close request (`Esc` nothing took, backdrop, close button) that
   * led there; the owner then closes. A request the machine ignores (one
   * that would lose an edit) never calls it.
   */
  readonly onCloseRequest: (reason: CanvasModalCloseReason) => void;
}

/**
 * The diagram's modal: `CanvasModal` titled `block.title`; while `open`, its
 * content mounts fresh on `block.revision`, page 1 (no `pageId`), in Revisar.
 * - Revisions: `artifacts/v1.revisions({ artifactId })` once per opening
 *   (scope `callScopeOf(scope)`); a rejection or an empty list leaves only
 *   the node's revision (no menu).
 * - Row 2: choosing page k sets `pageId = model.pages[k-1].id`.
 * - Row 3: choosing revision n shows `revisionBlockOf(record n, block)`
 *   (the node's own `block` for `block.revision`) and resets to page 1.
 * - Toolbar (`drawio-toolbar`, `CanvasToolbar label="Revisar"`):
 *   Ferramenta (Selecionar V, Comentar C — disabled without canComment —,
 *   Mão H, `aria-pressed` on the current), Vista (Menos zoom, zoom %, Mais
 *   zoom, 100%, Ajustar), Página (`aria-label="Página"`, `pág P/N`, one item
 *   per page named `name` or `Página k`, a check on the current; only with
 *   more than one page), Revisão (`aria-label="Revisão"`, `rev n/N`, items
 *   `rev k`; only with more than one revision), Editar (`drawio-edit`, `E`;
 *   disabled without the revision's XML, its revision count or a scope).
 * - Keys (`CanvasModal.onKeyDown`, never from text fields): in Revisar,
 *   skipped when default-prevented; else `controls.canvasKey` unless Space;
 *   then, if still not taken, `reviewKeyOf` → `preventDefault` and the
 *   control (`E` only while Editar is enabled). In Editar only CmdOrCtrl+S
 *   is taken (Salvar, row 18); with the exit dialog open, only Esc (D3).
 * - Editar: see `useEditMachine`.
 */
export function DiagramModal({
  open,
  services,
  scope,
  block,
  drawing,
  onCloseRequest,
}: DiagramModalProps): ReactElement {
  const handlersRef = useRef<ModalHandlers | undefined>(undefined);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    handlersRef.current?.onKeyDown(event);
  }, []);
  const requestClose = useCallback(
    (reason: CanvasModalCloseReason) => {
      const handlers = handlersRef.current;

      if (handlers === undefined) onCloseRequest(reason);
      else handlers.onCloseRequest(reason);
    },
    [onCloseRequest],
  );

  return (
    <CanvasModal
      open={open}
      title={block.title}
      onCloseRequest={requestClose}
      onKeyDown={onKeyDown}
    >
      {open ? (
        <DiagramModalContent
          services={services}
          scope={scope}
          block={block}
          drawing={drawing}
          handlersRef={handlersRef}
          onCloseRequest={onCloseRequest}
        />
      ) : null}
    </CanvasModal>
  );
}

/** What the open content answers for the modal: its keys and close requests. */
interface ModalHandlers {
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onCloseRequest: (reason: CanvasModalCloseReason) => void;
}

/** Runs a Revisar key on the canvas; `edit` runs `onEdit`. */
const runReviewKey = (
  controls: DiagramCanvasControls,
  key: ReviewKey,
  onEdit: () => void,
) => {
  switch (key) {
    case 'select':
    case 'pan':
      controls.setTool(key);
      return;
    case 'zoom-in':
      controls.zoomIn();
      return;
    case 'zoom-out':
      controls.zoomOut();
      return;
    case 'zoom-reset':
      controls.zoomReset();
      return;
    case 'zoom-fit':
      controls.zoomFit();
      return;
    case 'edit':
      onEdit();
      return;
  }
};

/**
 * One opening of the modal: the revision and page on screen, their data and
 * revision records (read once per opening), and the edit machine. Revisar
 * shows `DiagramReview`; every other phase shows `EditView`.
 */
function DiagramModalContent({
  services,
  scope,
  block,
  drawing,
  handlersRef,
  onCloseRequest,
}: {
  readonly services: Services;
  readonly scope: DiagramScope | undefined;
  readonly block: DiagramBlockData;
  readonly drawing: DiagramDrawing;
  readonly handlersRef: MutableRefObject<ModalHandlers | undefined>;
  readonly onCloseRequest: (reason: CanvasModalCloseReason) => void;
}): ReactElement {
  const controlsRef = useRef<DiagramCanvasControls | undefined>(undefined);
  const { records, reload: reloadRecords } = useRevisionRecords(
    services,
    scope,
    block.artifactId,
  );
  const [shown, setShown] = useState(block);
  const [pageId, setPageId] = useState<string | undefined>(undefined);
  // Row 23: Revisar on the answered revision, page 1, its records read again.
  const onSaved = (base: EditBase, saved: DiagramSaved) => {
    setShown(
      revisionBlockOf(
        {
          artifactId: base.block.artifactId,
          revision: saved.revision,
          entries: [{ path: DIAGRAM_ENTRY, sha256: saved.sha256 }],
        },
        block,
      ),
    );
    setPageId(undefined);
    reloadRecords();
  };
  const machine = useEditMachine(services, scope, onCloseRequest, onSaved);

  const data = useDiagramData({
    services,
    scope,
    block: shown,
    drawing,
    ...(pageId === undefined ? {} : { pageId }),
  });
  const base = editBaseOf(shown, data, scope);
  const edit = () => {
    if (base !== undefined) machine.edit(base);
  };
  const session = machine.state.session;
  const reviewing = machine.state.phase.kind === 'revisar';
  const [exporting, setExporting] = useState(false);
  const canExport = data.xml !== undefined && scope !== undefined;

  handlersRef.current = {
    onKeyDown: (event) => {
      // The export dialog takes its own keys (Q3); no Revisar key runs.
      if (exporting) return;
      // The exit dialog takes only Esc (D3), before `CanvasModal` sees it.
      if (session?.exit !== undefined) {
        if (event.key === 'Escape') {
          event.preventDefault();
          machine.exitContinue();
        }

        return;
      }
      // Editar takes only CmdOrCtrl+S, and only in `editando-modificado` (row 18).
      if (!reviewing) {
        const { phase } = machine.state;

        if (
          isSaveChord(event) &&
          phase.kind === 'editando' &&
          session?.memory !== undefined
        ) {
          event.preventDefault();
          machine.save();
        }

        return;
      }

      const controls = controlsRef.current;

      if (event.defaultPrevented || controls === undefined) return;
      if (event.key !== ' ') controls.canvasKey(event);
      if (event.defaultPrevented) return;

      const key = reviewKeyOf(event);

      if (key === undefined || (key === 'edit' && base === undefined)) return;

      event.preventDefault();
      runReviewKey(controls, key, edit);
    },
    onCloseRequest: (reason) => {
      // Q3: with the export dialog open, the modal does not close.
      if (!exporting) machine.closeRequest(reason);
    },
  };

  if (reviewing || session === undefined) {
    return (
      <>
        <DiagramReview
          services={services}
          scope={scope}
          block={block}
          shown={shown}
          onShown={setShown}
          onPageId={setPageId}
          data={data}
          records={records}
          controlsRef={controlsRef}
          canEdit={base !== undefined}
          onEdit={edit}
          canExport={canExport}
          onExport={() => setExporting(true)}
        />
        {exporting && data.xml !== undefined && scope !== undefined ? (
          <ExportDialog
            services={services}
            scope={scope}
            drawing={drawing}
            artifactId={shown.artifactId}
            revision={shown.revision}
            xml={data.xml}
            title={shown.title}
            onClose={() => setExporting(false)}
          />
        ) : null}
      </>
    );
  }

  return (
    <EditView
      drawing={drawing}
      phase={machine.state.phase}
      session={session}
      machine={machine}
    />
  );
}

/** The revision on screen as Editar's B; undefined while Editar is disabled. */
const editBaseOf = (
  shown: DiagramBlockData,
  data: DiagramData,
  scope: DiagramScope | undefined,
): EditBase | undefined =>
  data.xml === undefined || data.revisions === undefined || scope === undefined
    ? undefined
    : { block: shown, xml: data.xml, revisions: data.revisions };

/** Revisar: the revision and page on screen, and their canvas. */
function DiagramReview({
  services,
  scope,
  block,
  shown,
  onShown,
  onPageId,
  data,
  records,
  controlsRef,
  canEdit,
  onEdit,
  canExport,
  onExport,
}: {
  readonly services: Services;
  readonly scope: DiagramScope | undefined;
  /** The node's block. */
  readonly block: DiagramBlockData;
  /** The revision on screen. */
  readonly shown: DiagramBlockData;
  readonly onShown: (shown: DiagramBlockData) => void;
  readonly onPageId: (pageId: string | undefined) => void;
  /** `shown`'s data, on the page on screen. */
  readonly data: DiagramData;
  readonly records: readonly ArtifactRecord[];
  readonly controlsRef: MutableRefObject<DiagramCanvasControls | undefined>;
  readonly canEdit: boolean;
  readonly onEdit: () => void;
  readonly canExport: boolean;
  readonly onExport: () => void;
}): ReactElement {
  const choosePage = (page: DiagramPage) => onPageId(page.id);
  const chooseRevision = (record: ArtifactRecord) => {
    onShown(
      record.revision === block.revision
        ? block
        : revisionBlockOf(record, block),
    );
    onPageId(undefined);
  };

  return (
    <DiagramCanvas
      host="modal"
      services={services}
      scope={scope}
      block={shown}
      data={data}
      controlsRef={controlsRef}
      toolbar={(controls) => (
        <ReviewToolbar
          controls={controls}
          pages={data.model?.pages ?? []}
          pageId={data.view?.pageId}
          onPage={choosePage}
          records={records}
          revision={shown.revision}
          onRevision={chooseRevision}
          canEdit={canEdit}
          onEdit={onEdit}
          canExport={canExport}
          onExport={onExport}
        />
      )}
    />
  );
}

/* Editar's machine ---------------------------------------------------------- */

/** Why the editor is unavailable; `unavailableReasonOf` words it. */
type UnavailableCause =
  | 'missing-assets'
  | 'handler-failed'
  | 'status-failed'
  | 'load-failed'
  | 'not-answering';

/** The machine's phase; `modified ⇔ session.memory !== undefined`. */
type EditPhase =
  | { readonly kind: 'revisar' }
  | { readonly kind: 'carregando'; readonly modified: boolean }
  | { readonly kind: 'editando'; readonly modified: boolean }
  | ({ readonly kind: 'salvando' } & ExitDestination)
  | { readonly kind: 'indisponivel'; readonly cause: UnavailableCause };

/** Where a save or the exit dialog leads: Revisar, or `fechado` with the close request's reason. */
type ExitDestination =
  | { readonly destination: 'revisar' }
  | {
      readonly destination: 'fechado';
      readonly reason: CanvasModalCloseReason;
    };

/** The banner over the editor: row 20's restart, or row 25's save failure (its words). */
type EditBanner =
  | { readonly kind: 'restarted' }
  | { readonly kind: 'save-error'; readonly text: string };

/** The revision Editar starts from (B): its block, XML and revision count. */
interface EditBase {
  readonly block: DiagramBlockData;
  readonly xml: string;
  readonly revisions: number;
}

/** One edit session, from Editar until Revisar or `fechado`. */
interface EditSession {
  readonly base: EditBase;
  /** The editor's XML kept for a restart or a save (sub-step 3.5): present exactly when modified. */
  readonly memory?: string;
  /** The generation of the current iframe and client; it keys the frame. */
  readonly generation: number;
  /** Whether the iframe is mounted: not while `status()` is pending, nor in `indisponivel` or `salvando`. */
  readonly framed: boolean;
  /** Whether row 18's `getXml` is pending (Salvar disabled meanwhile). */
  readonly reading?: boolean | undefined;
  readonly banner?: EditBanner | undefined;
  /** The highest revision known: B's revision count, raised by each newer `artifacts.revised/v1`. */
  readonly latest: number;
  /** The open exit dialog's destination (rows 14, 15); absent while it is closed. */
  readonly exit?: ExitDestination | undefined;
}

interface EditState {
  readonly phase: EditPhase;
  /** Present in every phase but `revisar`. */
  readonly session?: EditSession;
}

const REVISAR: EditState = { phase: { kind: 'revisar' } };

/** A `DrawioError` that never counts as a failure: a restart, or a closed client. */
const ignorable = (error: unknown) =>
  error instanceof DrawioError &&
  (error.code === 'restarted' || error.code === 'closed');

interface EditMachine {
  readonly state: EditState;
  /** Rows 4, 5: Editar on `base`, from `revisar`. */
  readonly edit: (base: EditBase) => void;
  /** Rows 4, 9, 19: the editor of `generation` sent `init`. */
  readonly init: (generation: number, client: EditorClient) => void;
  /** Rows 16, 17, 18: an editor event of `generation` (`autosave`, `shortcut save`). */
  readonly event: (generation: number, event: EditorEvent) => void;
  /** Row 18: Salvar, CmdOrCtrl+S or `shortcut save`, from `editando-modificado`. */
  readonly save: () => void;
  /** Rows 27, 28: Tentar de novo, from `indisponivel`. */
  readonly retry: () => void;
  /** Rows 12, 29: Concluir edição or Voltar; row 14 while modified. */
  readonly leave: () => void;
  /** Rows 6, 13, 30: a close request; row 15 while modified, ignored in `salvando` (row 26). */
  readonly closeRequest: (reason: CanvasModalCloseReason) => void;
  /** D1: the exit dialog's Salvar. */
  readonly exitSave: () => void;
  /** D2: the exit dialog's Descartar. */
  readonly exitDiscard: () => void;
  /** D3: Continuar editando, Esc or the dialog's backdrop. */
  readonly exitContinue: () => void;
}

/**
 * Editar's state machine (spec "Máquina de estados do modal do diagrama");
 * `-modificado` and `indisponivel` with XML hold the memory, an unsaved edit:
 * - Row 4: Editar asks `drawio.svg/v1.status()`; available mounts the frame
 *   (`carregando`), whose every `init` loads the memory, else B's XML, with
 *   `autosave: true`. Row 5: unavailable or rejected → `indisponivel`, no
 *   client.
 * - Rows 7, 8: a load answering in `carregando*` → `editando*`. Row 9:
 *   `init` in `carregando*` loads again (the deadline stays). Rows 19, 20:
 *   `init` in `editando*` → `carregando*`, loading again and re-arming the
 *   deadline; with the memory, the "restarted" banner.
 * - Rows 10, 11: no load within EDITOR_LOAD_TIMEOUT_MS of entering
 *   `carregando*` with a frame, or a load rejection → `indisponivel`; the
 *   frame goes, which closes its client. Rows 21, 22: in `editando*`, every
 *   EDITOR_HEARTBEAT_MS a `getXml`, one at a time; its rejection →
 *   `indisponivel`. The memory stays.
 * - Rows 16, 17: `autosave` in `editando*` keeps its XML as the memory →
 *   `editando-modificado`. Row 18: Salvar, CmdOrCtrl+S or `shortcut save`
 *   there reads `getXml()` into the memory, then `salvando` (destination
 *   `revisar`) with the frame gone and `drawio.diagrams/v1.save`. Row 23:
 *   its answer → `revisar` on the answered revision (`onSaved`). Row 24:
 *   destination `fechado` → `onCloseRequest(reason)`. Row 25: a rejection →
 *   `carregando-modificado` in a new frame, with the save-error banner.
 *   Row 26: `salvando` ignores close requests.
 * - Rows 12, 29: Concluir edição or Voltar without the memory → `revisar`.
 *   Rows 6, 13, 30: a close request without it reaches `fechado`:
 *   `onCloseRequest(reason)`. Rows 27, 28: Tentar de novo → a new frame,
 *   `carregando*`.
 * - Rows 14, 15: with the memory, Concluir edição or Voltar opens the exit
 *   dialog towards `revisar`, a close request towards `fechado` (with its
 *   reason); the phase stays, and keeps taking its events (D4). D1 Salvar:
 *   `salvando` with the memory and the dialog's destination, no `getXml`.
 *   D2 Descartar: the memory forgotten, the frame gone, then the
 *   destination. D3 Continuar editando: the dialog closes.
 * - Revisions watch (C9): `latest` starts at B's revision count; while the
 *   phase is neither `revisar` nor `salvando`, and the scope names a Thread
 *   whose `runtime.threads/v1` resolves, `watchArtifactRevisions` raises it
 *   to each higher revision of the artifact. Released in `salvando`,
 *   `revisar` and on unmount; resumed with the editor (row 25).
 * - DrawioError `restarted` and `closed` are never failures; answers of an
 *   older generation (an earlier frame, or a session left) are ignored.
 */
const useEditMachine = (
  services: Services,
  scope: DiagramScope | undefined,
  onCloseRequest: (reason: CanvasModalCloseReason) => void,
  onSaved: (base: EditBase, saved: DiagramSaved) => void,
): EditMachine => {
  const [state, setState] = useState<EditState>(REVISAR);
  const stateRef = useRef(state);
  const generationRef = useRef(0);
  const clientRef = useRef<EditorClient | undefined>(undefined);
  const heartbeatPendingRef = useRef(false);
  const servicesRef = useRef(services);
  const scopeRef = useRef(scope);
  const onCloseRef = useRef(onCloseRequest);
  const onSavedRef = useRef(onSaved);

  servicesRef.current = services;
  scopeRef.current = scope;
  onCloseRef.current = onCloseRequest;
  onSavedRef.current = onSaved;

  const actions = useMemo(() => {
    const go = (next: EditState) => {
      stateRef.current = next;
      setState(next);
    };
    // A new generation: earlier answers and the earlier client no longer count.
    const nextGeneration = () => {
      generationRef.current += 1;
      clientRef.current = undefined;
      heartbeatPendingRef.current = false;

      return generationRef.current;
    };
    const isCurrent = (generation: number) =>
      generation === generationRef.current;
    const fail = (cause: UnavailableCause) => {
      const { session } = stateRef.current;

      if (session === undefined) return;

      nextGeneration();
      go({
        phase: { kind: 'indisponivel', cause },
        session: {
          ...session,
          framed: false,
          reading: false,
          banner: undefined,
        },
      });
    };
    // Row 18: the editor's XML read, the frame gone, `save` with the window's scope.
    const save = () => {
      const { phase, session } = stateRef.current;
      const client = clientRef.current;

      if (
        phase.kind !== 'editando' ||
        session === undefined ||
        session.memory === undefined ||
        session.reading === true ||
        client === undefined
      ) {
        return;
      }

      const generation = session.generation;

      go({ phase, session: { ...session, reading: true } });
      // The read's answer, if still current: `then` in `editando`, else the read ends.
      const settle = (then: (session: EditSession) => void) => {
        const current = stateRef.current;

        if (!isCurrent(generation) || current.session === undefined) return;
        if (current.phase.kind === 'editando') {
          then(current.session);
        } else {
          go({ ...current, session: { ...current.session, reading: false } });
        }
      };

      client.getXml().then(
        (xml) =>
          settle((current) => store(current, xml, { destination: 'revisar' })),
        (error: unknown) =>
          settle((current) =>
            ignorable(error)
              ? go({ phase, session: { ...current, reading: false } })
              : fail('not-answering'),
          ),
      );
    };
    // Rows 18, 23, 24, 25 and D1: `salvando` with `xml` as the memory, then the answer.
    const store = (
      session: EditSession,
      xml: string,
      destination: ExitDestination,
    ) => {
      const generation = nextGeneration();
      const saving: EditSession = {
        ...session,
        memory: xml,
        generation,
        framed: false,
        reading: false,
        banner: undefined,
        exit: undefined,
      };
      const scope = scopeRef.current;

      go({ phase: { kind: 'salvando', ...destination }, session: saving });
      servicesRef.current
        .use(
          DrawioDiagramsV1,
          scope === undefined ? undefined : callScopeOf(scope),
        )
        .save({ artifactId: session.base.block.artifactId, xml })
        .then(
          (saved) => {
            if (!isCurrent(generation)) return;

            nextGeneration();
            go(REVISAR);
            if (destination.destination === 'fechado') {
              onCloseRef.current(destination.reason);
            } else {
              onSavedRef.current(session.base, saved);
            }
          },
          (error: unknown) => {
            if (!isCurrent(generation)) return;

            go({
              phase: { kind: 'carregando', modified: true },
              session: {
                ...saving,
                generation: nextGeneration(),
                framed: true,
                banner: { kind: 'save-error', text: saveErrorOf(error) },
              },
            });
          },
        );
    };
    // Rows 14, 15: the exit dialog over the phase, which stays; one at a time.
    const ask = (session: EditSession, exit: ExitDestination) => {
      if (session.exit !== undefined) return;
      go({ phase: stateRef.current.phase, session: { ...session, exit } });
    };
    const load = (generation: number, client: EditorClient, xml: string) => {
      client.load({ xml, autosave: true }).then(
        () => {
          const { phase, session } = stateRef.current;

          if (!isCurrent(generation) || session === undefined) return;
          if (phase.kind !== 'carregando') return;

          go({
            phase: {
              kind: 'editando',
              modified: session.memory !== undefined,
            },
            session,
          });
        },
        (error: unknown) => {
          if (!isCurrent(generation) || ignorable(error)) return;
          if (stateRef.current.phase.kind === 'carregando') {
            fail('load-failed');
          }
        },
      );
    };

    return {
      fail,
      isCurrent,
      edit: (base: EditBase) => {
        if (stateRef.current.phase.kind !== 'revisar') return;

        const generation = nextGeneration();
        const session: EditSession = {
          base,
          generation,
          framed: false,
          latest: base.revisions,
        };

        go({ phase: { kind: 'carregando', modified: false }, session });
        servicesRef.current
          .use(DrawioSvgV1)
          .status()
          .then(
            (status) => {
              if (!isCurrent(generation)) return;
              if (!status.available) {
                fail(
                  status.reason === 'handler-failed'
                    ? 'handler-failed'
                    : 'missing-assets',
                );

                return;
              }

              go({
                phase: stateRef.current.phase,
                session: { ...session, framed: true },
              });
            },
            () => {
              if (isCurrent(generation)) fail('status-failed');
            },
          );
      },
      init: (generation: number, client: EditorClient) => {
        const { phase, session } = stateRef.current;

        if (!isCurrent(generation) || session === undefined) return;

        clientRef.current = client;
        if (phase.kind === 'editando') {
          const modified = session.memory !== undefined;

          go({
            phase: { kind: 'carregando', modified },
            session: modified
              ? { ...session, banner: { kind: 'restarted' } }
              : session,
          });
        } else if (phase.kind !== 'carregando') {
          return;
        }
        load(generation, client, session.memory ?? session.base.xml);
      },
      event: (generation: number, event: EditorEvent) => {
        if (!isCurrent(generation)) return;
        if (event.event === 'shortcut') {
          if ('command' in event && event.command === 'save') save();

          return;
        }

        const { phase, session } = stateRef.current;

        if (
          event.event !== 'autosave' ||
          !('xml' in event) ||
          typeof event.xml !== 'string' ||
          phase.kind !== 'editando' ||
          session === undefined
        ) {
          return;
        }
        go({
          phase: { kind: 'editando', modified: true },
          session: { ...session, memory: event.xml },
        });
      },
      save,
      retry: () => {
        const { phase, session } = stateRef.current;

        if (phase.kind !== 'indisponivel' || session === undefined) return;

        const generation = nextGeneration();

        go({
          phase: { kind: 'carregando', modified: session.memory !== undefined },
          session: { ...session, generation, framed: true, reading: false },
        });
      },
      leave: () => {
        const { phase, session } = stateRef.current;

        if (session === undefined || phase.kind === 'salvando') return;
        if (session.memory !== undefined) {
          ask(session, { destination: 'revisar' });

          return;
        }
        nextGeneration();
        go(REVISAR);
      },
      closeRequest: (reason: CanvasModalCloseReason) => {
        const { phase, session } = stateRef.current;

        if (phase.kind === 'salvando') return;
        if (session?.memory !== undefined) {
          ask(session, { destination: 'fechado', reason });

          return;
        }
        if (phase.kind !== 'revisar') nextGeneration();
        onCloseRef.current(reason);
      },
      exitSave: () => {
        const { session } = stateRef.current;

        if (session?.exit === undefined || session.memory === undefined) {
          return;
        }
        store(session, session.memory, session.exit);
      },
      exitDiscard: () => {
        const exit = stateRef.current.session?.exit;

        if (exit === undefined) return;
        nextGeneration();
        go(REVISAR);
        if (exit.destination === 'fechado') onCloseRef.current(exit.reason);
      },
      exitContinue: () => {
        const { phase, session } = stateRef.current;

        if (session?.exit === undefined) return;
        go({ phase, session: { ...session, exit: undefined } });
      },
      // C9: a revision of the artifact, heard by the watch of `base`'s session.
      revised: (base: EditBase, revision: number) => {
        const { phase, session } = stateRef.current;

        if (session?.base !== base || revision <= session.latest) return;
        go({ phase, session: { ...session, latest: revision } });
      },
    };
  }, []);

  const generation = state.session?.generation;
  const loading =
    state.phase.kind === 'carregando' && state.session?.framed === true;
  const editing = state.phase.kind === 'editando';

  // Row 10: the load deadline, armed on entering `carregando` with a frame.
  useEffect(() => {
    if (!loading || generation === undefined) return;

    const timer = setTimeout(() => {
      if (
        actions.isCurrent(generation) &&
        stateRef.current.phase.kind === 'carregando'
      ) {
        actions.fail('load-failed');
      }
    }, EDITOR_LOAD_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [actions, loading, generation]);

  // Row 21: the heartbeat, only in `editando`, one `getXml` at a time.
  useEffect(() => {
    if (!editing || generation === undefined) return;

    const timer = setInterval(() => {
      const client = clientRef.current;

      if (client === undefined || heartbeatPendingRef.current) return;

      heartbeatPendingRef.current = true;
      client.getXml().then(
        () => {
          if (actions.isCurrent(generation)) {
            heartbeatPendingRef.current = false;
          }
        },
        (error: unknown) => {
          if (!actions.isCurrent(generation)) return;

          heartbeatPendingRef.current = false;
          if (ignorable(error)) return;
          if (stateRef.current.phase.kind === 'editando') {
            actions.fail('not-answering');
          }
        },
      );
    }, EDITOR_HEARTBEAT_MS);

    return () => clearInterval(timer);
  }, [actions, editing, generation]);

  // C9: the revisions watch, while the editor is (or may come back) on screen.
  const base = state.session?.base;
  const watching =
    state.phase.kind !== 'revisar' && state.phase.kind !== 'salvando';
  const projectId = scope?.projectId;
  const threadId = scope?.threadId;

  useEffect(() => {
    if (
      !watching ||
      base === undefined ||
      projectId === undefined ||
      threadId === undefined
    ) {
      return;
    }

    const threadScope = { projectId, threadId };
    let source: ThreadWatchSource;
    let connection: DoricConnection | undefined;

    try {
      source = servicesRef.current.use(RuntimeThreadsV1, threadScope);
    } catch {
      return;
    }

    try {
      connection = servicesRef.current.use(DoricConnectionV1);
    } catch {
      connection = undefined;
    }

    return watchArtifactRevisions(
      source,
      connection,
      threadScope,
      base.block.artifactId,
      (revision) => actions.revised(base, revision),
    );
  }, [actions, watching, base, projectId, threadId]);

  return { state, ...actions };
};

/** The words of `indisponivel` for its cause. */
const unavailableReasonOf = (cause: UnavailableCause): string => {
  switch (cause) {
    case 'missing-assets':
      return 'O editor de diagramas não está instalado neste app';
    case 'handler-failed':
      return 'O editor de diagramas não pôde ser iniciado';
    case 'status-failed':
      return 'Não foi possível verificar o editor de diagramas';
    case 'load-failed':
      return 'O editor não carregou o diagrama';
    case 'not-answering':
      return 'O editor parou de responder';
  }
};

/** Row 25's banner: the lease phrase for `unavailable` with `details.lease`, else the error's message. */
const saveErrorOf = (error: unknown): string => {
  if (
    error instanceof ContractError &&
    error.code === 'unavailable' &&
    typeof error.details === 'object' &&
    error.details !== null &&
    'lease' in error.details
  ) {
    return 'O Project está sem sandbox ativo; a edição continua aqui, e Salvar tenta de novo';
  }

  return `Não foi possível salvar: ${error instanceof Error ? error.message : String(error)}`;
};

/** The words of a banner over the editor. */
const bannerTextOf = (banner: EditBanner): string =>
  banner.kind === 'restarted'
    ? 'O editor reiniciou; a edição voltou do último salvamento automático'
    : banner.text;

const noop = () => undefined;

/**
 * Editar: the editor's header (B's title and revision, no Comentar or
 * Enviar); between it and the toolbar band, the editor (`EditorFrame`, one
 * per generation), the `indisponivel` panel or `salvando`'s "Salvando…"; the
 * banners (the newer revision in `carregando*` and `editando*`, C9; rows 20,
 * 25); then `EditToolbar`, hidden in `indisponivel` and `salvando`; and the
 * exit dialog while it is open. Of the editor's events only `autosave` and
 * `shortcut save` count (`openLink` and `exit` are ignored).
 */
function EditView({
  drawing,
  phase,
  session,
  machine,
}: {
  readonly drawing: DiagramDrawing;
  readonly phase: EditPhase;
  readonly session: EditSession;
  readonly machine: EditMachine;
}): ReactElement {
  const theme = useAppTheme();
  const modified = session.memory !== undefined;
  const { generation } = session;
  const editorPhase = phase.kind === 'carregando' || phase.kind === 'editando';
  const newer = editorPhase && session.latest > session.base.block.revision;
  const banner =
    session.banner === undefined || phase.kind === 'indisponivel'
      ? undefined
      : session.banner;

  return (
    <div className="relative h-full w-full overflow-hidden bg-card">
      <CanvasHeader
        host="modal"
        title={session.base.block.title}
        revision={session.base.block.revision}
        controls={false}
        canExpand={false}
        onExpand={noop}
        commentActive={false}
        canComment={false}
        commentCount={0}
        onToggleComment={noop}
        draftCount={0}
        onSend={noop}
      />

      <div className="absolute inset-x-0 top-9 bottom-14">
        {phase.kind === 'indisponivel' ? (
          <div
            data-testid="drawio-editor-unavailable"
            className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground text-sm"
          >
            <p>{unavailableReasonOf(phase.cause)}</p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="drawio-editor-retry"
                onClick={machine.retry}
              >
                Tentar de novo
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid="drawio-editor-back"
                onClick={machine.leave}
              >
                Voltar
              </Button>
            </div>
          </div>
        ) : session.framed ? (
          <EditorFrame
            key={generation}
            drawing={drawing}
            theme={theme}
            onInit={(client) => machine.init(generation, client)}
            onEvent={(event) => machine.event(generation, event)}
          />
        ) : phase.kind === 'salvando' ? (
          <div
            data-testid="drawio-saving"
            className="flex h-full items-center justify-center text-muted-foreground text-sm"
          >
            Salvando…
          </div>
        ) : null}
      </div>

      {banner === undefined && !newer ? null : (
        <div className="absolute inset-x-0 top-9 z-20 flex flex-col">
          {newer ? (
            <div
              role="status"
              data-testid="drawio-banner-newer"
              className={BANNER_CLASS}
            >
              {`A revisão ${String(session.latest)} foi publicada depois da revisão ${String(session.base.block.revision)}, de onde esta edição parte`}
            </div>
          ) : null}
          {banner === undefined ? null : (
            <div
              role="status"
              data-testid={
                banner.kind === 'restarted'
                  ? 'drawio-banner-restarted'
                  : 'drawio-banner-save-error'
              }
              className={BANNER_CLASS}
            >
              {bannerTextOf(banner)}
            </div>
          )}
        </div>
      )}

      {editorPhase ? (
        <EditToolbar
          canSave={
            phase.kind === 'editando' && modified && session.reading !== true
          }
          onSave={machine.save}
          onDone={machine.leave}
        />
      ) : null}

      {session.exit === undefined ? null : (
        <ExitDialog
          onSave={machine.exitSave}
          onDiscard={machine.exitDiscard}
          onContinue={machine.exitContinue}
        />
      )}
    </div>
  );
}

const BANNER_CLASS =
  'border-b bg-muted px-3 py-1.5 text-muted-foreground text-xs';

/**
 * The exit dialog (rows 14, 15; D1–D3): an alert dialog over the editor,
 * inside the modal's panel, with its own backdrop. It opens with the focus on
 * Continuar editando; Esc reaches the modal's `onKeyDown` (D3).
 */
function ExitDialog({
  onSave,
  onDiscard,
  onContinue,
}: {
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  readonly onContinue: () => void;
}): ReactElement {
  const continueRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    continueRef.current?.focus();
  }, []);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center">
      <div
        data-testid="drawio-exit-backdrop"
        aria-hidden="true"
        className="absolute inset-0 bg-black/40"
        onClick={onContinue}
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="drawio-exit-title"
        aria-describedby="drawio-exit-description"
        data-testid="drawio-exit-dialog"
        className="relative flex w-80 flex-col gap-3 rounded-xl bg-card p-4 text-sm ring-1 ring-foreground/10"
      >
        <h2 id="drawio-exit-title" className="font-medium">
          Salvar as alterações?
        </h2>
        <p id="drawio-exit-description" className="text-muted-foreground">
          A edição tem alterações que ainda não foram salvas.
        </p>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            data-testid="drawio-exit-discard"
            onClick={onDiscard}
          >
            Descartar
          </Button>
          <Button
            ref={continueRef}
            variant="outline"
            size="sm"
            data-testid="drawio-exit-continue"
            onClick={onContinue}
          >
            Continuar editando
          </Button>
          <Button size="sm" data-testid="drawio-exit-save" onClick={onSave}>
            Salvar
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The export dialog's step: editing the path, an answer pending, or `exists` asking Substituir. */
interface ExportState {
  readonly path: string;
  readonly step: 'edit' | 'busy' | 'exists';
  /** In `exists`: the files that are there. */
  readonly files?: readonly string[] | undefined;
  /** The SVG rendered for the last Salvar, reused by Substituir. */
  readonly svg?: string | undefined;
  readonly message?: string | undefined;
}

/** Spec "Exportar" step 4: the words of a `blocked` answer, with its path. */
const blockedMessageOf = (
  result: Extract<ExportResult, { status: 'blocked' }>,
): string => {
  switch (result.reason) {
    case 'directory':
      return `Já existe uma pasta em ${result.path}; escolha outro caminho`;
    case 'special':
      return `${result.path} não é um arquivo comum; escolha outro caminho`;
    case 'not-a-folder':
      return `${result.path} existe e não é uma pasta; escolha outro caminho`;
  }
};

/** Step 6: the lease phrase for `unavailable` with `details.lease` (Q5), else the error's message. */
const exportErrorOf = (error: unknown): string => {
  if (
    error instanceof ContractError &&
    error.code === 'unavailable' &&
    typeof error.details === 'object' &&
    error.details !== null &&
    'lease' in error.details
  ) {
    return 'O Project está sem sandbox ativo; tente de novo quando ele voltar';
  }

  return `Não foi possível salvar no Project: ${error instanceof Error ? error.message : String(error)}`;
};

/**
 * Salvar no Project (spec "Exportar"): a dialog over Revisar, inside the
 * modal's panel, with its own backdrop. The path starts at
 * `defaultExportPath(title)` and has the focus. Salvar renders page 1 of
 * `xml` as light `xmlsvg` and exports it with `overwrite: false`; `written`
 * toasts and closes, `exists` lists the files and offers Substituir (the same
 * SVG, `overwrite: true`), `blocked` and rejections show their words. While
 * an answer is pending every button is disabled and Esc and the backdrop do
 * nothing; otherwise Esc (taken), the backdrop and Cancelar call `onClose`.
 */
function ExportDialog({
  services,
  scope,
  drawing,
  artifactId,
  revision,
  xml,
  title,
  onClose,
}: {
  readonly services: Services;
  readonly scope: DiagramScope;
  readonly drawing: DiagramDrawing;
  readonly artifactId: string;
  readonly revision: number;
  readonly xml: string;
  readonly title: string;
  readonly onClose: () => void;
}): ReactElement {
  const [state, setState] = useState<ExportState>(() => ({
    path: defaultExportPath(title),
    step: 'edit',
  }));
  const pathRef = useRef<HTMLInputElement>(null);
  const busy = state.step === 'busy';

  useEffect(() => {
    pathRef.current?.focus();
  }, []);

  const close = () => {
    if (!busy) onClose();
  };
  const settle = (path: string, svg: string, result: ExportResult) => {
    switch (result.status) {
      case 'written':
        toast(`Gravado em ${path}.drawio e .drawio.svg`);
        onClose();
        return;
      case 'exists':
        setState({ path, step: 'exists', files: result.files, svg });
        return;
      case 'blocked':
        setState({ path, step: 'edit', message: blockedMessageOf(result) });
        return;
    }
  };
  const write = (path: string, svg: string, overwrite: boolean) => {
    services
      .use(DrawioDiagramsV1, callScopeOf(scope))
      .export({ artifactId, revision, path, svg, overwrite })
      .then(
        (result) => settle(path, svg, result),
        (error: unknown) =>
          setState({ path, step: 'edit', message: exportErrorOf(error) }),
      );
  };
  const confirm = () => {
    if (busy) return;

    const { path } = state;

    setState({ path, step: 'busy' });
    drawing.render({ xml, theme: 'light', format: 'xmlsvg' }).then(
      (svg) => write(path, svg, false),
      () =>
        setState({
          path,
          step: 'edit',
          message: 'O diagrama não pôde ser desenhado',
        }),
    );
  };
  const replace = () => {
    const { path, step, svg } = state;

    if (step !== 'exists' || svg === undefined) return;

    setState({ ...state, step: 'busy' });
    write(path, svg, true);
  };
  const editPath = (path: string) => {
    setState(
      state.step === 'exists' ? { path, step: 'edit' } : { ...state, path },
    );
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center">
      <div
        data-testid="drawio-export-backdrop"
        aria-hidden="true"
        className="absolute inset-0 bg-black/40"
        onClick={close}
      />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawio-export-title"
        aria-describedby="drawio-export-hint"
        data-testid="drawio-export-dialog"
        className="relative flex w-96 flex-col gap-3 rounded-xl bg-card p-4 text-sm ring-1 ring-foreground/10"
        onSubmit={(event) => {
          event.preventDefault();
          confirm();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || busy) return;
          event.preventDefault();
          onClose();
        }}
      >
        <h2 id="drawio-export-title" className="font-medium">
          Salvar no Project
        </h2>
        <Input
          ref={pathRef}
          aria-label="Caminho"
          data-testid="drawio-export-path"
          value={state.path}
          onChange={(event) => editPath(event.currentTarget.value)}
        />
        <p
          id="drawio-export-hint"
          data-testid="drawio-export-hint"
          className="text-muted-foreground"
        >
          {`Grava ${state.path}.drawio, com todas as páginas, e ${state.path}.drawio.svg, só com a página 1`}
        </p>
        {state.step === 'exists' && state.files !== undefined ? (
          <div data-testid="drawio-export-existing">
            <p>Já existem no Project:</p>
            <ul className="list-disc pl-5">
              {state.files.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {state.message === undefined ? null : (
          <p
            role="alert"
            data-testid="drawio-export-message"
            className="text-destructive"
          >
            {state.message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="drawio-export-cancel"
            disabled={busy}
            onClick={close}
          >
            Cancelar
          </Button>
          {state.step === 'exists' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="drawio-export-replace"
              onClick={replace}
            >
              Substituir
            </Button>
          ) : null}
          <Button
            type="submit"
            size="sm"
            data-testid="drawio-export-confirm"
            disabled={busy}
          >
            Salvar
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Editar's bar: Salvar (only in `editando-modificado`, no read pending) and Concluir edição. */
function EditToolbar({
  canSave,
  onSave,
  onDone,
}: {
  readonly canSave: boolean;
  readonly onSave: () => void;
  readonly onDone: () => void;
}): ReactElement {
  return (
    <CanvasToolbar
      label="Editar"
      data-testid="drawio-edit-toolbar"
      className="absolute bottom-4 left-1/2 z-30 -translate-x-1/2"
    >
      <ToolbarButton
        label="Salvar"
        shortcut="CmdOrCtrl+S"
        data-testid="drawio-save"
        disabled={!canSave}
        onClick={onSave}
      >
        <SaveIcon aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton
        label="Concluir edição"
        data-testid="drawio-done"
        onClick={onDone}
      >
        <CheckIcon aria-hidden="true" />
      </ToolbarButton>
    </CanvasToolbar>
  );
}

/**
 * The artifact's revisions, read once per mount and again on `reload` (row
 * 23); empty until (or unless) they arrive. Only the latest read's answer
 * counts.
 */
const useRevisionRecords = (
  services: Services,
  scope: DiagramScope | undefined,
  artifactId: string,
): {
  readonly records: readonly ArtifactRecord[];
  readonly reload: () => void;
} => {
  const [records, setRecords] = useState<readonly ArtifactRecord[]>([]);
  const readRef = useRef(0);
  // The scope as dependencies: its identity may change on every render.
  const projectId = scope?.projectId;
  const threadId = scope?.threadId;

  const read = useCallback(() => {
    readRef.current += 1;
    if (projectId === undefined) return;

    const current = readRef.current;

    services
      .use(
        ArtifactsV1,
        callScopeOf({
          projectId,
          ...(threadId === undefined ? {} : { threadId }),
        }),
      )
      .revisions({ artifactId })
      .then(
        (list) => {
          if (current === readRef.current) setRecords(list);
        },
        () => undefined,
      );
  }, [services, projectId, threadId, artifactId]);

  useEffect(() => {
    read();

    return () => {
      readRef.current += 1;
    };
  }, [read]);

  return { records, reload: read };
};

/** Revisar's bar: tools, view, the page and revision menus, and Editar. */
function ReviewToolbar({
  controls,
  pages,
  pageId,
  onPage,
  records,
  revision,
  onRevision,
  canEdit,
  onEdit,
  canExport,
  onExport,
}: {
  readonly controls: DiagramCanvasControls;
  readonly pages: readonly DiagramPage[];
  readonly pageId: string | undefined;
  readonly onPage: (page: DiagramPage) => void;
  readonly records: readonly ArtifactRecord[];
  readonly revision: number;
  readonly onRevision: (record: ArtifactRecord) => void;
  readonly canEdit: boolean;
  readonly onEdit: () => void;
  readonly canExport: boolean;
  readonly onExport: () => void;
}): ReactElement {
  const pageAt = pages.findIndex((page) => page.id === pageId);

  return (
    <CanvasToolbar
      label="Revisar"
      data-testid="drawio-toolbar"
      className="absolute bottom-4 left-1/2 z-30 -translate-x-1/2"
    >
      <ToolbarGroup label="Ferramenta">
        <ToolButton
          controls={controls}
          tool="select"
          label="Selecionar"
          shortcut="V"
        >
          <MousePointer2Icon aria-hidden="true" />
        </ToolButton>
        <ToolButton
          controls={controls}
          tool="comment"
          label="Comentar"
          shortcut="C"
        >
          <MessageSquarePlusIcon aria-hidden="true" />
        </ToolButton>
        <ToolButton controls={controls} tool="pan" label="Mão" shortcut="H">
          <HandIcon aria-hidden="true" />
        </ToolButton>
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup label="Vista">
        <ToolbarButton
          label="Menos zoom"
          shortcut="CmdOrCtrl+-"
          onClick={controls.zoomOut}
        >
          <ZoomOutIcon aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="Zoom 100%"
          shortcut="CmdOrCtrl+0"
          size="sm"
          className="min-w-12 px-1.5 font-mono text-xs tabular-nums"
          onClick={controls.zoomReset}
        >
          {`${String(controls.zoom)}%`}
        </ToolbarButton>
        <ToolbarButton
          label="Mais zoom"
          shortcut="CmdOrCtrl+="
          onClick={controls.zoomIn}
        >
          <ZoomInIcon aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="Ajustar"
          shortcut="Shift+1"
          onClick={controls.zoomFit}
        >
          <MaximizeIcon aria-hidden="true" />
        </ToolbarButton>
      </ToolbarGroup>

      {pages.length > 1 ? (
        <>
          <ToolbarSeparator />
          <Menu
            label="Página"
            reading={`pág ${String(pageAt + 1)}/${String(pages.length)}`}
          >
            {pages.map((page, index) => (
              <DropdownMenuItem key={page.id} onClick={() => onPage(page)}>
                {page.name === '' ? `Página ${String(index + 1)}` : page.name}
                {index === pageAt ? <CheckIcon aria-hidden="true" /> : null}
              </DropdownMenuItem>
            ))}
          </Menu>
        </>
      ) : null}

      {records.length > 1 ? (
        <>
          <ToolbarSeparator />
          <Menu
            label="Revisão"
            reading={`rev ${String(revision)}/${String(records.length)}`}
          >
            {records.map((record) => (
              <DropdownMenuItem
                key={record.revision}
                onClick={() => onRevision(record)}
              >
                {`rev ${String(record.revision)}`}
                {record.revision === revision ? (
                  <CheckIcon aria-hidden="true" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </Menu>
        </>
      ) : null}

      <ToolbarSeparator />

      <ToolbarButton
        label="Editar"
        shortcut="E"
        data-testid="drawio-edit"
        disabled={!canEdit}
        onClick={onEdit}
      >
        <PencilIcon aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton
        label="Salvar no Project"
        data-testid="drawio-export"
        disabled={!canExport}
        onClick={onExport}
      >
        <FolderDownIcon aria-hidden="true" />
      </ToolbarButton>
    </CanvasToolbar>
  );
}

/** One tool of the Ferramenta group: pressed while armed. */
function ToolButton({
  controls,
  tool,
  label,
  shortcut,
  children,
}: {
  readonly controls: DiagramCanvasControls;
  readonly tool: CanvasTool;
  readonly label: string;
  readonly shortcut: string;
  readonly children: ReactNode;
}): ReactElement {
  const pressed = controls.tool === tool;

  return (
    <ToolbarButton
      label={label}
      shortcut={shortcut}
      aria-pressed={pressed}
      variant={pressed ? 'secondary' : 'ghost'}
      disabled={tool === 'comment' && !controls.canComment}
      onClick={() => controls.setTool(tool)}
    >
      {children}
    </ToolbarButton>
  );
}

/** A toolbar menu: its trigger shows `reading`, named by `label`. */
function Menu({
  label,
  reading,
  children,
}: {
  readonly label: string;
  readonly reading: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={label}
            className="min-w-16 font-mono text-xs tabular-nums"
          />
        }
      >
        {reading}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What a key in Revisar does, besides the canvas's own keys. */
export type ReviewKey =
  | 'select'
  | 'pan'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'zoom-fit'
  | 'edit';

/**
 * The Revisar key of a chord: plain `V` → select, plain `H` → pan, plain
 * `E` → edit (any case; no Shift); CmdOrCtrl (exactly one of Meta/Ctrl)
 * with `=` or `+` → zoom-in, `-` → zoom-out, `code === 'Digit0'` →
 * zoom-reset; `Shift` with `code === 'Digit1'` and no CmdOrCtrl → zoom-fit.
 * Undefined when
 * `defaultPrevented`, with `Alt`, with Meta and Ctrl together, or
 * unmatched. `C`, `Esc` and Space are the canvas's (undefined here). Pure.
 */
export const reviewKeyOf: (event: {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly defaultPrevented: boolean;
}) => ReviewKey | undefined = (event) => {
  if (event.defaultPrevented || event.altKey) return undefined;

  const cmdOrCtrl = event.metaKey !== event.ctrlKey;

  if ((event.metaKey || event.ctrlKey) && !cmdOrCtrl) return undefined;

  const key = event.key.toLowerCase();

  // `+` takes Shift on a US layout: CmdOrCtrl+Shift+= is zoom-in too.
  if (cmdOrCtrl && key === '+') return 'zoom-in';
  if (cmdOrCtrl && !event.shiftKey) {
    if (key === '=') return 'zoom-in';
    if (key === '-') return 'zoom-out';
    if (event.code === 'Digit0') return 'zoom-reset';

    return undefined;
  }
  if (cmdOrCtrl) return undefined;
  if (event.shiftKey) {
    return event.code === 'Digit1' ? 'zoom-fit' : undefined;
  }
  if (key === 'v') return 'select';
  if (key === 'h') return 'pan';
  if (key === 'e') return 'edit';

  return undefined;
};

/**
 * Whether a chord is Salvar's: CmdOrCtrl+S — exactly one of Meta/Ctrl, no
 * Alt, no Shift, `key` `s` in any case. False when `defaultPrevented`. Pure;
 * never throws.
 */
export const isSaveChord: (event: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly defaultPrevented: boolean;
}) => boolean = (event) =>
  !event.defaultPrevented &&
  event.metaKey !== event.ctrlKey &&
  !event.altKey &&
  !event.shiftKey &&
  event.key.toLowerCase() === 's';

/**
 * The dialog's starting path: `docs/diagrams/<slug>`, where the slug is the
 * title transliterated (NFD, combining marks removed), in lower case, with
 * every run of characters outside [a-z0-9] replaced by one `-`, without `-`
 * at either end; an empty slug is `diagrama`. Pure. Examples:
 * `'Ação de Pedido'` → `docs/diagrams/acao-de-pedido`,
 * `'日本語'` → `docs/diagrams/diagrama`.
 */
export const defaultExportPath: (title: string) => string = (title) => {
  const slug = title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `docs/diagrams/${slug === '' ? 'diagrama' : slug}`;
};

/**
 * The block of revision `record.revision` for the canvas: `block`'s
 * `projectId`, `threadId` and `title`; `record`'s `artifactId`, `revision`
 * and `changeNote` (when present); `sha256` from the `record.entries` item
 * whose `path` is DIAGRAM_ENTRY (absent without one — then nothing is read).
 * Pure.
 */
export const revisionBlockOf: (
  record: Pick<
    ArtifactRecord,
    'artifactId' | 'revision' | 'entries' | 'changeNote'
  >,
  block: DiagramBlockData,
) => DiagramBlockData = (record, block) => {
  const sha256 = record.entries.find(
    (entry) => entry.path === DIAGRAM_ENTRY,
  )?.sha256;

  return {
    ...(block.projectId === undefined ? {} : { projectId: block.projectId }),
    ...(block.threadId === undefined ? {} : { threadId: block.threadId }),
    artifactId: record.artifactId,
    revision: record.revision,
    title: block.title,
    ...(record.changeNote === undefined
      ? {}
      : { changeNote: record.changeNote }),
    ...(sha256 === undefined ? {} : { sha256 }),
  };
};
