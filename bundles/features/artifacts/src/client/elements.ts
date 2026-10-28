// The `artifacts` client elements.
//
// `<artifacts-node>` is the registry's frame, as
// `docs/architecture/bundles/artifacts.md` states it: "the frame is the
// registry's, the body is the kind's". The frame draws what is the same in
// every artifact — the title, the kind, the revision reading, the review
// state, the authorize gesture (only under `request`) and the comment gesture
// with the count of what is still pending — and mounts
// the kind's body inside it: the element the kind declared as `bodyTag` in
// `artifact.kind/v1`, created with `ui/v1.create(bodyTag, { block })`, where
// `block` is the frame's block with `type` set to the kind's `blockType`. A
// kind without a body (an orphan, or a kind no active bundle declares) reads
// as the entries the revision named — the frame never invents a body.
//
// A kind that declares `header: 'body'` overlays its own header on its body:
// the frame then draws no bar, and keeps only what is the registry's alone —
// `Autorizar` (under `request`, for an open revision) — below the body.
//
// The frame draws no list of revisions: the conversation is the history — one
// frame per revision, where the agent said what changed.
//
// The comment gesture dispatches `artifacts:comment` (bubbling, composed,
// cancelable) with `{ artifactId, revision, kind }`. A surface that composes
// comments takes it and calls `preventDefault()`; otherwise the frame hands
// the gesture to its body, when the body offers `comment(detail)` (the kind
// knows where in its body a comment anchors), and says so when nobody can.
//
// The classes are made inside factories the activation calls, so importing
// this module touches no DOM global; every element extends `HTMLElement`, and
// the window's `ui/v1` attaches the services of this bundle to each instance
// it creates.

import { type CallScope, type Services, UiV1 } from 'bundle/contracts';

import {
  type ArtifactKindDescriptor,
  ArtifactKindV1,
  type ArtifactRecord,
  ArtifactsV1,
  type ArtifactTarget,
} from '../contracts/index.js';
import { type Comment, CommentsV1 } from './comments-contract.js';
import type { ArtifactFrameData } from './projector.js';

/** The frame element tag; every tag this bundle defines carries its prefix. */
export const ARTIFACTS_NODE_TAG = 'artifacts-node';

/** The event the comment gesture dispatches. */
export const ARTIFACTS_COMMENT_EVENT = 'artifacts:comment';

/** What `artifacts:comment` carries. */
export interface ArtifactCommentDetail {
  readonly artifactId: string;
  readonly revision: number;
  readonly kind: string;
}

const element = (name: string, className: string): HTMLElement => {
  const node = document.createElement(name);
  node.className = className;

  return node;
};

const button = (className: string, label: string): HTMLButtonElement => {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;

  return node;
};

const STYLE = [
  ':host { display: block; }',
  // An author `display` would otherwise beat the `hidden` attribute.
  '[hidden] { display: none !important; }',
  '.artifacts-frame { display: flex; flex-direction: column; gap: 8px; }',
  '.artifacts-bar { display: flex; align-items: center; gap: 8px; }',
  '.artifacts-title { font-weight: 400; }',
  '.artifacts-kind { opacity: 0.7; }',
  '.artifacts-revision { opacity: 0.7; font-variant-numeric: tabular-nums; }',
  '.artifacts-state { opacity: 0.7; }',
  '.artifacts-bar button { font: inherit; font-size: 12px; color: inherit; background: transparent; border: 1px solid var(--border, currentColor); border-radius: 6px; padding: 2px 8px; cursor: pointer; }',
  '.artifacts-bar button:hover { background: var(--accent, transparent); }',
  '.artifacts-comment { margin-left: auto; }',
  '.artifacts-below { display: flex; align-items: center; gap: 8px; }',
  '.artifacts-below button { font: inherit; font-size: 12px; color: inherit; background: transparent; border: 1px solid var(--border, currentColor); border-radius: 6px; padding: 2px 8px; cursor: pointer; }',
  '.artifacts-entries { display: grid; gap: 2px; }',
  '.artifacts-entry { font: 12px/1.6 monospace; opacity: 0.8; word-break: break-all; }',
  '.artifacts-orphan, .artifacts-hint { opacity: 0.7; font-style: italic; }',
].join('\n');

