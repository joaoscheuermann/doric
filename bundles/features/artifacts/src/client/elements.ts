// The `artifacts` client elements.
//
// `<artifacts-node>` is the registry's generic frame, as
// `docs/architecture/bundles/artifacts.md` states it: the title, the kind, the
// revision reading, and the comment gesture with the count of what is still
// pending — the same in every artifact. The kind would render the body; a
// kind without a renderer of its own (an orphan, or one whose bundle projects
// and renders its own blocks) reads here as the entries the revision named,
// with no body canvas — the frame never invents one.
//
// `<artifacts-revisions>` is the revision list: one row per revision, with its
// change note, its entries and the comments still pending on it, read through
// `artifacts/v1`. Any surface a bundle composes — the node, a window, a
// panel — mounts it with the `artifactId`.
//
// The classes are made inside factories the activation calls, so importing
// this module touches no DOM global; every element extends `HTMLElement`, and
// the window's `ui/v1` attaches the services of this bundle to each instance
// it creates.

import type { Services } from 'bundle/contracts';

import { ArtifactsV1, type ArtifactTarget } from '../contracts/index.js';
import { CommentsV1, type CommentTargetKey } from './comments-contract.js';
import type { ArtifactFrameData } from './projector.js';

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
  '.artifacts-frame { display: flex; flex-direction: column; gap: 8px; }',
  '.artifacts-bar { display: flex; align-items: center; gap: 8px; }',
  '.artifacts-title { font-weight: 600; }',
  '.artifacts-kind { opacity: 0.7; }',
  '.artifacts-revision { opacity: 0.7; font-variant-numeric: tabular-nums; }',
  '.artifacts-comment { margin-left: auto; }',
  '.artifacts-entries { display: grid; gap: 2px; }',
  '.artifacts-entry { font: 12px/1.6 monospace; opacity: 0.8; word-break: break-all; }',
  '.artifacts-orphan { opacity: 0.7; font-style: italic; }',
  '.artifacts-revisions { display: grid; gap: 4px; }',
  '.artifacts-revision-row { display: flex; gap: 8px; align-items: baseline; font-variant-numeric: tabular-nums; }',
  '.artifacts-revision-note { opacity: 0.8; }',
  '.artifacts-missing { opacity: 0.7; }',
].join('\n');

const sheet = (root: ShadowRoot): void => {
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.append(style);
};

/** The pieces a frame keeps after it builds its shadow tree. */
interface FrameView {
  readonly title: HTMLElement;
  readonly kind: HTMLElement;
  readonly revision: HTMLElement;
  readonly comment: HTMLButtonElement;
  readonly entries: HTMLElement;
  readonly orphan: HTMLElement;
}

/** What `<artifacts-node>` builds once, and re-renders on every input. */
const buildFrame = (root: ShadowRoot): FrameView => {
  sheet(root);

  const frame = element('div', 'artifacts-frame');
  const bar = element('div', 'artifacts-bar');
  const title = element('span', 'artifacts-title');
  const kind = element('span', 'artifacts-kind');
  const revision = element('span', 'artifacts-revision');
  const comment = button('artifacts-comment', 'Comentar');
  const entries = element('div', 'artifacts-entries');
  const orphan = element('div', 'artifacts-orphan');
  orphan.hidden = true;

  bar.append(title, kind, revision, comment);
  frame.append(bar, entries, orphan);
  root.append(frame);

  return { title, kind, revision, comment, entries, orphan };
};

/** The frame data off a block chat hands an element, else undefined. */
const frameDataOf = (block: unknown): ArtifactFrameData | undefined => {
  if (typeof block !== 'object' || block === null) return undefined;

  const data = (block as { readonly data?: unknown }).data;

  if (typeof data !== 'object' || data === null) return undefined;

  const value = data as Record<string, unknown>;
  const artifactId = value.artifactId;
  const revision = value.revision;
  const kind = value.kind;

  if (
    typeof artifactId !== 'string' ||
    artifactId === '' ||
    typeof revision !== 'number' ||
    Number.isInteger(revision) === false ||
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
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    targets: Array.isArray(value.targets)
      ? (value.targets as readonly ArtifactTarget[])
      : [],
    entries: Array.isArray(value.entries) ? value.entries : [],
    ...(typeof value.changeNote === 'string'
      ? { changeNote: value.changeNote }
      : {}),
    ...(typeof value.createdAt === 'string'
      ? { createdAt: value.createdAt }
      : {}),
  } as ArtifactFrameData;
};

/**
 * The count of comments still pending on one revision, read through the
 * comments registry — the same state the artifact's own reducer folds from
 * the log, read where the registry keeps it.
 */
const pendingComments = async (
  services: Services,
  target: CommentTargetKey,
): Promise<number> => {
  try {
    const comments = await services.use(CommentsV1).list({ target });

    return comments.filter((comment) => !comment.resolved).length;
  } catch {
    // The comments registry is another bundle's; a composition without it
    // counts nothing rather than fails the frame.
    return 0;
  }
};

