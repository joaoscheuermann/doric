// The `<drawio-diagram>` harness the client tests share (plan §3, "Tests"):
// the two-page fixture and its page-1 drawing, every host service faked at
// its boundary — `drawio.svg/v1` (a cache with a first-page pointer),
// `drawio.diagrams/v1` (per revision), `artifacts/v1.revisions` (three
// records), `comments/v1`, `chat.composer/v1`, `chat.send/v1`,
// `runtime.threads/v1`, `doric.connection/v1` — a fake `DiagramDrawing`,
// mounting through `defineDiagramElement`, and the gestures the tests make.
// Call `loadClient()` in a `before` hook and `unmountAll()` in `afterEach`.
// Phase 3: the modal editor's client (`fakeEditor`, in `fakeDrawing().editor`),
// `drawio.diagrams/v1.save` (`h.saves`, `h.saveScript`, `h.pendingSaves`),
// live Thread events (`h.log`, `h.push`, `revisedOf`) and `withMockTimers`.
// Phase 4: `drawio.diagrams/v1.export` (`h.exports`, `h.exportScript`,
// `h.exportDefault`, `h.pendingExports`), reads that never answer
// (`h.readsPending`), and the renderer's `xmlsvg` export (`XMLSVG`).

import { type MockTimers, mock } from 'node:test';

import {
  type Services,
  type StreamListener,
  toStreamObserver,
} from 'bundle/contracts';

import type {
  EditorClient,
  EditorClientOptions,
  EditorEvent,
} from '../../../src/client/editor-frame.js';
import type {
  DiagramExportInput,
  ExportResult,
} from '../../../src/contracts/index.js';
import { installReactDom, window } from './dom.js';

installReactDom();

export type React = typeof import('react');
export type Comment = typeof import('../../../src/client/comment.js');
export type Elements = typeof import('../../../src/client/elements.js');
export type View = typeof import('../../../src/client/diagram-view.js');
export type Index = typeof import('../../../src/client/index.js');
export type Drawing = typeof import('../../../src/client/drawing.js');
export type SinglePage = typeof import('../../../src/client/single-page.js');
export type Modal = typeof import('../../../src/client/diagram-modal.js');
export type Data = typeof import('../../../src/client/diagram-data.js');
export type EditorFrameModule =
  typeof import('../../../src/client/editor-frame.js');

export let react: React;
export let comment: Comment;
export let elements: Elements;
export let view: View;
export let index: Index;
export let drawingModule: Drawing;
export let singlePage: SinglePage;
export let modal: Modal;
export let dataModule: Data;
export let editorFrame: EditorFrameModule;

/**
 * Two pages, nine cells. Page `p1`: vertex `a` ("A"), vertex `b` ("B"), the
 * connector `e` ("liga") from `a` to `b`, and two vertices labelled "Twin"
 * (`t1`, `t2`). Page `p2`: three vertices and a connector.
 */