const sheet = (root: ShadowRoot): void => {
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.append(style);
};

/**
 * The scope the frame calls the registry and the comments under:
 * the Project and Thread whose log holds the artifact. `comments/v1` refuses a
 * call without a Project, so an element without one counts nothing.
 */
export interface ArtifactViewScope {
  readonly projectId?: string;
  readonly threadId?: string;
}

const callScopeOf = (scope: ArtifactViewScope): CallScope | undefined =>
  scope.projectId === undefined
    ? undefined
    : {
        projectId: scope.projectId,
        ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
      };

/** A service of the window, or undefined when the composition lacks it. */
const tryUse = <T>(use: () => T): T | undefined => {
  try {
    return use();
  } catch {
    return undefined;
  }
};

/**
 * The comments still pending on an artifact, by revision, read through the
 * comments registry in one call. A composition without it counts nothing
 * rather than fails the frame.
 */
const pendingByRevision = async (
  services: Services,
  artifactId: string,
  scope: ArtifactViewScope,
): Promise<ReadonlyMap<number, number>> => {
  const counts = new Map<number, number>();
  const bound = callScopeOf(scope);
  let comments: readonly Comment[] = [];

  if (bound === undefined) return counts;

  try {
    comments = await services
      .use(CommentsV1, bound)
      .list({ target: { kind: 'artifact', id: artifactId } });
  } catch {
    return counts;
  }

  for (const comment of comments) {
    const revision = comment.target?.revision;

    if (comment.resolved || revision === undefined) continue;

    counts.set(revision, (counts.get(revision) ?? 0) + 1);
  }

  return counts;
};

/** The frame data off a block chat hands an element, else undefined. */
const frameDataOf = (block: unknown): ArtifactFrameData | undefined => {
  if (typeof block !== 'object' || block === null) return undefined;

  const data = (block as { readonly data?: unknown }).data;

  if (typeof data !== 'object' || data === null) return undefined;

  const value = data as Record<string, unknown>;
  const { artifactId, revision, kind } = value;

  if (
    typeof artifactId !== 'string' ||
    artifactId === '' ||
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision <= 0 ||
    typeof kind !== 'string' ||
    kind === ''
  ) {
    return undefined;
  }

  return {
    artifactId,
    revision,
    kind,
    title: typeof value.title === 'string' ? value.title : artifactId,
    targets: Array.isArray(value.targets)
      ? (value.targets as readonly ArtifactTarget[])
      : [],
    entries: Array.isArray(value.entries) ? value.entries : [],
    ...(typeof value.changeNote === 'string'
      ? { changeNote: value.changeNote }
      : {}),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    ...(typeof value.projectId === 'string'
      ? { projectId: value.projectId }
      : {}),
    ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}),
  } as ArtifactFrameData;
};

/** The pieces a frame keeps after it builds its shadow tree. */
interface FrameView {
  readonly bar: HTMLElement;
  /** The row under the body that carries `Autorizar` when the body draws the header. */
  readonly below: HTMLElement;
  readonly title: HTMLElement;
  readonly kind: HTMLElement;
  readonly revision: HTMLElement;
  readonly state: HTMLElement;
  readonly authorize: HTMLButtonElement;
  readonly comment: HTMLButtonElement;
  readonly body: HTMLElement;
  readonly entries: HTMLElement;
  readonly orphan: HTMLElement;
  readonly hint: HTMLElement;
}

