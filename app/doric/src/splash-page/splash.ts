// The splash and recovery page (vanilla DOM, no React): it renders the state
// main streams on `doric.splash/v1.state` and sends the chosen action with
// `doric.splash/v1.act`.

import type { DoricDesktopApi } from 'desktop-client/protocol';

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

const button = (label: string, action: RecoveryAction): HTMLButtonElement => {
  const node = element('button', label);

  node.type = 'button';
  node.addEventListener('click', () => act(action));

  return node;
};

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

const lines = (texts: readonly string[]): HTMLElement[] =>
  texts.map((text) => element('div', text));

const render = (state: SplashState): void => {
  switch (state.state) {
    case 'loading':
      show(status, [loadingText(state)]);
      show(details, []);
      show(actions, []);
      return;
    case 'host-unreachable':
      show(status, [`Cannot reach ${state.hostUrl}`]);
      show(details, lines([state.lastError, `Attempt ${state.attempts}`]));
      show(actions, [
        button('Retry', { action: 'retry' }),
        ...(state.hasSnapshot
          ? [
              button('Open last known composition', {
                action: 'open-last-known',
              }),
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

      show(status, []);
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
        button('Retry', { action: 'retry' }),
      ]);
      return;
    }
    case 'core-failure':
      show(status, [`${state.core.id} ${state.core.version}`]);
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
        button('Retry', { action: 'retry' }),
      ]);
      return;
    case 'recovery': {
      const quarantined =
        state.diagnostics?.bundles.filter(
          (bundle) => bundle.state === 'quarantined',
        ) ?? [];

      show(status, [state.reason]);
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
        button('Retry', { action: 'retry' }),
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

desktop.subscribe(envelope('state', []), (event) => {
  if (event.type === 'event') {
    render(event.event as SplashState);
  }
});
