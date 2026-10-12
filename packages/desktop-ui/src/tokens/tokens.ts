/**
 * The desktop's design tokens, stated once.
 *
 * Every value is the one the renderer's stylesheet wrote before the platform
 * existed: `light` is its `:root` palette, `dark` its `.dark` palette, and
 * `shared` holds what both state alike (faces, weight, radius, spacing, the
 * shadow geometry), so neither variant restates it. `scripts/build-tokens.mjs`
 * writes `src/styles/tokens.css` and `dist/tokens.json` from this module; edit
 * the values here, never in the generated files.
 */

/** CSS custom properties by name, each with its CSS value. */
export interface TokenSet {
  readonly [cssVar: `--${string}`]: string;
}

export interface Tokens {
  /** The platform version these tokens ship with. */
  readonly version: string;
  /** The app is dark only: every window starts in, and stays in, this variant. */
  readonly defaultVariant: 'dark';
  readonly variants: { readonly light: TokenSet; readonly dark: TokenSet };
  /** Tokens both variants state with the same value. */
  readonly shared: TokenSet;
  readonly window: {
    /** The height of a window's chrome bar, in CSS pixels (`2.25rem`). */
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
  version: '1.0.0',
  defaultVariant: 'dark',
  variants: {
    light: {
      '--background': 'oklch(0.9232 0.0026 48.7171)',
      '--foreground': 'oklch(0.2795 0.0368 260.031)',
      '--card': 'oklch(0.9699 0.0013 106.4238)',
      '--card-foreground': 'oklch(0.2795 0.0368 260.031)',
      '--popover': 'oklch(0.9699 0.0013 106.4238)',
      '--popover-foreground': 'oklch(0.2795 0.0368 260.031)',
      '--primary': 'oklch(0.515 0.2041 277.1173)',
      '--primary-foreground': 'oklch(1 0 0)',
      '--secondary': 'oklch(0.855 0.0043 56.366)',
      '--secondary-foreground': 'oklch(0.4461 0.0263 256.8018)',
      '--muted': 'oklch(0.86 0.0026 48.7171)',
      '--muted-foreground': 'oklch(0.5 0.0234 264.3637)',
      '--accent': 'oklch(0.87 0.026 321.9388)',
      '--accent-foreground': 'oklch(0.3729 0.0306 259.7328)',
      '--destructive': 'oklch(0.52 0.2078 25.3313)',
      '--destructive-foreground': 'oklch(1 0 0)',
      '--warning': 'oklch(0.52 0.15 75)',
      '--warning-foreground': 'oklch(1 0 0)',
      '--border': 'oklch(0.82 0.0043 56.366)',
      '--input': 'oklch(0.82 0.0043 56.366)',
      '--ring': 'oklch(0.515 0.2041 277.1173)',
      '--chart-1': 'oklch(0.515 0.2041 277.1173)',
      '--chart-2': 'oklch(0.5106 0.2301 276.9656)',
      '--chart-3': 'oklch(0.4568 0.2146 277.0229)',
      '--chart-4': 'oklch(0.3984 0.1773 277.3662)',
      '--chart-5': 'oklch(0.3588 0.1354 278.6973)',
      '--sidebar': 'oklch(0.8687 0.0043 56.366)',
      '--sidebar-foreground': 'oklch(0.2795 0.0368 260.031)',
      '--sidebar-primary': 'oklch(0.515 0.2041 277.1173)',
      '--sidebar-primary-foreground': 'oklch(1 0 0)',
      '--sidebar-accent': 'oklch(0.825 0.026 321.9388)',
      '--sidebar-accent-foreground': 'oklch(0.3729 0.0306 259.7328)',
      '--sidebar-border': 'oklch(0.8 0.0043 56.366)',
      '--sidebar-ring': 'oklch(0.515 0.2041 277.1173)',
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
      '--background': 'oklch(0.2244 0.0074 67.437)',
      '--foreground': 'oklch(0.9288 0.0126 255.5078)',
      '--card': 'oklch(0.2801 0.008 59.3379)',
      '--card-foreground': 'oklch(0.9288 0.0126 255.5078)',
      '--popover': 'oklch(0.2801 0.008 59.3379)',
      '--popover-foreground': 'oklch(0.9288 0.0126 255.5078)',
      '--primary': 'oklch(0.7648 0.2164 148.8852)',
      '--primary-foreground': 'oklch(0.2244 0.0074 67.437)',
      '--secondary': 'oklch(0.3359 0.0077 59.4197)',
      '--secondary-foreground': 'oklch(0.8717 0.0093 258.3382)',
      '--muted': 'oklch(0.3 0.0074 67.4469)',
      '--muted-foreground': 'oklch(0.7137 0.0192 261.3246)',
      '--accent': 'oklch(0.3896 0.0074 59.4734)',
      '--accent-foreground': 'oklch(0.8717 0.0093 258.3382)',
      '--destructive': 'oklch(0.76 0.18 25.3313)',
      '--destructive-foreground': 'oklch(0.2244 0.0074 67.437)',
      '--warning': 'oklch(0.8 0.16 78)',
      '--warning-foreground': 'oklch(0.2244 0.0074 67.437)',
      '--border': 'oklch(0.3359 0.0077 59.4197)',
      '--input': 'oklch(0.3359 0.0077 59.4197)',
      '--ring': 'oklch(0.6801 0.1583 276.9349)',
      '--chart-1': 'oklch(0.6801 0.1583 276.9349)',
      '--chart-2': 'oklch(0.5854 0.2041 277.1173)',
      '--chart-3': 'oklch(0.5106 0.2301 276.9656)',
      '--chart-4': 'oklch(0.4568 0.2146 277.0229)',
      '--chart-5': 'oklch(0.3984 0.1773 277.3662)',
      '--sidebar': 'oklch(0.2523 0.0077 63.3875)',
      '--sidebar-foreground': 'oklch(0.9288 0.0126 255.5078)',
      '--sidebar-primary': 'oklch(0.6801 0.1583 276.9349)',
      '--sidebar-primary-foreground': 'oklch(0.2244 0.0074 67.437)',
      '--sidebar-accent': 'oklch(0.305 0.008 61)',
      '--sidebar-accent-foreground': 'oklch(0.8717 0.0093 258.3382)',
      '--sidebar-border': 'oklch(0.3359 0.0077 59.4197)',
      '--sidebar-ring': 'oklch(0.6801 0.1583 276.9349)',
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
    '--font-sans': "'Noto Sans', sans-serif",
    '--font-serif': "'Noto Sans', sans-serif",
    '--font-mono': "'IBM Plex Mono', monospace",
    '--font-conversation': "'IBM Plex Mono', monospace",
    '--font-weight-medium': '400',
    '--radius': '0.25rem',
    '--shadow-x': '0px',
    '--shadow-y': '4px',
    '--shadow-blur': '12px',
    '--shadow-spread': '-2px',
    '--shadow-opacity': '0.1',
    '--tracking-normal': '0em',
    '--spacing': '0.25rem',
  },
  window: {
    titlebarHeight: 36,
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
      window: { light: '#e7e5e4', dark: '#1c1b19' },
    },
  },
};