export const XML = `<mxfile host="test">
  <diagram id="p1" name="Um">
    <mxGraphModel>
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="a" value="A" vertex="1" parent="1">
          <mxGeometry x="20" y="20" width="100" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="b" value="B" vertex="1" parent="1">
          <mxGeometry x="300" y="20" width="100" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="e" value="liga" edge="1" source="a" target="b" parent="1">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="t1" value="Twin" vertex="1" parent="1">
          <mxGeometry x="20" y="200" width="100" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="t2" value="Twin" vertex="1" parent="1">
          <mxGeometry x="300" y="200" width="100" height="60" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
  <diagram id="p2" name="Dois">
    <mxGraphModel>
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="c" value="C" vertex="1" parent="1">
          <mxGeometry x="0" y="0" width="80" height="40" as="geometry"/>
        </mxCell>
        <mxCell id="d" value="D" vertex="1" parent="1">
          <mxGeometry x="200" y="0" width="80" height="40" as="geometry"/>
        </mxCell>
        <mxCell id="f" value="F" vertex="1" parent="1">
          <mxGeometry x="400" y="0" width="80" height="40" as="geometry"/>
        </mxCell>
        <mxCell id="g" value="segue" edge="1" source="c" target="d" parent="1">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

export const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="280"><g data-cell-id="a"/></svg>';

export interface Box {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const BOXES: Record<string, Box> = {
  a: { id: 'a', x: 20, y: 20, width: 100, height: 60 },
  b: { id: 'b', x: 300, y: 20, width: 100, height: 60 },
  e: { id: 'e', x: 120, y: 40, width: 180, height: 20 },
  t1: { id: 't1', x: 20, y: 200, width: 100, height: 60 },
  t2: { id: 't2', x: 300, y: 200, width: 100, height: 60 },
};

/** Page `p1` as the measure frame lays it out. */
export const LAYOUT = {
  width: 420,
  height: 280,
  cells: Object.values(BOXES),
};

export const ENTRY = { svg: SVG, layout: LAYOUT };

/** Page `p2`'s drawing: what the fake renderer answers for `pageId: 'p2'`. */
export const SVG_P2 =
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="40"><g data-cell-id="c"/></svg>';

export const BOXES_P2: Record<string, Box> = {
  c: { id: 'c', x: 0, y: 0, width: 80, height: 40 },
  d: { id: 'd', x: 200, y: 0, width: 80, height: 40 },
  f: { id: 'f', x: 400, y: 0, width: 80, height: 40 },
  g: { id: 'g', x: 80, y: 10, width: 120, height: 20 },
};

/** Page `p2` as the measure frame lays it out. */
export const LAYOUT_P2 = {
  width: 480,
  height: 40,
  cells: Object.values(BOXES_P2),
};

export const ENTRY_P2 = { svg: SVG_P2, layout: LAYOUT_P2 };

/**
 * What the fake renderer answers for `format: 'xmlsvg'`: page 1 with the
 * diagram embedded in `content`, as an `xmlsvg` export holds it.
 */
export const XMLSVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="280" content="&lt;mxfile&gt;&lt;/mxfile&gt;"><g data-cell-id="a"/></svg>';

/** Revision 1 of the diagram: the same two pages, `a` labelled "A0". */
export const XML_R1 = XML.replace('value="A"', 'value="A0"');

/** Revision 3 of the diagram: the same two pages, `b` labelled "B3". */
export const XML_R3 = XML.replace('value="B"', 'value="B3"');

export const ARTIFACT = 'flow';
export const TITLE = 'Fluxo';

/** The SHA-256 of `XML`, as the artifacts payload names it. */
export let SHA = '';
/** The SHA-256 of `XML_R1` and of `XML_R3`. */
export let SHA_R1 = '';
export let SHA_R3 = '';

/** The diagram's three revisions, as `artifacts/v1.revisions` lists them (oldest first). */
export const recordsOf = () =>
  [
    { revision: 1, sha256: SHA_R1 },
    { revision: 2, sha256: SHA },
    { revision: 3, sha256: SHA_R3 },
  ].map(({ revision, sha256 }) => ({
    artifactId: ARTIFACT,
    kind: 'diagram',
    title: TITLE,
    revision,
    revisions: 3,
    entries: [{ path: 'diagram.drawio', sha256 }],
    ...(revision === 1 ? {} : { changeNote: `nota ${String(revision)}` }),
    state: 'open' as const,
    createdAt: '2026-10-01T00:00:00Z',
  }));

/**
 * The diagram's revisions after a save wrote revision 4 holding a diagram whose
 * SHA-256 is `sha256`: `recordsOf()` (each now counting 4), then revision 4
 * with the user's note.
 */
export const recordsThrough4 = (
  sha256: string,
): ReturnType<typeof recordsOf> => {
  const records = recordsOf().map((record) => ({ ...record, revisions: 4 }));

  return [
    ...records,
    ...records
      .filter((record) => record.revision === 3)
      .map((record) => ({
        ...record,
        revision: 4,
        entries: [{ path: 'diagram.drawio', sha256 }],
        changeNote: 'Editado pelo usuário',
      })),
  ];
};

/** The block the registry's frame hands the body (`ArtifactFrameData`). */
export const blockOf = (data: Record<string, unknown> = {}) => ({
  id: `artifacts:${ARTIFACT}@2`,
  type: 'drawio.diagram/v1',
  data: {
    artifactId: ARTIFACT,
    revision: 2,
    kind: 'diagram',
    title: TITLE,
    targets: [],
    entries: [{ path: 'diagram.drawio', sha256: SHA }],
    createdAt: '2026-10-01T00:00:00Z',
    projectId: 'p1',
    threadId: 't-1',
    ...data,
  },
});

/** A durable comment on revision 1 of the diagram, as the log and `list` hold it. */
export const durable = (commentId: string, anchor: unknown, text: string) => ({
  commentId,
  target: { kind: 'artifact', id: ARTIFACT, revision: 1, anchor },
  text,
  resolved: false,
  createdAt: '2026-10-01T00:00:00Z',
});

/** The log of the diagram's Thread holding `comments`, in order. */
export const logOf = (comments: readonly ReturnType<typeof durable>[]) =>
  comments.map((added, at) => ({
    sequence: at + 1,
    promptId: 'prompt-1',
    type: 'comments.added/v1',
    event: added,
    createdAt: added.createdAt,
  }));

/* Fakes ----------------------------------------------------------------------- */

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });

  return { promise, resolve, reject };
};

export type Outcome = 'resolve' | 'reject' | 'pending';

/** One request a fake editor client was asked, and the answer the test gives it. */
export interface Pending<Request, T> {
  readonly request: Request;
  readonly answer: Deferred<T>;
  /** Whether the test has resolved or rejected it. */
  settled: boolean;
}

/** One client `createEditorClient` made, as the fake records it. */
export interface FakeEditorClient {
  readonly iframe: HTMLIFrameElement;
  readonly options: EditorClientOptions;
  /** The client handed to `onInit`. */
  readonly client: EditorClient;
  /** Every `load` call, oldest first; each answer is left for the test. */
  readonly loads: Pending<
    { readonly xml: string; readonly autosave: true },
    unknown
  >[];
  /** Every `getXml` call, oldest first; each answer is left for the test. */
  readonly getXmls: Pending<undefined, string>[];
  /** How many times `close()` was called. */
  closed: number;
}

const oldestUnsettled = <Request, T>(
  list: Pending<Request, T>[],
  what: string,
): Pending<Request, T> => {
  const pending = list.find((entry) => !entry.settled);

  if (pending === undefined) throw new Error(`no pending ${what}`);
  pending.settled = true;

  return pending;
};

/**
 * The modal editor's `DrawioClient`, faked at the iframe boundary: `create`
 * (what `DiagramDrawing.createEditorClient` calls) records each client; the
 * helpers act on the latest client unless given one, inside React's `act`:
 * `init` calls its `onInit`, `emit` its `onEvent`; `resolveLoad`/`rejectLoad`
 * settle its oldest unsettled `load`, `answerXml`/`failXml` its oldest
 * unsettled `getXml`.
 */
export const fakeEditor = () => {
  const clients: FakeEditorClient[] = [];

  const last = (): FakeEditorClient => {
    const client = clients.at(-1);

    if (client === undefined) throw new Error('no editor client was created');

    return client;
  };
  const settle = async (run: () => void) => {
    await react.act(async () => {
      run();
      await Promise.resolve();
    });
  };

  return {
    clients,
    last,
    create(
      iframe: HTMLIFrameElement,
      options: EditorClientOptions,
    ): EditorClient {
      const record: FakeEditorClient = {
        iframe,
        options,
        loads: [],
        getXmls: [],
        closed: 0,
        client: {
          load: (request) => {
            const answer = deferred<unknown>();
            record.loads.push({ request, answer, settled: false });

            return answer.promise;
          },
          getXml: () => {
            const answer = deferred<string>();
            record.getXmls.push({ request: undefined, answer, settled: false });

            return answer.promise;
          },
          close: () => {
            record.closed += 1;
          },
        },
      };
      clients.push(record);

      return record.client;
    },
    init: (at: FakeEditorClient = last()) =>
      settle(() => at.options.onInit(at.client)),
    emit: (event: EditorEvent & Record<string, unknown>, at = last()) =>
      settle(() => at.options.onEvent(event)),
    resolveLoad: (value: unknown = { event: 'load' }, at = last()) =>
      settle(() => oldestUnsettled(at.loads, 'load').answer.resolve(value)),
    rejectLoad: (error: unknown, at = last()) =>
      settle(() => oldestUnsettled(at.loads, 'load').answer.reject(error)),
    answerXml: (xml: string, at = last()) =>
      settle(() => oldestUnsettled(at.getXmls, 'getXml').answer.resolve(xml)),
    failXml: (error: unknown, at = last()) =>
      settle(() => oldestUnsettled(at.getXmls, 'getXml').answer.reject(error)),
  };
};

/**
 * Runs `run` with `node:test`'s mock timers enabled for `apis` (default
 * `setTimeout` and `setInterval`), and resets them afterwards whatever
 * happens. `until` polls with `setTimeout`, so it hangs while that API is
 * mocked: advance with `timers.tick` instead.
 */
export const withMockTimers = async <T>(
  run: (timers: MockTimers) => Promise<T>,
  apis: ('setTimeout' | 'setInterval' | 'Date')[] = [
    'setTimeout',
    'setInterval',
  ],
): Promise<T> => {
  mock.timers.enable({ apis });
  try {
    return await run(mock.timers);
  } finally {
    mock.timers.reset();
  }
};

/**
 * The renderer and the measure frame: each call is recorded; `render` answers
 * the next scripted outcome (`resolve` once the script runs out: `SVG_P2`
 * for page `p2`, else `SVG`), `measure` resolves `LAYOUT_P2` for `SVG_P2`,
 * else `LAYOUT`. A pending render is left for the test to settle. A
 * `format: 'xmlsvg'` request resolves `XMLSVG`. `script` stays live: an
 * outcome pushed later answers a later render.
 */
export const fakeDrawing = (script: Outcome[] = []) => {
  const renders: {
    pageId?: string;
    theme: string;
    xml?: string;
    format?: string;
  }[] = [];
  const measures: string[] = [];
  const pending: Deferred<string>[] = [];
  const editor = fakeEditor();

  return {
    script,
    renders,
    measures,
    pending,
    /** The modal editor's clients (`createEditorClient`). */
    editor,
    drawing: {
      createEditorClient: (
        iframe: HTMLIFrameElement,
        options: EditorClientOptions,
      ) => editor.create(iframe, options),
      render: (request: {
        pageId?: string;
        theme: string;
        xml?: string;
        format?: string;
      }) => {
        renders.push(request);
        const outcome = script.shift() ?? 'resolve';

        if (outcome === 'resolve') {
          if (request.format === 'xmlsvg') return Promise.resolve(XMLSVG);

          return Promise.resolve(request.pageId === 'p2' ? SVG_P2 : SVG);
        }
        if (outcome === 'reject') {
          return Promise.reject(
            new singlePage.RenderError('unavailable', 'the editor is gone'),
          );
        }

        const later = deferred<string>();
        pending.push(later);

        return later.promise;
      },
      measure: (svg: string, theme: string) => {
        measures.push(theme);

        return Promise.resolve(svg === SVG_P2 ? LAYOUT_P2 : LAYOUT);
      },
    },
  };
};

export type ReadAnswer =
  | { status: 'ok'; xml: string; revision: number; revisions: number }
  | { status: 'missing' }
  | { status: 'unleased'; lease: 'missing' };

export const OK: ReadAnswer = {
  status: 'ok',
  xml: XML,
  revision: 2,
  revisions: 2,
};

/** The pages the cache holds, and each revision's first-page pointer. */
export const fakeCache = () => {
  const entries = new Map<string, { svg: string; layout: unknown }>();
  const pointers = new Map<string, string>();
  const revisionKey = (key: {
    artifactId: string;
    revision: number;
    sha256: string;
  }) => `${key.artifactId}@${String(key.revision)}/${key.sha256}`;
  const entryKey = (
    key: { artifactId: string; revision: number; sha256: string },
    pageId: string,
    theme: string,
  ) => `${revisionKey(key)}/${pageId}.${theme}`;

  return {
    /** Stores one page (`ENTRY` unless told), and the pointer when `first`, as a `put` would. */
    seed(
      key: { artifactId: string; revision: number; sha256: string },
      pageId: string,
      theme: string,
      first: boolean,
      entry: { svg: string; layout: unknown } = ENTRY,
    ) {
      entries.set(entryKey(key, pageId, theme), entry);
      if (first) pointers.set(revisionKey(key), pageId);
    },
    get(lookup: {
      artifactId: string;
      revision: number;
      sha256: string;
      pageId?: string;
      theme: string;
    }) {
      const pageId = lookup.pageId ?? pointers.get(revisionKey(lookup));

      if (pageId === undefined) return null;

      const entry = entries.get(entryKey(lookup, pageId, lookup.theme));

      return entry === undefined ? null : { ...entry, pageId };
    },
    put(input: {
      artifactId: string;
      revision: number;
      sha256: string;
      pageId: string;
      theme: string;
      svg: string;
      layout: unknown;
      first?: true;
    }) {
      entries.set(entryKey(input, input.pageId, input.theme), {
        svg: input.svg,
        layout: input.layout,
      });
      if (input.first === true) pointers.set(revisionKey(input), input.pageId);
    },
  };
};

export type StackItem = {
  id: string;
  kind: string;
  elementTag: string;
  data: unknown;
  note: string;
};

/** Chat's composer stack: records every `addItem`, watch answers a snapshot first. */
export const fakeComposer = () => {
  const items: StackItem[] = [];
  const added: {
    threadId: string;
    kind: string;
    elementTag: string;
    data?: unknown;
    note?: string;
  }[] = [];
  const listeners: ((item: unknown) => void)[] = [];
  const emit = (item: unknown) => {
    for (const listener of [...listeners]) listener(item);
  };

  const api = {
    addItem: async (input: (typeof added)[number]) => {
      added.push(input);
      const item: StackItem = {
        id: `i${String(added.length)}`,
        kind: input.kind,
        elementTag: input.elementTag,
        data: input.data,
        note: input.note ?? '',
      };
      items.push(item);
      emit({ kind: 'added', threadId: input.threadId, item });

      return item;
    },
    updateNote: async (input: {
      threadId: string;
      id: string;
      note: string;
    }) => {
      const at = items.findIndex((item) => item.id === input.id);
      const item = items[at];
      if (item === undefined) return;
      items[at] = { ...item, note: input.note };
      emit({ kind: 'updated', threadId: input.threadId, item: items[at] });
    },
    removeItem: async (input: { threadId: string; id: string }) => {
      const at = items.findIndex((item) => item.id === input.id);
      if (at >= 0) items.splice(at, 1);
      emit({ kind: 'removed', threadId: input.threadId, id: input.id });
    },
    watch: (threadId: string, listener: StreamListener<unknown>) => {
      const observer = toStreamObserver(listener);
      const next = (item: unknown) => observer.next(item);
      listeners.push(next);
      next({ kind: 'snapshot', threadId, text: '', items: [...items] });

      return {
        dispose: () => {
          const at = listeners.indexOf(next);
          if (at >= 0) listeners.splice(at, 1);
        },
      };
    },
  };

  return { api, added };
};

/** The host calls that need the Project's lease: refused without a `projectId`. */
const SCOPED = new Set([
  'artifacts/v1',
  'drawio.diagrams/v1',
  'comments/v1',
  'chat.composer/v1',
  'runtime.threads/v1',
]);

export interface Harness {
  readonly services: Services;
  readonly cache: ReturnType<typeof fakeCache>;
  /** Every `drawio.svg/v1.get` input, as the node passed it. */
  readonly gets: Record<string, unknown>[];
  /** Every `drawio.svg/v1.put` input. */
  readonly puts: Record<string, unknown>[];
  /** Every `drawio.diagrams/v1.read` input. */
  readonly reads: unknown[];
  /** What `drawio.diagrams/v1.read` answers for a revision `readsOf` does not name. */
  read: ReadAnswer;
  /** What `drawio.diagrams/v1.read` answers per revision (default: revisions 1 and 3, `ok`). */
  readonly readsOf: Map<number, ReadAnswer>;
  /** Revisions whose `drawio.diagrams/v1.read` never answers. */
  readonly readsPending: Set<number>;
  /** Every `artifacts/v1.revisions` input. */
  readonly revisionCalls: unknown[];
  /** What `artifacts/v1.revisions` answers: the records (default `recordsOf()`), or a rejection. */
  revisions: ReturnType<typeof recordsOf> | 'reject';
  /** Every `chat.send/v1.send` input. */
  readonly sends: unknown[];
  /**
   * What `drawio.svg/v1.status` answers (default: available, `29.0.0`), or
   * `{ reject }`: the error it rejects with.
   */
  svgStatus: SvgStatus | { readonly reject: unknown };
  /** How many times `drawio.svg/v1.status` was called. */
  readonly statusCalls: number;
  /** The durable comments `comments/v1.list` answers and the Thread's log replays. */
  comments: ReturnType<typeof durable>[];
  composer: ReturnType<typeof fakeComposer> | undefined;
  /** Every `drawio.diagrams/v1.save` input. */
  readonly saves: SaveInput[];
  /**
   * What each `drawio.diagrams/v1.save` answers, in order; once it runs out,
   * `save` answers `saveDefault`.
   */
  readonly saveScript: SaveAnswer[];
  /**
   * What `save` answers once `saveScript` is empty (default: `'resolve'`,
   * revision and count 4 with the SHA-256 of the saved XML).
   */
  saveDefault: SaveAnswer;
  /** The answers of `'pending'` saves, oldest first, for the test to settle. */
  readonly pendingSaves: Deferred<DiagramSavedAnswer>[];
  /** Every `drawio.diagrams/v1.export` input. */
  readonly exports: ExportInput[];
  /**
   * What each `drawio.diagrams/v1.export` answers, in order; once it runs
   * out, `export` answers `exportDefault`.
   */
  readonly exportScript: ExportAnswer[];
  /**
   * What `export` answers once `exportScript` is empty (default: `'written'`,
   * `files` `[<path>.drawio, <path>.drawio.svg]` from the input's path).
   */
  exportDefault: ExportAnswer;
  /** The answers of `'pending'` exports, oldest first, for the test to settle. */
  readonly pendingExports: Deferred<ExportResult>[];
  /** Thread log events replayed after the comments' events, in order. */
  log: ThreadLogItem[];
  /** Delivers `event` live to every open `runtime.threads/v1.watchThread`, inside `act`. */
  push(event: ThreadLogItem): Promise<void>;
  /** When `true`, `services.use(runtime.threads/v1)` throws (the contract is not active). */
  threadsUnavailable: boolean;
}

/** A `drawio.diagrams/v1.save` input. */
export interface SaveInput {
  readonly artifactId: string;
  readonly xml: string;
}

/** A `drawio.diagrams/v1.export` input. */
export type ExportInput = DiagramExportInput;

/**
 * One scripted `export` answer: `'written'` (both files of the input's
 * path), a given `ExportResult`, `{ reject }` with the error, or `'pending'`
 * (a deferred pushed to `pendingExports`).
 */
export type ExportAnswer =
  | 'written'
  | 'pending'
  | ExportResult
  | { readonly reject: unknown };

/** A `drawio.diagrams/v1.save` answer (`DiagramSaved`). */
export interface DiagramSavedAnswer {
  readonly revision: number;
  readonly revisions: number;
  readonly sha256: string;
}

/**
 * One scripted `save` answer: `'resolve'` (revision and count 4, the SHA-256
 * of the saved XML), a given `DiagramSaved`, `{ reject }` with the error, or
 * `'pending'` (a deferred pushed to `pendingSaves`).
 */
export type SaveAnswer =
  | 'resolve'
  | 'pending'
  | DiagramSavedAnswer
  | { readonly reject: unknown };

/** One event of a Thread's log, as `watchThread` delivers it. */
export interface ThreadLogItem {
  readonly sequence?: number;
  readonly promptId?: string;
  readonly type: string;
  readonly event: unknown;
  readonly createdAt?: string;
}

let sequences = 1000;

/**
 * An `artifacts.revised/v1` log event: `artifactId` (default `ARTIFACT`)
 * gained `revision`, with a fresh increasing sequence.
 */
export const revisedOf = (
  revision: number,
  artifactId: string = ARTIFACT,
): ThreadLogItem => {
  sequences += 1;

  return {
    sequence: sequences,
    promptId: 'prompt-1',
    type: 'artifacts.revised/v1',
    event: {
      artifactId,
      revision,
      kind: 'diagram',
      title: TITLE,
      targets: [],
      entries: [{ path: 'diagram.drawio', sha256: `sha-${String(revision)}` }],
    },
    createdAt: '2026-10-01T00:00:00Z',
  };
};

/** A `drawio.svg/v1.status` answer. */
export type SvgStatus =
  | { available: true; version: string }
  | { available: false; reason: string };

export const harness = (): Harness => {
  const cache = fakeCache();
  let svgStatus: SvgStatus | { readonly reject: unknown } = {
    available: true,
    version: '29.0.0',
  };
  let statusCalls = 0;
  const gets: Record<string, unknown>[] = [];
  const puts: Record<string, unknown>[] = [];
  const reads: unknown[] = [];
  const revisionCalls: unknown[] = [];
  const sends: unknown[] = [];
  const readsOf = new Map<number, ReadAnswer>([
    [1, { status: 'ok', xml: XML_R1, revision: 1, revisions: 3 }],
    [3, { status: 'ok', xml: XML_R3, revision: 3, revisions: 3 }],
  ]);
  const saves: SaveInput[] = [];
  const saveScript: SaveAnswer[] = [];
  const pendingSaves: Deferred<DiagramSavedAnswer>[] = [];
  const readsPending = new Set<number>();
  const exports: ExportInput[] = [];
  const exportScript: ExportAnswer[] = [];
  const pendingExports: Deferred<ExportResult>[] = [];
  let exportDefault: ExportAnswer = 'written';
  const watchers = new Set<(event: ThreadLogItem) => void>();
  let threadsUnavailable = false;
  const state: Pick<
    Harness,
    'read' | 'comments' | 'composer' | 'revisions' | 'saveDefault' | 'log'
  > = {
    read: OK,
    comments: [],
    composer: undefined,
    revisions: recordsOf(),
    saveDefault: 'resolve',
    log: [],
  };

  const services = {
    provide: () => ({ dispose: () => undefined }),
    whenAvailable: () => ({ dispose: () => undefined }),
    use: (contract: { id?: string }, scope?: { projectId?: string }) => {
      const id = contract.id ?? '';

      if (SCOPED.has(id) && scope?.projectId === undefined) {
        throw new Error(`${id} used without a projectId`);
      }

      switch (id) {
        case 'drawio.svg/v1':
          return {
            status: async () => {
              statusCalls += 1;
              if ('reject' in svgStatus) throw svgStatus.reject;

              return svgStatus;
            },
            get: async (lookup: Record<string, unknown>) => {
              gets.push(lookup);

              return cache.get(lookup as never);
            },
            put: async (input: Record<string, unknown>) => {
              puts.push(input);
              cache.put(input as never);
            },
          };
        case 'drawio.diagrams/v1':
          return {
            read: async (input: { revision?: number }) => {
              reads.push(input);

              if (
                input.revision !== undefined &&
                readsPending.has(input.revision)
              ) {
                return new Promise<never>(() => undefined);
              }

              return (
                (input.revision === undefined
                  ? undefined
                  : readsOf.get(input.revision)) ?? state.read
              );
            },
            save: async (input: SaveInput) => {
              saves.push(input);
              const answer = saveScript.shift() ?? state.saveDefault;

              if (answer === 'resolve') {
                return {
                  revision: 4,
                  revisions: 4,
                  sha256: await drawingModule.sha256Hex(input.xml),
                };
              }
              if (answer === 'pending') {
                const later = deferred<DiagramSavedAnswer>();
                pendingSaves.push(later);

                return later.promise;
              }
              if ('reject' in answer) throw answer.reject;

              return answer;
            },
            export: async (input: ExportInput): Promise<ExportResult> => {
              exports.push(input);
              const answer = exportScript.shift() ?? exportDefault;

              if (answer === 'written') {
                return {
                  status: 'written',
                  files: [`${input.path}.drawio`, `${input.path}.drawio.svg`],
                };
              }
              if (answer === 'pending') {
                const later = deferred<ExportResult>();
                pendingExports.push(later);

                return later.promise;
              }
              if ('reject' in answer) throw answer.reject;

              return answer;
            },
          };
        case 'artifacts/v1':
          return {
            revisions: async (input: unknown) => {
              revisionCalls.push(input);

              if (state.revisions === 'reject') {
                throw new Error('artifacts/v1 is unavailable');
              }

              return state.revisions;
            },
          };
        case 'comments/v1':
          return {
            list: async () => state.comments,
            resolve: async () => undefined,
            add: async () => {
              throw new Error('the node never writes a comment');
            },
          };
        case 'chat.composer/v1':
          if (state.composer === undefined) {
            throw new Error('chat.composer/v1 is not active');
          }

          return state.composer.api;
        case 'chat.send/v1':
          return {
            send: async (input: unknown) => {
              sends.push(input);

              return { status: 'accepted' };
            },
          };
        case 'runtime.threads/v1':
          if (threadsUnavailable) {
            throw new Error('runtime.threads/v1 is not active');
          }

          return {
            watchThread: (
              _input: unknown,
              listener: StreamListener<unknown>,
            ) => {
              const observer = toStreamObserver(listener);
              const live = (event: ThreadLogItem) =>
                observer.next({ kind: 'event', event });
              watchers.add(live);
              observer.next({
                kind: 'snapshot',
                events: [...logOf(state.comments), ...state.log],
              });

              return { dispose: () => watchers.delete(live) };
            },
          };
        case 'doric.connection/v1':
          return {
            status: () => 'connected',
            subscribe: () => ({ dispose: () => undefined }),
          };
        default:
          throw new Error(`unexpected contract ${id}`);
      }
    },
  } as unknown as Services;

  return {
    services,
    cache,
    gets,
    puts,
    reads,
    readsOf,
    revisionCalls,
    sends,
    saves,
    saveScript,
    pendingSaves,
    readsPending,
    exports,
    exportScript,
    pendingExports,
    get exportDefault() {
      return exportDefault;
    },
    set exportDefault(value) {
      exportDefault = value;
    },
    push: async (event: ThreadLogItem) => {
      await react.act(async () => {
        for (const live of [...watchers]) live(event);
      });
    },
    get saveDefault() {
      return state.saveDefault;
    },
    set saveDefault(value) {
      state.saveDefault = value;
    },
    get log() {
      return state.log;
    },
    set log(value) {
      state.log = value;
    },
    get threadsUnavailable() {
      return threadsUnavailable;
    },
    set threadsUnavailable(value) {
      threadsUnavailable = value;
    },
    get svgStatus() {
      return svgStatus;
    },
    set svgStatus(value) {
      svgStatus = value;
    },
    get statusCalls() {
      return statusCalls;
    },
    get revisions() {
      return state.revisions;
    },
    set revisions(value) {
      state.revisions = value;
    },
    get read() {
      return state.read;
    },
    set read(value) {
      state.read = value;
    },
    get comments() {
      return state.comments;
    },
    set comments(value) {
      state.comments = value;
    },
    get composer() {
      return state.composer;
    },
    set composer(value) {
      state.composer = value;
    },
  };
};

/* Mounting -------------------------------------------------------------------- */

export type Body = HTMLElement & {
  services: Services;
  block: unknown;
  dispose(): void;
};

let tags = 0;
const mounted = new Set<Body>();

/** Defines a fresh `<drawio-diagram>` class over `drawing`, mounts it with `block`. */
export const mount = async (
  h: Harness,
  drawing: ReturnType<typeof fakeDrawing>['drawing'],
  block: unknown = blockOf(),
): Promise<Body> => {
  tags += 1;
  const tag = `drawio-diagram-test-${String(tags)}`;
  customElements.define(
    tag,
    elements.defineDiagramElement(
      drawing as unknown as Parameters<Elements['defineDiagramElement']>[0],
    ) as unknown as CustomElementConstructor,
  );

  const body = document.createElement(tag) as Body;
  body.services = h.services;
  body.block = block;
  mounted.add(body);

  await react.act(async () => {
    document.body.append(body);
  });

  return body;
};

export const unmount = async (body: Body) => {
  mounted.delete(body);
  await react.act(async () => {
    body.remove();
    body.dispose();
  });
};

/** Unmounts every body still mounted and resets the theme and the composer. */
export const unmountAll = async (): Promise<void> => {
  for (const body of [...mounted]) await unmount(body);
  document.documentElement.classList.remove('dark');
  try {
    comment.setComposerAvailable(false);
  } catch {
    // Not implemented yet: the test itself already failed on it.
  }
};

/** Polls until `read()` holds, letting React and the fakes run between reads. */
export const until = async <T>(
  read: () => T,
  holds: (value: T) => boolean,
  message: string,
): Promise<T> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();

    if (holds(value)) return value;

    await react.act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
  }

  throw new Error(message);
};

export const query = <T extends Element = HTMLElement>(
  root: ParentNode,
  testId: string,
): T | null => root.querySelector(`[data-testid="${testId}"]`) as T | null;

export const imageOf = (body: Body) =>
  query<HTMLImageElement>(body, 'drawio-diagram-image');

export const shown = (body: Body, testId: string, message: string) =>
  until(
    () => query(body, testId),
    (element) => element !== null,
    message,
  );

export const textOf = (body: Body) => body.textContent ?? '';

/** A press, the way a pointer makes one: down, up, then the click. */
export const press = async (target: Element, x = 0, y = 0) => {
  const init = { bubbles: true, cancelable: true, clientX: x, clientY: y };

  await react.act(async () => {
    target.dispatchEvent(
      new window.PointerEvent('pointerdown', init) as unknown as Event,
    );
    target.dispatchEvent(
      new window.PointerEvent('pointerup', init) as unknown as Event,
    );
    target.dispatchEvent(
      new window.MouseEvent('click', init) as unknown as Event,
    );
  });
};

/**
 * The header's Comentar, once the reader chose the node: the node shows its
 * tools only while it has the focus, so the header is pressed first.
 */
export const commentButton = async (body: Body) => {
  const header = await shown(body, 'papercraft-header', 'no header');
  await press(header as Element);

  return until(
    () => query<HTMLButtonElement>(body, 'papercraft-comment'),
    (button) => button !== null,
    'no Comentar',
  ) as Promise<HTMLButtonElement>;
};

/** Where a pin's tip is: the bottom-left corner of its box. */
export const tipOf = (pin: HTMLElement) => ({
  x: Number.parseFloat(pin.style.left),
  y: Number.parseFloat(pin.style.top) + Number.parseFloat(pin.style.height),
});

export const inside = (point: { x: number; y: number }, box: Box) =>
  point.x >= box.x &&
  point.x <= box.x + box.width &&
  point.y >= box.y &&
  point.y <= box.y + box.height;

export const pinOf = (body: Body, number: number) =>
  body.querySelector(
    `[data-testid="papercraft-pin"][data-pin="${String(number)}"]`,
  ) as HTMLElement | null;

/** Sets a controlled field's value the way typing does. */
export const type = (
  field: HTMLTextAreaElement | HTMLInputElement,
  value: string,
) => {
  Object.getOwnPropertyDescriptor(
    field instanceof window.HTMLInputElement
      ? window.HTMLInputElement.prototype
      : window.HTMLTextAreaElement.prototype,
    'value',
  )?.set?.call(field, value);
  field.dispatchEvent(new window.Event('input', { bubbles: true }) as never);
};

/**
 * The comment gesture: with chat's composer on, the reader arms Comentar,
 * clicks the drawing at (`x`, `y`), writes `note` and confirms it.
 */
export const commentAt = async (
  h: Harness,
  x: number,
  y: number,
  note: string,
) => {
  const composer = fakeComposer();
  h.composer = composer;
  comment.setComposerAvailable(true);
  h.cache.seed(
    { artifactId: ARTIFACT, revision: 2, sha256: SHA },
    'p1',
    'light',
    true,
  );

  const body = await mount(h, fakeDrawing().drawing);
  const image = await shown(body, 'drawio-diagram-image', 'no drawing');
  const button = await commentButton(body);
  await until(
    () => button.disabled,
    (disabled) => !disabled,
    'Comentar never enabled',
  );

  await react.act(async () => button.click());
  await press(image as Element, x, y);

  const field = (await until(
    () =>
      query(body, 'papercraft-comment-input')?.querySelector('textarea') ??
      null,
    (element) => element !== null,
    'no comment input',
  )) as HTMLTextAreaElement;

  await react.act(async () => type(field, note));
  await react.act(async () => {
    field.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }) as never,
    );
  });

  await until(
    () => composer.added.length,
    (length) => length === 1,
    'the note never joined the stack',
  );

  return composer.added[0] as {
    threadId: string;
    kind: string;
    elementTag: string;
    data: {
      target: unknown;
      refs?: unknown;
      point?: unknown;
    };
    note?: string;
  };
};

/** Imports the modules under test (after the DOM is installed) and hashes `XML`. */
export const loadClient = async (): Promise<void> => {
  [
    react,
    comment,
    elements,
    view,
    index,
    drawingModule,
    singlePage,
    modal,
    dataModule,
    editorFrame,
  ] = await Promise.all([
    import('react'),
    import('../../../src/client/comment.js'),
    import('../../../src/client/elements.js'),
    import('../../../src/client/diagram-view.js'),
    import('../../../src/client/index.js'),
    import('../../../src/client/drawing.js'),
    import('../../../src/client/single-page.js'),
    import('../../../src/client/diagram-modal.js'),
    import('../../../src/client/diagram-data.js'),
    import('../../../src/client/editor-frame.js'),
  ]);

  [SHA, SHA_R1, SHA_R3] = await Promise.all(
    [XML, XML_R1, XML_R3].map((xml) => drawingModule.sha256Hex(xml)),
  );
};
