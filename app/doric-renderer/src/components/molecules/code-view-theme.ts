import { oklchToHex } from '@/utility/oklch';
import { editor } from 'monaco-editor/editor/editor.api.js';

/**
 * The theme the code view is painted with: the app's own palette for everything
 * the panel paints, and a small set of hues for the code inside it.
 *
 * Monaco cannot read `oklch(…)`, so every token is resolved from the document
 * and converted (`@/utility/oklch`); a token that does not resolve is left out
 * of the theme, and Monaco's own default answers for that colour id.
 */

/** The mode the palette has a block for, and the theme each one is named. */
const THEME_BY_MODE = { dark: 'doric-dark', light: 'doric-light' } as const;

type Mode = keyof typeof THEME_BY_MODE;

/**
 * The roles code is coloured by. `comment` is the one the palette already has a
 * colour for; the rest are the theme's own.
 */
type Hue = 'comment' | 'keyword' | 'string' | 'number' | 'type' | 'name';

/**
 * What each role is painted with, per mode: the palette's own quiet grey for a
 * comment, and otherwise one of the theme's own `oklch(…)` hues.
 *
 * Those hues are the theme's, not the palette's, because this app has never
 * coloured code. They are chosen to read as the same family as the palette that
 * surrounds them — the accent's green for structure, the warm neutrals' amber
 * for literals, the chart hues' violet for types, and the foreground's own cool
 * blue for a name — at a chroma low enough to leave the code the quietest thing
 * on the panel. The lighter set is for the dark background, the darker for the
 * light one.
 */
const HUES: Readonly<Record<Mode, Readonly<Record<Hue, string>>>> = {
  dark: {
    comment: '--muted-foreground',
    keyword: 'oklch(0.78 0.13 152)',
    string: 'oklch(0.81 0.09 70)',
    number: 'oklch(0.8 0.09 205)',
    type: 'oklch(0.79 0.09 288)',
    name: 'oklch(0.82 0.06 245)',
  },
  light: {
    comment: '--muted-foreground',
    keyword: 'oklch(0.5 0.13 152)',
    string: 'oklch(0.51 0.11 62)',
    number: 'oklch(0.5 0.1 200)',
    type: 'oklch(0.48 0.13 285)',
    name: 'oklch(0.46 0.1 250)',
  },
};

/** The entries that resolved, so an unreadable colour keeps Monaco's default. */
const resolved = (
  colours: Record<string, string | undefined>,
): editor.IColors => {
  const kept: editor.IColors = {};
  for (const [id, value] of Object.entries(colours)) {
    if (value !== undefined) kept[id] = value;
  }
  return kept;
};

/**
 * The colour a source names: a palette token when it starts with `--`, and an
 * `oklch(…)` value otherwise. `undefined` for text that is neither, so a colour
 * that cannot be read is left to Monaco's own default rather than painted
 * wrongly.
 */
const read = (
  palette: CSSStyleDeclaration,
  source: string,
): string | undefined =>
  oklchToHex(
    source.startsWith('--') ? palette.getPropertyValue(source) : source,
  );

/**
 * Every colour the panel paints, each read from the palette the document has
 * right now. The gutter is not here because Monaco points
 * `editorGutter.background` at `editor.background`, and neither is the inactive
 * selection nor the occurrence highlight, because Monaco derives both from
 * `editor.selectionBackground`.
 */
