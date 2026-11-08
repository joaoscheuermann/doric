// The colors of a diagram (openui-diagrams.md F7): each role a Doric token or
// `--foreground` mixed over `--background`, so a theme switch repaints with
// no new layout and FT16 computes every color exactly in both variants.

export type ColorRole =
  | 'nodeFill'
  | 'nodeStroke'
  | 'nodeText'
  | 'edge'
  | 'edgeText'
  | 'labelPlate'
  | 'group1'
  | 'group2'
  | 'group3'
  | 'group4'
  | 'groupStroke'
  | 'groupText';

/** A Doric token (name without `--`), or `--foreground` mixed over `--background` at `mix` percent (0–100). */
export type ColorValue = { readonly token: string } | { readonly mix: number };

/** Every role's color as data; group1–4 by depth, of increasing strength. */
export const DIAGRAM_COLORS: Readonly<Record<ColorRole, ColorValue>> = {
  nodeFill: { token: 'background' },
  nodeStroke: { token: 'muted-foreground' },
  nodeText: { token: 'foreground' },
  edge: { token: 'muted-foreground' },
  edgeText: { token: 'foreground' },
  labelPlate: { token: 'background' },
  group1: { mix: 4 },
  group2: { mix: 8 },
  group3: { mix: 12 },
  group4: { mix: 16 },
  groupStroke: { mix: 30 },
  groupText: { token: 'foreground' },
};

/** `var(--<token>)`, or `color-mix(in srgb, var(--foreground) <mix>%, var(--background))`. Pure. */
export const cssColor = (value: ColorValue): string =>
  'token' in value
    ? `var(--${value.token})`
    : `color-mix(in srgb, var(--foreground) ${value.mix}%, var(--background))`;
