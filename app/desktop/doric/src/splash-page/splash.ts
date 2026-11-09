// The splash and recovery page (vanilla DOM, no React): it renders the state
// main streams on `doric.splash/v1.state` and sends the chosen action with
// `doric.splash/v1.act`.

import type { DoricDesktopApi } from 'desktop/protocol';

import {
  loadingText,
  type RecoveryAction,
  SPLASH_CONTRACT,
  type SplashState,
} from '../platform/splash/protocol';

const desktop = (
  globalThis as unknown as { doric: { desktop: DoricDesktopApi } }
).doric.desktop;

let sequence = 0;

const hex = (length: number): string =>
  Array.from({ length }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join('');

const envelope = (method: string, input: unknown) => {
  sequence += 1;

  return {
    id: `splash-${sequence}`,
    contract: SPLASH_CONTRACT,
    method,
    input,
    bundleId: null,
    deadline: 0,
    traceparent: `00-${hex(32)}-${hex(16)}-01`,
  };
};

const act = (action: RecoveryAction): void => {
  void desktop.call(envelope('act', action)).catch(() => undefined);
};

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);

  if (text !== undefined) {
    node.textContent = text;
  }

  return node;
};

/** The inline icons: Figma's SVG exports with their colors set to currentColor. */
const ICONS = {
  // Spinner `302:22448` (lucide loader-circle, 14 px).
  spinner: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.25 7C12.2499 8.10868 11.8989 9.18888 11.2472 10.0858C10.5955 10.9827 9.6766 11.6503 8.62218 11.9928C7.56775 12.3354 6.43195 12.3354 5.37754 11.9928C4.32314 11.6501 3.40426 10.9825 2.75261 10.0855C2.10096 9.1886 1.74999 8.10838 1.75 6.9997C1.75001 5.89103 2.10099 4.81081 2.75266 3.91387C3.40432 3.01694 4.3232 2.34932 5.37761 2.00671C6.43202 1.6641 7.56783 1.66409 8.62225 2.00667"/></svg>`,
  // Alert `302:22549` (lucide circle-alert, 14 px).
  alert: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4.66667V7M7 9.33333H7.00583M12.8333 7C12.8333 10.2217 10.2217 12.8333 7 12.8333C3.77834 12.8333 1.16667 10.2217 1.16667 7C1.16667 3.77834 3.77834 1.16667 7 1.16667C10.2217 1.16667 12.8333 3.77834 12.8333 7Z"/></svg>`,
  // Retry's icon (lucide refresh-cw, 16 px).
  retry: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.33333" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8C2 6.4087 2.63214 4.88258 3.75736 3.75736C4.88258 2.63214 6.4087 2 8 2C9.67737 2.00631 11.2874 2.66082 12.4933 3.82667L14 5.33333M10.6667 5.33333H14V2M14 8C14 9.5913 13.3679 11.1174 12.2426 12.2426C11.1174 13.3679 9.5913 14 8 14C6.32263 13.9937 4.71265 13.3392 3.50667 12.1733L2 10.6667M2 14V10.6667H5.33333"/></svg>`,
  // "Open last known composition"'s icon (lucide history, 16 px).
  history: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.33333" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8C2 9.18669 2.35189 10.3467 3.01118 11.3334C3.67047 12.3201 4.60754 13.0892 5.7039 13.5433C6.80026 13.9974 8.00666 14.1162 9.17054 13.8847C10.3344 13.6532 11.4035 13.0818 12.2426 12.2426C13.0818 11.4035 13.6532 10.3344 13.8847 9.17054C14.1162 8.00666 13.9974 6.80026 13.5433 5.7039C13.0892 4.60754 12.3201 3.67047 11.3334 3.01118C10.3467 2.35189 9.18669 2 8 2C6.32263 2.00631 4.71265 2.66082 3.50667 3.82667L2 5.33333M5.33333 5.33333H2V2M8 4.66667V8L10.6667 9.33333"/></svg>`,
} as const;

type IconName = keyof typeof ICONS;

const icon = (name: IconName): SVGSVGElement => {
  const template = document.createElement('template');

  template.innerHTML = ICONS[name];

  const svg = template.content.firstElementChild as SVGSVGElement;

  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.icon = name;

  return svg;
};

/** Retry is the filled button; every other action is secondary (§4.5). */
const button = (
  label: string,
  action: RecoveryAction,
  options: { readonly icon?: IconName } = {},
): HTMLButtonElement => {
  const node = element('button');

  node.type = 'button';
  node.dataset.variant = action.action === 'retry' ? 'primary' : 'secondary';

  if (options.icon !== undefined) {
    node.append(icon(options.icon));
  }

  node.append(label);
  node.addEventListener('click', () => act(action));

  return node;
};