/** `<artifacts-node>`: the registry's generic frame, one block of the log. */
export const defineFrameElement = () =>
  class ArtifactsFrameElement extends HTMLElement {
    #services: Services | undefined;
    #block: unknown;
    #view: FrameView | undefined;
    #token = 0;

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

    async #render(): Promise<void> {
      const data = frameDataOf(this.#block);

      if (data === undefined) return;
      if (this.#view === undefined) this.#view = buildFrame(this.#shadow());
      const view = this.#view;

      view.title.textContent = data.title ?? data.artifactId;
      view.kind.textContent = data.kind;
      view.revision.textContent = `rev ${data.revision}`;

      // The revision the event named, as the registry still keeps it: the
      // reading the frame shows, and where a later revision exists.
      view.comment.onclick = () => {
        this.dispatchEvent(
          new CustomEvent('artifacts:comment', {
            detail: {
              artifactId: data.artifactId,
              revision: data.revision,
            },
            bubbles: true,
            composed: true,
          }),
        );
      };

      view.entries.replaceChildren();

      for (const entry of data.entries) {
        const row = element('div', 'artifacts-entry');
        row.textContent = `${entry.path} · ${entry.sha256.slice(0, 12)}`;
        view.entries.append(row);
      }

      view.orphan.hidden = data.entries.length > 0;
      view.orphan.textContent =
        'Sem renderizador para este tipo: a revisão nomeou o que existiu.';

      if (this.#services === undefined) return;

      this.#token += 1;
      const token = this.#token;
      const pending = await pendingComments(this.#services, {
        kind: 'artifact',
        id: data.artifactId,
        revision: data.revision,
      });

      if (token !== this.#token) return;

      view.comment.textContent =
        pending > 0 ? `Comentar (${pending})` : 'Comentar';
    }
  };

/** The pieces a revision list keeps after it builds its shadow tree. */
interface RevisionsView {
  readonly rows: HTMLElement;
}

/** What `<artifacts-revisions>` builds once, and re-renders on input. */
const buildRevisions = (root: ShadowRoot): RevisionsView => {
  sheet(root);

  const rows = element('div', 'artifacts-revisions');
  root.append(rows);

  return { rows };
};

/**
 * `<artifacts-revisions>`: one row per revision of an artifact — the revision
 * reading, its change note, its entries and its pending comments — read
 * through `artifacts/v1`, which is where the registry keeps every revision.
 */
export const defineRevisionsElement = () =>
  class ArtifactsRevisionsElement extends HTMLElement {
    #services: Services | undefined;
    #artifactId: string | undefined;
    #view: RevisionsView | undefined;
    #token = 0;

    set services(value: Services | undefined) {
      this.#services = value;
      void this.#render();
    }

    get services(): Services | undefined {
      return this.#services;
    }

    set artifactId(value: string | undefined) {
      this.#artifactId = value;
      void this.#render();
    }

    get artifactId(): string | undefined {
      return this.#artifactId;
    }

    #shadow(): ShadowRoot {
      return (this.shadowRoot ??
        this.attachShadow({ mode: 'open' })) as ShadowRoot;
    }

    async #render(): Promise<void> {
      const artifactId = this.#artifactId;
      const services = this.#services;

      if (artifactId === undefined || services === undefined) return;

      if (this.#view === undefined) {
        this.#view = buildRevisions(this.#shadow());
      }
      const view = this.#view;

      this.#token += 1;
      const token = this.#token;

      const newest = await services
        .use(ArtifactsV1)
        .read({ artifactId }, undefined);

      if (token !== this.#token) return;

      view.rows.replaceChildren();

      if (newest === undefined) {
        const missing = element('div', 'artifacts-missing');
        missing.textContent = `Artefato ${artifactId} não está mais disponível.`;
        view.rows.append(missing);

        return;
      }

      for (let revision = 1; revision <= newest.revisions; revision += 1) {
        const record = await services
          .use(ArtifactsV1)
          .read({ artifactId, revision }, undefined);

        if (token !== this.#token || record === undefined) continue;

        const row = element('div', 'artifacts-revision-row');
        const reading = element('span', 'artifacts-revision');
        reading.textContent = `rev ${revision}/${newest.revisions}`;
        row.append(reading);

        if (record.changeNote !== undefined) {
          const note = element('span', 'artifacts-revision-note');
          note.textContent = record.changeNote;
          row.append(note);
        }

        const pending = await pendingComments(services, {
          kind: 'artifact',
          id: artifactId,
          revision,
        });

        if (token !== this.#token) return;

        if (pending > 0) {
          const count = element('span', 'artifacts-revision-note');
          count.textContent = `${pending} comentário${pending === 1 ? '' : 's'} pendente${pending === 1 ? '' : 's'}`;
          row.append(count);
        }

        if (record.state === 'approved') {
          const approved = element('span', 'artifacts-revision-note');
          approved.textContent = 'autorizado';
          row.append(approved);
        }

        view.rows.append(row);
      }
    }
  };