/** What `<artifacts-node>` builds once, and re-renders on every input. */
const buildFrame = (root: ShadowRoot): FrameView => {
  sheet(root);

  const frame = element('div', 'artifacts-frame');
  const bar = element('div', 'artifacts-bar');
  const title = element('span', 'artifacts-title');
  const kind = element('span', 'artifacts-kind');
  const revision = element('span', 'artifacts-revision');
  const state = element('span', 'artifacts-state');
  const authorize = button('artifacts-authorize', 'Autorizar');
  const comment = button('artifacts-comment', 'Comentar');
  const body = element('div', 'artifacts-body');
  // The kind's body is light DOM slotted here, so the window's sheets (the
  // kind bundle's own utilities and the theme) style it; a node inside this
  // shadow root would be out of their reach.
  body.append(Object.assign(document.createElement('slot'), { name: 'body' }));
  const entries = element('div', 'artifacts-entries');
  const orphan = element('div', 'artifacts-orphan');
  const hint = element('div', 'artifacts-hint');
  const below = element('div', 'artifacts-below');

  authorize.hidden = true;
  below.hidden = true;
  orphan.hidden = true;
  hint.hidden = true;
  orphan.textContent =
    'Sem renderizador para este tipo: a revisão nomeou o que existiu.';
  bar.append(title, kind, revision, state, authorize, comment);
  frame.append(bar, body, entries, orphan, hint, below);
  root.append(frame);

  return {
    bar,
    below,
    title,
    kind,
    revision,
    state,
    authorize,
    comment,
    body,
    entries,
    orphan,
    hint,
  };
};

