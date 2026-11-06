// The Generative UI section of the settings window (openui.md D24): one
// switch, "Draw answers and questions as UI", that reads
// `openui.setting/v1.watch` and writes `set`. The class is made inside a
// factory the activation calls, so importing this module touches no DOM
// global; the window's `ui/v1` attaches this bundle's services to each
// instance it creates.

import type { Disposable, RegionItem, Services } from 'bundle/contracts';

import { OpenuiSettingV1 } from '../contracts/index.js';

/** The section's element tag. */
export const SETTINGS_TAG = 'openui-settings';

/** The section's route, a child of the settings window's. */
export const SETTINGS_PATH = '/settings/generative-ui';

/** The section's link in the settings window's nav. */
export const settingsRegion: {
  readonly region: string;
  readonly item: RegionItem;
} = {
  region: 'settings.sections',
  item: {
    id: 'generative-ui',
    tag: 'settings-link',
    order: 70,
    props: {
      label: 'Generative UI',
      path: SETTINGS_PATH,
      icon: 'wrench',
      description:
        'Answers, questions and previews drawn as UI in the conversation.',
    },
  },
};

const STYLE = [
  ':host { display: block; }',
  '.openui-settings { display: flex; align-items: center; gap: 8px; }',
  '.openui-settings-error { color: var(--destructive, #dc2626); font-size: 0.875rem; }',
  '.openui-settings-error[hidden] { display: none; }',
].join('\n');

/** `<openui-settings>`: the switch over `openui.setting/v1`. */
export const defineSettingsElement = () =>
  class OpenuiSettingsElement extends HTMLElement {
    #services: Services | undefined;
    #input: HTMLInputElement | undefined;
    #error: HTMLElement | undefined;
    #watch: Disposable | undefined;

    set services(value: Services | undefined) {
      this.#services = value;
      this.#follow();
    }

    get services(): Services | undefined {
      return this.#services;
    }

    connectedCallback(): void {
      this.#build();
      this.#follow();
    }

    disconnectedCallback(): void {
      this.#watch?.dispose();
      this.#watch = undefined;
    }

    #build(): void {
      if (this.#input !== undefined) return;
      const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = STYLE;

      const label = document.createElement('label');
      label.className = 'openui-settings';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('role', 'switch');
      input.addEventListener('change', () => {
        this.#write(input.checked);
      });
      const text = document.createElement('span');
      text.textContent = 'Draw answers and questions as UI';
      label.append(input, text);

      const error = document.createElement('p');
      error.className = 'openui-settings-error';
      error.hidden = true;

      root.append(style, label, error);
      this.#input = input;
      this.#error = error;
    }

    /** Watches the setting while connected with services. */
    #follow(): void {
      if (!this.isConnected || this.#services === undefined) return;
      this.#watch?.dispose();
      this.#watch = this.#services.use(OpenuiSettingV1).watch((value) => {
        this.#show(value.enabled);
      });
    }

    #show(enabled: boolean): void {
      if (this.#input === undefined) return;
      this.#input.checked = enabled;
      this.#input.setAttribute('aria-checked', String(enabled));
    }

    #write(enabled: boolean): void {
      const services = this.#services;
      if (services === undefined || this.#error === undefined) return;
      const error = this.#error;
      error.hidden = true;
      services
        .use(OpenuiSettingV1)
        .set({ enabled })
        .then(
          (value) => this.#show(value.enabled),
          (reason: unknown) => {
            this.#show(!enabled);
            error.textContent = `Could not save: ${
              reason instanceof Error ? reason.message : String(reason)
            }`;
            error.hidden = false;
          },
        );
    }
  };
