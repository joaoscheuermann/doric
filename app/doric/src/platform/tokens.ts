// The window tokens main needs, read once from the platform's `tokens.json`
// (the file `desktop-ui` generates from its token module).

import { readFileSync } from 'node:fs';

import type { Tokens } from 'desktop-ui/tokens';

export interface WindowTokens {
  /** The chrome bar height, in CSS pixels. */
  readonly titlebarHeight: number;
  readonly trafficLightSize: number;
  readonly trafficLightInsetX: number;
  /** The width a chrome bar keeps clear for the window buttons. */
  readonly reservedWidth: number;
  /** A native color by token name; unknown names throw. */
  color(name: string, dark: boolean): string;
  /**
   * `doric.tokens/v1.get()`: the shared tokens, the default (dark) variant
   * and the window variables, as `desktop-ui`'s `resolvedVariables` states
   * them (a test pins the equality).
   */
  variables(): Readonly<Record<string, string>>;
}

export const windowTokens = (tokens: Tokens): WindowTokens => {
  const { window } = tokens;
  const variables: Readonly<Record<string, string>> = Object.freeze({
    ...tokens.shared,
    ...tokens.variants[tokens.defaultVariant],
    '--doric-titlebar-height': `${window.titlebarHeight}px`,
    '--doric-window-background': 'var(--background)',
    '--doric-safe-top': '0px',
    '--doric-safe-left': '0px',
    '--doric-safe-right': '0px',
  });
  const backgrounds = window.backgrounds as Readonly<
    Record<string, { readonly light: string; readonly dark: string }>
  >;

  return Object.freeze({
    titlebarHeight: window.titlebarHeight,
    trafficLightSize: window.trafficLight.size,
    trafficLightInsetX: window.trafficLight.insetX,
    reservedWidth: window.trafficLight.reservedWidth,
    color: (name: string, dark: boolean): string => {
      const background = Object.hasOwn(backgrounds, name)
        ? backgrounds[name]
        : undefined;

      if (background === undefined) {
        throw new Error(`Unknown window color token "${name}".`);
      }

      return dark ? background.dark : background.light;
    },
    variables: () => variables,
  });
};

/** Reads `desktop-ui@<v>/tokens.json` of the platform assets. */
export const loadWindowTokens = (path: string): WindowTokens =>
  windowTokens(JSON.parse(readFileSync(path, 'utf8')) as Tokens);
