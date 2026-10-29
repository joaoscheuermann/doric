/**
 * The desktop's design tokens, stated once.
 *
 * The neutral surfaces and blue focus follow the local Papermache UI. Project
 * palette marks remain Doric's own. `scripts/build-tokens.mjs`
 * writes `src/styles/tokens.css` and `dist/tokens.json` from this module; edit
 * the values here, never in the generated files.
 */

import { PLATFORM_VERSION } from 'bundle/runtime';

/** CSS custom properties by name, each with its CSS value. */
export interface TokenSet {
  readonly [cssVar: `--${string}`]: string;
}

export interface Tokens {
  /** The platform version these tokens ship with. */
  readonly version: string;
  /** The light CSS fallback before the system preference is evaluated. */
  readonly defaultVariant: 'light';
  readonly variants: { readonly light: TokenSet; readonly dark: TokenSet };
  /** Tokens both variants state with the same value. */
  readonly shared: TokenSet;
  readonly window: {
    /** The height of a window's chrome bar, in CSS pixels. */
    readonly titlebarHeight: number;
    /**
     * The macOS window buttons: their size, their inset from the window's
     * leading edge, and the width a chrome bar keeps clear for them.
     */
    readonly trafficLight: {
      readonly size: number;
      readonly insetX: number;
      readonly reservedWidth: number;
    };
    /** Native window backgrounds, shown before the page paints. */
    readonly backgrounds: {
      readonly window: { readonly light: string; readonly dark: string };
    };
  };
}

const trafficLightSize = 12;
const trafficLightInsetX = 14;
/** The gap between two window buttons. */
const trafficLightGap = 8;

