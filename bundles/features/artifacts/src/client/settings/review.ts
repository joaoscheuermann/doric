// `<artifacts-settings-review>`: the Review section at `/settings/review` —
// the settings window's surface of `artifacts.review-policy/v1` (stage 4 of
// `docs/architecture/bundles/artifacts.md`). `proceed` is the default the
// registry answers when the Project never chose; `request` adds the gate the
// same doc calls the exception, not the rule.
//
// The value never crosses the desktop bridge as `settings/v1` — the core
// keeps that contract out of `desktopScope` — so the section reads and writes
// through `artifacts/v1`, the registry that owns the settings space. The class
// is made inside a factory the activation calls, so importing this module
// touches no DOM global; the window's `ui/v1` attaches this bundle's services
// to each instance it creates.

import type { Services } from 'bundle/contracts';

import {
  type ArtifactReviewPolicyValue,
  ArtifactsV1,
} from '../../contracts/index.js';

/** The policy the radio group offers, in the order the section lists them. */
const POLICIES = [
  {
    policy: 'proceed',
    label: 'Seguir direto',
    description:
      'Publica o artefato e o agente continua; o comentário corrige o rumo na revisão seguinte. É o padrão do Doric.',
  },
  {
    policy: 'request',
    label: 'Pedir revisão',
    description:
      'Publica, devolve o estado e espera a autorização antes de escrever no código do Project. O portão é a exceção, não a regra.',
  },
] as const satisfies readonly {
  readonly policy: ArtifactReviewPolicyValue['policy'];
  readonly label: string;
  readonly description: string;
}[];

const STYLE = [
  ':host { display: block; }',
  '.artifacts-review { display: grid; gap: 16px; }',
  '.artifacts-review-lead { color: var(--muted-foreground, #6b7280); }',
  '.artifacts-policy { display: grid; gap: 8px; border: none; margin: 0; padding: 0; }',
  '.artifacts-policy-choice { display: grid; grid-template-columns: auto 1fr; column-gap: 8px; align-items: start; }',
  '.artifacts-policy-label { font-weight: 500; }',
  '.artifacts-policy-text { color: var(--muted-foreground, #6b7280); font-size: 0.875rem; }',
  '.artifacts-review-error { color: var(--destructive, #dc2626); font-size: 0.875rem; }',
  '.artifacts-review-error[hidden] { display: none; }',
].join('\n');

/** The pieces the section keeps after it builds its shadow tree. */
interface ReviewView {
  readonly choices: ReadonlyMap<
    ArtifactReviewPolicyValue['policy'],
    HTMLInputElement
  >;
  readonly error: HTMLElement;
}

/** What `<artifacts-settings-review>` builds once, then re-renders. */
const buildReview = (root: ShadowRoot): ReviewView => {
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.append(style);

  const frame = document.createElement('div');
  frame.className = 'artifacts-review';

  const lead = document.createElement('p');
  lead.className = 'artifacts-review-lead';
  lead.textContent = 'Como o Project revisa os artefatos que o agente publica.';
  frame.append(lead);

  const group = document.createElement('fieldset');
  group.className = 'artifacts-policy';

  const choices = new Map<
    ArtifactReviewPolicyValue['policy'],
    HTMLInputElement
  >();

  for (const { policy, label, description } of POLICIES) {
    const choice = document.createElement('label');
    choice.className = 'artifacts-policy-choice';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'artifacts-review-policy';
    input.value = policy;
    choices.set(policy, input);

    const text = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'artifacts-policy-label';
    name.textContent = label;
    const note = document.createElement('span');
    note.className = 'artifacts-policy-text';
    note.textContent = description;
    text.append(name, document.createElement('br'), note);

    choice.append(input, text);
    group.append(choice);
  }

  const error = document.createElement('p');
  error.className = 'artifacts-review-error';
  error.hidden = true;

  frame.append(group, error);
  root.append(frame);

  return { choices, error };
};

/**
 * `<artifacts-settings-review>`: the Project's review policy, read and written
 * through `artifacts/v1`. A failed read leaves the choices empty — writing one
 * is still a legitimate recovery, because the write names the whole value; a
 * failed write puts the reading back where the registry keeps it.
 */
export const defineReviewElement = () =>
  class ArtifactsReviewElement extends HTMLElement {
    #services: Services | undefined;
    #view: ReviewView | undefined;
    #value: ArtifactReviewPolicyValue | undefined;
    #token = 0;

    set services(value: Services | undefined) {
      this.#services = value;
      void this.#load();
    }

    get services(): Services | undefined {
      return this.#services;
    }

    #shadow(): ShadowRoot {
      return (this.shadowRoot ??
        this.attachShadow({ mode: 'open' })) as ShadowRoot;
    }

    /** Checks the radio of one policy, clearing every other first. */
    #check(policy: ArtifactReviewPolicyValue['policy']): void {
      for (const [choice, input] of this.#view?.choices ?? []) {
        input.checked = choice === policy;
      }
    }

    async #load(): Promise<void> {
      const services = this.#services;

      if (services === undefined) return;
      if (this.#view === undefined) this.#view = buildReview(this.#shadow());
      const view = this.#view;

      for (const [, input] of view.choices) {
        input.onchange = () =>
          void this.#write(input.value as ArtifactReviewPolicyValue['policy']);
      }

      this.#token += 1;
      const token = this.#token;

      let value: ArtifactReviewPolicyValue;

      try {
        value = await services.use(ArtifactsV1).policy(undefined);
      } catch {
        if (token !== this.#token) return;
        view.error.hidden = false;
        view.error.textContent = 'A política deste Project não pôde ser lida.';

        return;
      }

      if (token !== this.#token) return;

      this.#value = value;
      view.error.hidden = true;
      this.#check(value.policy);
    }

    async #write(policy: ArtifactReviewPolicyValue['policy']): Promise<void> {
      const services = this.#services;
      const view = this.#view;

      if (services === undefined || view === undefined) return;

      this.#token += 1;
      const token = this.#token;

      try {
        const value = await services
          .use(ArtifactsV1)
          .setPolicy({ policy }, undefined);

        if (token !== this.#token) return;

        this.#value = value;
        view.error.hidden = true;
        this.#check(value.policy);
      } catch {
        if (token !== this.#token) return;

        view.error.hidden = false;
        view.error.textContent =
          'A escolha não foi gravada; o Project mantém a política anterior.';

        // The reading goes back to what the registry still keeps, so the radio
        // never shows a choice the Project does not run.
        if (this.#value === undefined) {
          for (const [, input] of view.choices) input.checked = false;
        } else {
          this.#check(this.#value.policy);
        }
      }
    }
  };