const colours = (mode: Mode, palette: CSSStyleDeclaration): editor.IColors => {
  const hues = HUES[mode];
  const token = (name: string): string | undefined => read(palette, name);
  const hue = (role: Hue): string | undefined => read(palette, hues[role]);

  return resolved({
    // The panel itself: one background, one foreground, and a gutter that
    // reads as part of it rather than as a second surface.
    'editor.background': token('--background'),
    'editor.foreground': token('--foreground'),
    'editorLineNumber.foreground': token('--muted-foreground'),
    // The app marks nothing about the line the caret is on, so the line number
    // of that line is the same grey as every other one.
    'editorLineNumber.activeForeground': token('--muted-foreground'),
    'editorIndentGuide.background1': token('--border'),
    'editorIndentGuide.activeBackground1': token('--border'),
    // The app's accent is green, so the caret is its green.
    'editorCursor.foreground': token('--primary'),
    // `--accent` is the surface the app highlights a row with: quiet in both
    // modes, and dark enough under the foreground to read a selection on.
    'editor.selectionBackground': token('--accent'),
    'editorError.foreground': token('--destructive'),
    // The one widget a read-only panel can still open, the find box, is a
    // raised surface like any other in the app.
    'editorWidget.background': token('--card'),
    'editorWidget.foreground': token('--foreground'),
    'editorWidget.border': token('--border'),
    // Our `ScrollAreaThumb` is a solid `border` at rest, with no hover or
    // active state of its own, so all three slider states are that colour.
    'scrollbarSlider.background': token('--border'),
    'scrollbarSlider.hoverBackground': token('--border'),
    'scrollbarSlider.activeBackground': token('--border'),
    // Monaco colours brackets by cycling three hues; the base theme's gold,
    // orchid and blue would otherwise be the only foreign colours left here.
    'editorBracketHighlight.foreground1': hue('keyword'),
    'editorBracketHighlight.foreground2': hue('type'),
    'editorBracketHighlight.foreground3': hue('number'),
  });
};

/**
 * The token names each role is painted at, for the languages `code-view.tsx`
 * registers. A rule matches its own name and every dotted name below it, so
 * `keyword` covers `keyword.type` and `keyword.ts` alike; a name no rule states
 * keeps the default foreground, which is what the app shows everywhere else.
 */
const SYNTAX_RULES: readonly (readonly [string, Hue])[] = [
  ['comment', 'comment'],
  ['keyword', 'keyword'],
  // An HTML or XML tag is that document's keyword, and a CSS selector its type.
  ['tag', 'keyword'],
  ['string', 'string'],
  // A regex is a literal, and an attribute value is usually a string.
  ['regexp', 'string'],
  ['attribute.value', 'string'],
  ['number', 'number'],
  ['type', 'type'],
  // A Rust primitive is written as a keyword but named as a type.
  ['keyword.type', 'type'],
  ['attribute.name', 'type'],
  // Every tokenizer here puts a function's own name in `identifier`, and a
  // shell variable or a markdown reference is a name too.
  ['identifier', 'name'],
  ['variable', 'name'],
  ['predefined', 'name'],
];

/** The rules the theme states for `mode`, in the theme's own hues. */
const rules = (
  mode: Mode,
  palette: CSSStyleDeclaration,
): editor.ITokenThemeRule[] => {
  const hues = HUES[mode];
  const stated: editor.ITokenThemeRule[] = [];
  for (const [token, role] of SYNTAX_RULES) {
    const foreground = read(palette, hues[role]);
    if (foreground !== undefined) stated.push({ token, foreground });
  }
  // Nothing is inherited from the base theme, so the two font styles the
  // markdown grammar asks for are restated here.
  stated.push({ token: 'emphasis', fontStyle: 'italic' });
  stated.push({ token: 'strong', fontStyle: 'bold' });
  return stated;
};

/** The theme data for `mode`, read from the palette the document has now. */
const themeData = (mode: Mode): editor.IStandaloneThemeData => {
  const palette = getComputedStyle(document.documentElement);
  return {
    base: mode === 'dark' ? 'vs-dark' : 'vs',
    colors: colours(mode, palette),
    // Nothing is inherited, so this theme alone decides how code is painted: a
    // token name no rule states is the default foreground rather than a VS Code
    // colour leaking in from `vs-dark`.
    inherit: false,
    rules: rules(mode, palette),
  };
};

/**
 * The theme the document's own mode asks for, defined and named for it. The
 * renderer states its mode on the document before React renders and nothing
 * switches it afterwards (`src/index.html`), so the palette resolved here is
 * the one the editor will be painted on; a theme for the other mode could only
 * be built from these same tokens, which would be the wrong ones.
 */
export const defineCodeViewTheme = (): string => {
  const mode: Mode = document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'light';
  const name = THEME_BY_MODE[mode];
  editor.defineTheme(name, themeData(mode));
  return name;
};