export const tokens: Tokens = {
  version: PLATFORM_VERSION,
  defaultVariant: 'light',
  variants: {
    light: {
      '--background': '#ffffff',
      '--foreground': '#333333',
      '--card': '#f2f2f2',
      '--card-foreground': '#333333',
      '--popover': '#f2f2f2',
      '--popover-foreground': '#333333',
      '--primary': 'oklch(0.55 0.145 258)',
      '--primary-foreground': '#ffffff',
      '--secondary': '#f9f9f9',
      '--secondary-foreground': '#333333',
      '--muted': '#eaeaea',
      '--muted-foreground': '#666666',
      '--accent': '#e0e0e0',
      '--accent-foreground': '#333333',
      '--destructive': 'oklch(0.52 0.2078 25.3313)',
      '--destructive-foreground': '#ffffff',
      '--warning': 'oklch(0.52 0.15 75)',
      '--warning-foreground': 'oklch(1 0 0)',
      '--border': '#e2e2e2',
      '--input': '#dadada',
      '--ring': 'oklch(0.55 0.145 258)',
      '--chart-1': 'oklch(0.515 0.2041 277.1173)',
      '--chart-2': 'oklch(0.5106 0.2301 276.9656)',
      '--chart-3': 'oklch(0.4568 0.2146 277.0229)',
      '--chart-4': 'oklch(0.3984 0.1773 277.3662)',
      '--chart-5': 'oklch(0.3588 0.1354 278.6973)',
      '--sidebar': '#f2f2f2',
      '--sidebar-foreground': '#333333',
      '--sidebar-primary': 'oklch(0.55 0.145 258)',
      '--sidebar-primary-foreground': '#ffffff',
      '--sidebar-accent': '#eaeaea',
      '--sidebar-accent-foreground': '#333333',
      '--sidebar-border': '#e2e2e2',
      '--sidebar-ring': 'oklch(0.55 0.145 258)',
      '--paper-root': '#ffffff',
      '--paper-panel': '#f2f2f2',
      '--paper-panel-highlight-1': '#eaeaea',
      '--paper-panel-highlight-2': '#e0e0e0',
      '--paper-separator': '#e2e2e2',
      '--paper-separator-highlight': '#dadada',
      '--paper-control': '#f9f9f9',
      '--paper-control-border': '#e2e2e2',
      '--paper-control-pressed': '#fcfcfc',
      '--paper-control-icon': 'oklab(0% none none / 0.35)',
      '--paper-ghost-hover': 'oklab(0% none none / 0.06)',
      '--paper-ghost-pressed': 'oklab(0% none none / 0.085)',
      '--paper-thumbnail': 'oklab(0% none none / 0.075)',
      '--paper-thumbnail-selected': 'oklch(97.5% 0.012 258)',
      '--paper-gray-1': 'oklab(0% none none / 0.8)',
      '--paper-gray-2': 'oklab(0% none none / 0.6)',
      '--paper-gray-3': 'oklab(0% none none / 0.5)',
      '--paper-gray-4': 'oklab(0% none none / 0.425)',
      '--paper-gray-5': 'oklab(0% none none / 0.1)',
      '--paper-blue-2': 'oklch(70% 0.15 258)',
      '--paper-blue-3': 'oklch(67% 0.17 258)',
      '--paper-blue-4': 'oklch(63.5% 0.15 258)',
      '--paper-blue-5': 'oklch(55% 0.145 258)',
      '--paper-orange': 'oklch(81% 0.18 67)',
      '--paper-red': 'oklch(59% 0.25 20)',
      '--paper-green': 'oklch(62% 0.16 150)',
      '--paper-focus': 'oklch(74% 0.12 258)',
      '--paper-selection': 'oklch(78% 0.12 258 / 0.5)',
      '--paper-shadow-control':
        'inset 0 1px #fff8, inset 0 0 1px 1px #fff8, 0 0.5px 1px #00000018, 0 0 1px #0001, 0 0 4px -1px #0001',
      '--shadow-color': 'hsl(240 4% 60%)',
      '--shadow-2xs': '0 1px 2px 0 hsl(240 4% 60% / 0.05)',
      '--shadow-xs': '0 1px 3px 0 hsl(240 4% 60% / 0.07)',
      '--shadow-sm':
        '0 2px 6px -1px hsl(240 4% 60% / 0.08), 0 1px 2px 0 hsl(240 4% 60% / 0.05)',
      '--shadow':
        '0 2px 6px -1px hsl(240 4% 60% / 0.08), 0 1px 2px 0 hsl(240 4% 60% / 0.05)',
      '--shadow-md':
        '0 4px 12px -2px hsl(240 4% 60% / 0.1), 0 2px 4px -1px hsl(240 4% 60% / 0.06)',
      '--shadow-lg':
        '0 8px 20px -4px hsl(240 4% 60% / 0.1), 0 2px 6px -2px hsl(240 4% 60% / 0.06)',
      '--shadow-xl':
        '0 12px 28px -6px hsl(240 4% 60% / 0.12), 0 4px 8px -2px hsl(240 4% 60% / 0.06)',
      '--shadow-2xl': '0 16px 40px -8px hsl(240 4% 60% / 0.16)',
    },
    dark: {
      '--background': '#222222',
      '--foreground': '#e9e9e9',
      '--card': '#2a2a2a',
      '--card-foreground': '#e9e9e9',
      '--popover': '#2a2a2a',
      '--popover-foreground': '#e9e9e9',
      '--primary': 'oklch(0.67 0.17 258)',
      '--primary-foreground': '#101010',
      '--secondary': '#373737',
      '--secondary-foreground': '#e9e9e9',
      '--muted': '#333333',
      '--muted-foreground': '#b2b2b2',
      '--accent': '#3c3c3c',
      '--accent-foreground': '#e9e9e9',
      '--destructive': '#ff9999',
      '--destructive-foreground': 'oklch(0.2244 0.0074 67.437)',
      '--warning': 'oklch(0.8 0.16 78)',
      '--warning-foreground': 'oklch(0.2244 0.0074 67.437)',
      '--border': '#373737',
      '--input': '#3e3e3e',
      '--ring': 'oklch(0.6 0.15 258)',
      '--chart-1': 'oklch(0.6801 0.1583 276.9349)',
      '--chart-2': 'oklch(0.5854 0.2041 277.1173)',
      '--chart-3': 'oklch(0.5106 0.2301 276.9656)',
      '--chart-4': 'oklch(0.4568 0.2146 277.0229)',
      '--chart-5': 'oklch(0.3984 0.1773 277.3662)',
      '--sidebar': '#2a2a2a',
      '--sidebar-foreground': '#e9e9e9',
      '--sidebar-primary': 'oklch(0.67 0.17 258)',
      '--sidebar-primary-foreground': '#101010',
      '--sidebar-accent': '#333333',
      '--sidebar-accent-foreground': '#e9e9e9',
      '--sidebar-border': '#373737',
      '--sidebar-ring': 'oklch(0.6 0.15 258)',
      '--paper-root': '#222222',
      '--paper-panel': '#2a2a2a',
      '--paper-panel-highlight-1': '#333333',
      '--paper-panel-highlight-2': '#3c3c3c',
      '--paper-separator': '#373737',
      '--paper-separator-highlight': '#3e3e3e',
      '--paper-control': '#373737',
      '--paper-control-border': 'transparent',
      '--paper-control-pressed': '#3c3c3c',
      '--paper-control-icon': 'oklab(100% 0 5.96046e-8 / 0.4)',
      '--paper-ghost-hover': 'oklab(100% 0 5.96046e-8 / 0.06)',
      '--paper-ghost-pressed': 'oklab(100% 0 5.96046e-8 / 0.085)',
      '--paper-thumbnail': 'oklab(100% 0 5.96046e-8 / 0.1)',
      '--paper-thumbnail-selected': 'oklch(30% 0.025 258)',
      '--paper-gray-1': 'oklab(100% 0 5.96046e-8 / 0.9)',
      '--paper-gray-2': 'oklab(100% 0 5.96046e-8 / 0.65)',
      '--paper-gray-3': 'oklab(100% 0 5.96046e-8 / 0.575)',
      '--paper-gray-4': 'oklab(100% 0 5.96046e-8 / 0.5)',
      '--paper-gray-5': 'oklab(100% 0 5.96046e-8 / 0.1)',
      '--paper-blue-2': 'oklch(70% 0.15 258)',
      '--paper-blue-3': 'oklch(67% 0.17 258)',
      '--paper-blue-4': 'oklch(63.5% 0.15 258)',
      '--paper-blue-5': 'oklch(55% 0.145 258)',
      '--paper-orange': 'oklch(81% 0.18 67)',
      '--paper-red': 'oklch(71% 0.23 20)',
      '--paper-green': 'oklch(74% 0.18 150)',
      '--paper-focus': 'oklch(60% 0.15 258)',
      '--paper-selection': 'oklch(74% 0.3 258 / 0.3)',
      '--paper-shadow-control':
        'inset 0 1px #ffffff08, inset 0 0 1px 0.5px #fff1, 0 1px 0.5px #00000018, 0 0 3px -1px #000a',
      '--shadow-color': 'hsl(0 0% 0%)',
      '--shadow-2xs': '0 1px 2px 0 hsl(0 0% 0% / 0.05)',
      '--shadow-xs': '0 1px 3px 0 hsl(0 0% 0% / 0.07)',
      '--shadow-sm':
        '0 2px 6px -1px hsl(0 0% 0% / 0.08), 0 1px 2px 0 hsl(0 0% 0% / 0.05)',
      '--shadow':
        '0 2px 6px -1px hsl(0 0% 0% / 0.08), 0 1px 2px 0 hsl(0 0% 0% / 0.05)',
      '--shadow-md':
        '0 4px 12px -2px hsl(0 0% 0% / 0.1), 0 2px 4px -1px hsl(0 0% 0% / 0.06)',
      '--shadow-lg':
        '0 8px 20px -4px hsl(0 0% 0% / 0.1), 0 2px 6px -2px hsl(0 0% 0% / 0.06)',
      '--shadow-xl':
        '0 12px 28px -6px hsl(0 0% 0% / 0.12), 0 4px 8px -2px hsl(0 0% 0% / 0.06)',
      '--shadow-2xl': '0 16px 40px -8px hsl(0 0% 0% / 0.16)',
    },
  },
  shared: {
    '--font-sans': "-apple-system, BlinkMacSystemFont, 'Noto Sans', sans-serif",
    '--font-serif':
      "-apple-system, BlinkMacSystemFont, 'Noto Sans', sans-serif",
    '--font-mono': "'IBM Plex Mono', monospace",
    '--font-conversation': "'IBM Plex Mono', monospace",
    '--font-weight-normal': '400',
    '--font-weight-medium': '500',
    '--radius': '6px',
    '--paper-radius-control': '6px',
    '--paper-radius-panel': '8px',
    '--paper-text-sm': '10px',
    '--paper-text-base': '12px',
    '--paper-text-lg': '13px',
    '--shadow-x': '0px',
    '--shadow-y': '4px',
    '--shadow-blur': '12px',
    '--shadow-spread': '-2px',
    '--shadow-opacity': '0.1',
    '--tracking-normal': '0em',
    '--spacing': '0.25rem',
  },
  window: {
    titlebarHeight: 40,
    trafficLight: {
      size: trafficLightSize,
      insetX: trafficLightInsetX,
      // Both insets, three buttons and the two gaps between them: the renderer's
      // `pl-20`.
      reservedWidth:
        trafficLightInsetX +
        3 * trafficLightSize +
        2 * trafficLightGap +
        trafficLightInsetX,
    },
    backgrounds: {
      // `--background` of each variant as the sRGB colour a native window takes.
      window: { light: '#ffffff', dark: '#222222' },
    },
  },
};