/** `<artifacts-node>`: the registry's frame around the kind's body. */
export const defineFrameElement = () => {
  // The kinds the host registered are host state, complete before any
  // window client part activates (as the activation's projector claim
  // assumes): one read per window serves every frame, instead of one per
  // frame per render. A read that fails is not kept, so the next render asks
  // again.
  const kindLists = new WeakMap<
    Services,
    Promise<readonly ArtifactKindDescriptor[]>
  >();

  const kindsOf = (
    services: Services,
  ): Promise<readonly ArtifactKindDescriptor[]> => {
    const known = kindLists.get(services);

    if (known !== undefined) return known;

    const pending = (
      tryUse(() => services.use(ArtifactKindV1))?.list() ??
      Promise.resolve([] as readonly ArtifactKindDescriptor[])
    ).catch(() => {
      kindLists.delete(services);

      return [] as readonly ArtifactKindDescriptor[];
    });

    kindLists.set(services, pending);

    return pending;
  };

  return class ArtifactsFrameElement extends HTMLElement {
    #services: Services | undefined;
    #block: unknown;
    #view: FrameView | undefined;
    #token = 0;
    /** Whether a render is under way, and whether another was asked meanwhile. */
    #rendering = false;
    #again = false;
    /** The body element and the key (tag and block id) it was made for. */
    #body: { readonly key: string; readonly node: object } | undefined;

    set services(value: Services | undefined) {
      this.#services = value;
      void this.#render();
    }

    get services(): Services | undefined {
      return this.#services;
    }

    set block(value: unknown) {
      this.#block = value;
      void this.#render();
    }

    get block(): unknown {
      return this.#block;
    }

    #shadow(): ShadowRoot {
      return (this.shadowRoot ??
        this.attachShadow({ mode: 'open' })) as ShadowRoot;
    }

    /** The kind's body, made once per kind tag and block. */
    #mountBody(
      services: Services,
      kind: ArtifactKindDescriptor | undefined,
    ): boolean {
      const tag = kind?.bodyTag;
      const ui = tryUse(() => services.use(UiV1));

      if (tag === undefined || ui === undefined) {
        this.#dropBody();
        return false;
      }

      const block = this.#block as {
        readonly id?: string;
        readonly type?: string;
      };
      const key = `${tag} ${block.id ?? ''}`;

      if (this.#body?.key === key) return true;

      this.#dropBody();

      const node = tryUse(() =>
        ui.create(tag, {
          block: { ...block, type: kind?.blockType ?? block.type },
        }),
      );

      if (node === undefined) return false;

      this.#body = { key, node };
      (node as HTMLElement).slot = 'body';
      this.append(node as Node);

      return true;
    }

    #dropBody(): void {
      if (this.#body === undefined) return;

      const { node } = this.#body;
      this.#body = undefined;
      (node as ChildNode).remove();
      tryUse(() => this.#services?.use(UiV1).dispose(node));
    }

    #comment(view: FrameView, data: ArtifactFrameData): void {
      const detail: ArtifactCommentDetail = {
        artifactId: data.artifactId,
        revision: data.revision,
        kind: data.kind,
      };
      const event = new CustomEvent(ARTIFACTS_COMMENT_EVENT, {
        detail,
        bubbles: true,
        composed: true,
        cancelable: true,
      });

      // A surface that composes comments took the gesture.
      if (!this.dispatchEvent(event)) return;

      const body = this.#body?.node as
        | { comment?: (detail: ArtifactCommentDetail) => void }
        | undefined;

      if (typeof body?.comment === 'function') {
        body.comment(detail);
        view.hint.hidden = true;
        return;
      }

      view.hint.textContent =
        'Este artefato não tem onde ancorar um comentário: comente pela conversa.';
      view.hint.hidden = false;
    }

    /**
     * Renders the frame for its block. The conversation sets the block again
     * on every reading of the log, so renders asked for while one is under
     * way are folded into one more, after it: the frame reads the registry
     * once for the latest block, not once per reading.
     */
    async #render(): Promise<void> {
      if (this.#rendering) {
        this.#again = true;

        return;
      }

      this.#rendering = true;

      try {
        do {
          this.#again = false;
          await this.#draw();
        } while (this.#again);
      } finally {
        this.#rendering = false;
      }
    }

    async #draw(): Promise<void> {
      const data = frameDataOf(this.#block);

      if (data === undefined) return;
      if (this.#view === undefined) this.#view = buildFrame(this.#shadow());
      const view = this.#view;

      view.title.textContent = data.title;
      view.kind.textContent = data.kind;
      view.revision.textContent = `rev ${data.revision}`;
      view.comment.onclick = () => this.#comment(view, data);

      view.entries.replaceChildren();

      for (const entry of data.entries) {
        const row = element('div', 'artifacts-entry');
        row.textContent = `${entry.path} · ${entry.sha256.slice(0, 12)}`;
        view.entries.append(row);
      }

      const services = this.#services;

      if (services === undefined) {
        view.orphan.hidden = false;
        return;
      }

      this.#token += 1;
      const token = this.#token;
      const kinds = await kindsOf(services);

      if (token !== this.#token) return;

      // The body is the kind's; without one, the entries are what the frame
      // can stand behind, and only then is the artifact an orphan. It mounts
      // before the registry answers the rest: the body has its own reads.
      const kind = kinds.find((candidate) => candidate.id === data.kind);
      const bodied = this.#mountBody(services, kind);

      view.entries.hidden = bodied;
      view.orphan.hidden = bodied;

      // A body that draws its own header takes the bar's place: the frame
      // keeps `Autorizar` below the body, beside nothing else of the bar —
      // and counts no comments for a bar it does not draw.
      const bodyHeader = bodied && kind?.header === 'body';

      const bound = callScopeOf(data);
      const artifacts = tryUse(() => services.use(ArtifactsV1, bound));
      const [records, policy, pending] = await Promise.all([
        artifacts
          ?.revisions({ artifactId: data.artifactId })
          .catch(() => [] as readonly ArtifactRecord[]) ??
          Promise.resolve([] as readonly ArtifactRecord[]),
        artifacts?.policy().catch(() => undefined) ??
          Promise.resolve(undefined),
        bodyHeader
          ? Promise.resolve(new Map<number, number>())
          : pendingByRevision(services, data.artifactId, data),
      ]);

      if (token !== this.#token) return;

      const record = records.find(
        (candidate) => candidate.revision === data.revision,
      );
      const approved = record?.state === 'approved';
      const authorizable = policy?.policy === 'request' && !approved;

      view.bar.hidden = bodyHeader;
      if (bodyHeader) view.below.append(view.authorize);
      else view.bar.insertBefore(view.authorize, view.comment);
      view.below.hidden = !bodyHeader || !authorizable;

      view.state.textContent = approved ? 'autorizado' : '';
      view.authorize.hidden = !authorizable;
      view.authorize.onclick = () => {
        view.authorize.disabled = true;
        void artifacts
          ?.approve({ artifactId: data.artifactId, revision: data.revision })
          .catch(() => undefined)
          .finally(() => {
            view.authorize.disabled = false;
            void this.#render();
          });
      };

      const count = pending.get(data.revision) ?? 0;

      view.comment.textContent = count > 0 ? `Comentar (${count})` : 'Comentar';
    }
  };
};