const retry = (): HTMLButtonElement =>
  button('Retry', { action: 'retry' }, { icon: 'retry' });

const status = document.querySelector('.splash-status') as HTMLElement;
const details = document.querySelector('.splash-details') as HTMLElement;
const actions = document.querySelector('.splash-actions') as HTMLElement;

const show = (
  node: HTMLElement,
  children: readonly (Node | string)[],
): void => {
  node.replaceChildren(...children);
  node.hidden = children.length === 0;
};

/** The status line: the state's icon, then its text; hidden without text. */
const showStatus = (tone: 'loading' | 'error', text?: string): void => {
  if (text === undefined) {
    show(status, []);

    return;
  }

  status.dataset.tone = tone;
  show(status, [
    icon(tone === 'loading' ? 'spinner' : 'alert'),
    element('span', text),
  ]);
};

const lines = (texts: readonly string[]): HTMLElement[] =>
  texts.map((text) => element('div', text));

const render = (state: SplashState): void => {
  switch (state.state) {
    case 'loading':
      showStatus('loading', loadingText(state));
      show(details, []);
      show(actions, []);
      return;
    case 'host-unreachable':
      showStatus('error', `Cannot reach ${state.hostUrl}`);
      // One line, as Figma draws it (`302:22565`).
      show(details, lines([`${state.lastError} · Attempt ${state.attempts}`]));
      show(actions, [
        retry(),
        ...(state.hasSnapshot
          ? [
              button(
                'Open last known composition',
                { action: 'open-last-known' },
                { icon: 'history' },
              ),
            ]
          : []),
      ]);
      return;
    case 'bundle-failure': {
      const list = element('ul');

      for (const bundle of state.bundles) {
        list.append(
          element(
            'li',
            `${bundle.id} ${bundle.version}: ${bundle.reasons.map((reason) => reason.message).join('; ')}`,
          ),
        );
      }

      showStatus('error');
      show(details, [list]);
      show(actions, [
        button('Continue without them', { action: 'continue' }),
        ...state.bundles.map((bundle) => {
          const node = button('Disable', {
            action: 'disable',
            bundleId: bundle.id,
          });

          node.setAttribute('aria-label', `Disable ${bundle.id}`);

          return node;
        }),
        retry(),
      ]);
      return;
    }
    case 'core-failure':
      showStatus('error', `${state.core.id} ${state.core.version}`);
      show(details, lines([state.error]));
      show(actions, [
        ...(state.hasLastGoodCore
          ? [
              button('Use last core that worked', {
                action: 'use-last-good-core',
              }),
            ]
          : []),
        button('Return to default composition', {
          action: 'reset-composition',
        }),
        retry(),
      ]);
      return;
    case 'recovery': {
      const quarantined =
        state.diagnostics?.bundles.filter(
          (bundle) => bundle.state === 'quarantined',
        ) ?? [];

      showStatus('error', state.reason);
      show(
        details,
        lines([
          ...quarantined.map(
            (bundle) =>
              `${bundle.id}: ${bundle.reasons[0]?.message ?? 'quarantined'}`,
          ),
        ]),
      );
      show(actions, [
        retry(),
        ...(state.hasLastGoodCore
          ? [
              button('Use last core that worked', {
                action: 'use-last-good-core',
              }),
            ]
          : []),
        button('Return to default composition', {
          action: 'reset-composition',
        }),
      ]);
      return;
    }
  }
};

// The art pane: until the live art (4.5b), the shaded export of `302:22439`.
const artPane = document.querySelector('[data-art-pane]') as HTMLElement;

const showShaded = (): void => {
  if (artPane.querySelector('img[data-art="shaded"]') !== null) {
    return;
  }

  const image = element('img');

  image.dataset.art = 'shaded';
  image.alt = '';
  image.src = 'art-shaded.webp';
  artPane.replaceChildren(image);
};

showShaded();

// The credits' version is the app's (S7).
void desktop
  .describeWindow()
  .then((description) => {
    (document.querySelector('.splash-version') as HTMLElement).textContent =
      description.app.version;
  })
  .catch(() => undefined);

// The GitHub link: main opens the repository; the page names only the link.
document.querySelector('.splash-link')?.addEventListener('click', (event) => {
  event.preventDefault();
  act({ action: 'open-link', link: 'github' });
});

desktop.subscribe(envelope('state', []), (event) => {
  if (event.type === 'event') {
    render(event.event as SplashState);
  }
});
