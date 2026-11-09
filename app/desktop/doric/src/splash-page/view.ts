// What the splash page draws for a state (§4.5), without the DOM: splash.ts
// renders it and sends each action's `RecoveryAction` with `act`.

import {
  loadingText,
  type RecoveryAction,
  type SplashState,
} from '../platform/splash/protocol';

/**
 * An action button: Retry is the filled one and comes first in every error
 * state (S14); the others are secondary.
 */
export interface SplashActionView {
  readonly label: string;
  readonly action: RecoveryAction;
  readonly icon?: 'retry' | 'history';
  readonly ariaLabel?: string;
}

export interface SplashView {
  /** The status line: the spinner while loading, the alert icon on errors. */
  readonly status?: {
    readonly tone: 'loading' | 'error';
    readonly text: string;
  };
  /** The details: lines, or a list (one item per failing bundle). */
  readonly details: {
    readonly kind: 'lines' | 'list';
    readonly items: readonly string[];
  };
  readonly actions: readonly SplashActionView[];
}

const RETRY: SplashActionView = {
  label: 'Retry',
  action: { action: 'retry' },
  icon: 'retry',
};

const lines = (items: readonly string[]): SplashView['details'] => ({
  kind: 'lines',
  items,
});

export const splashView = (state: SplashState): SplashView => {
  switch (state.state) {
    case 'loading':
      return {
        status: { tone: 'loading', text: loadingText(state) },
        details: lines([]),
        actions: [],
      };
    case 'host-unreachable':
      return {
        status: { tone: 'error', text: `Cannot reach ${state.hostUrl}` },
        // One line, as Figma draws it (`302:22565`).
        details: lines([`${state.lastError} · Attempt ${state.attempts}`]),
        actions: [
          RETRY,
          ...(state.hasSnapshot
            ? [
                {
                  label: 'Open last known composition',
                  action: { action: 'open-last-known' },
                  icon: 'history',
                } as const,
              ]
            : []),
        ],
      };
    case 'bundle-failure':
      return {
        status: { tone: 'error', text: 'Some bundles cannot load' },
        details: {
          kind: 'list',
          items: state.bundles.map(
            (bundle) =>
              `${bundle.id} ${bundle.version}: ${bundle.reasons.map((reason) => reason.message).join('; ')}`,
          ),
        },
        actions: [
          RETRY,
          {
            label: 'Continue without them',
            action: { action: 'continue' },
          },
          ...state.bundles.map((bundle) => ({
            label: 'Disable',
            action: { action: 'disable', bundleId: bundle.id } as const,
            ariaLabel: `Disable ${bundle.id}`,
          })),
        ],
      };
    case 'core-failure':
      return {
        status: {
          tone: 'error',
          text: `${state.core.id} ${state.core.version}`,
        },
        details: lines([state.error]),
        actions: [
          RETRY,
          ...(state.hasLastGoodCore
            ? [
                {
                  label: 'Use last core that worked',
                  action: { action: 'use-last-good-core' },
                } as const,
              ]
            : []),
          {
            label: 'Return to default composition',
            action: { action: 'reset-composition' },
          },
        ],
      };
    case 'recovery': {
      const quarantined =
        state.diagnostics?.bundles.filter(
          (bundle) => bundle.state === 'quarantined',
        ) ?? [];

      return {
        status: { tone: 'error', text: state.reason },
        details: lines(
          quarantined.map(
            (bundle) =>
              `${bundle.id}: ${bundle.reasons[0]?.message ?? 'quarantined'}`,
          ),
        ),
        actions: [
          RETRY,
          ...(state.hasLastGoodCore
            ? [
                {
                  label: 'Use last core that worked',
                  action: { action: 'use-last-good-core' },
                } as const,
              ]
            : []),
          {
            label: 'Return to default composition',
            action: { action: 'reset-composition' },
          },
        ],
      };
    }
  }
};
