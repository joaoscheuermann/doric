// The splash and recovery surface's states and actions (section 12.2), and
// `doric.splash/v1`, the platform-internal contract between the splash page
// and main [S8-11]: a `state` stream and an `act` call. Types and text only:
// the page bundles this module.

import type { Diagnostics, QuarantineReason } from 'bundle/contracts';

export const SPLASH_CONTRACT = 'doric.splash/v1';

export type LoadingStep =
  | 'connecting'
  | 'catalog'
  | 'download'
  | 'verify'
  | 'activation';

export type SplashState =
  | {
      readonly state: 'loading';
      readonly step: LoadingStep;
      readonly progress?: { readonly done: number; readonly total: number };
    }
  | {
      readonly state: 'host-unreachable';
      readonly hostUrl: string;
      readonly lastError: string;
      readonly attempts: number;
      readonly hasSnapshot: boolean;
    }
  | {
      readonly state: 'bundle-failure';
      readonly bundles: readonly {
        readonly id: string;
        readonly version: string;
        readonly reasons: readonly QuarantineReason[];
      }[];
    }
  | {
      readonly state: 'core-failure';
      readonly core: { readonly id: string; readonly version: string };
      readonly error: string;
      readonly hasLastGoodCore: boolean;
    }
  | {
      readonly state: 'recovery';
      readonly reason: string;
      readonly diagnostics?: Diagnostics;
      readonly hasLastGoodCore: boolean;
    };

export type RecoveryAction =
  | { readonly action: 'retry' }
  | { readonly action: 'open-last-known' }
  | { readonly action: 'continue' }
  | { readonly action: 'disable'; readonly bundleId: string }
  | { readonly action: 'use-last-good-core' }
  | { readonly action: 'reset-composition' };

/** The visible status line of each loading step. */
export const loadingText = (
  state: Extract<SplashState, { state: 'loading' }>,
): string => {
  switch (state.step) {
    case 'connecting':
      return 'Connecting to the host';
    case 'catalog':
      return 'Reading the catalog';
    case 'download':
      return state.progress === undefined
        ? 'Downloading bundles'
        : `Downloading bundles (${state.progress.done}/${state.progress.total})`;
    case 'verify':
      return 'Verifying bundles';
    case 'activation':
      return 'Activating';
  }
};
