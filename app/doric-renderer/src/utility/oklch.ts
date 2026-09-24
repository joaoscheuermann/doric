/**
 * `oklch(…)` text as the `#rrggbb` — or `#rrggbbaa` — colour Monaco can read.
 *
 * Monaco's colour parser takes `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`,
 * `rgba()`, `hsl()` and `hsla()`, and nothing else, while every token in
 * `src/styles.css` is written as `oklch(…)`. This is the transform between the
 * two, following the chain CSS Color 4 gives for `oklch()`: Oklch to Oklab,
 * Oklab to linear sRGB through the published matrix, the sRGB transfer
 * function, then clamp and round to the eight bits a screen has.
 *
 * Only the syntax the palette is written in is read: three numbers, an optional
 * `/ alpha`, and an optional `%` on the lightness or the alpha. Anything else —
 * `none`, a hue in `rad` or `turn`, a percentage chroma, which CSS reads as a
 * percentage of 0.4 rather than of 1 — is `undefined`, so a caller can fall
 * back rather than paint a colour the text never stated.
 */

/** A number as CSS writes one, without a unit. */
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The number `text` states, or `undefined` when it states something else. */
const number = (text: string): number | undefined =>
  NUMBER.test(text) ? Number(text) : undefined;

/**
 * A component that CSS allows as a percentage of one: the lightness and the
 * alpha. The chroma is not one of them, so it is read by `number` alone.
 */
const fraction = (text: string): number | undefined => {
  const percent = text.endsWith('%');
  const value = number(percent ? text.slice(0, -1) : text);
  if (value === undefined) return undefined;
  return percent ? value / 100 : value;
};

/** The four numbers of an `oklch(…)` value, or nothing when it is not one. */
type Oklch = {
  readonly lightness: number;
  readonly chroma: number;
  readonly hue: number;
  readonly alpha: number;
};

/** The components of an `oklch(…)` value, or `undefined` for other text. */
const parse = (value: string): Oklch | undefined => {
  const body = /^oklch\(([^()]*)\)$/i.exec(value.trim())?.[1];
  if (body === undefined) return undefined;

  const [components = '', alpha = '1', ...rest] = body.split('/');
  if (rest.length > 0) return undefined;

  const parts = components.trim().split(/\s+/);
  if (parts.length !== 3) return undefined;
  const [l = '', c = '', h = ''] = parts;

  const lightness = fraction(l);
  const chroma = number(c);
  const hue = number(h);
  const opacity = fraction(alpha.trim());
  if (
    lightness === undefined ||
    chroma === undefined ||
    hue === undefined ||
    opacity === undefined ||
    // CSS clamps a negative chroma away as invalid; the value is not a colour.
    chroma < 0
  ) {
    return undefined;
  }

  return { lightness, chroma, hue, alpha: opacity };
};

/** A colour as three channel values, in whichever space a step works in. */
type Channels = readonly [number, number, number];

/** Oklch to Oklab: the chroma and the hue as the two Cartesian axes. */
const oklab = ({ lightness, chroma, hue }: Oklch): Channels => {
  const radians = (hue * Math.PI) / 180;
  return [lightness, chroma * Math.cos(radians), chroma * Math.sin(radians)];
};

/**
 * Oklab to linear sRGB: the three cone responses, cubed, through the matrix
 * CSS Color 4 publishes for them.
 */
const linearSrgb = ([l, a, b]: Channels): Channels => {
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
};

/**
 * The sRGB transfer function: linear light as the 0..1 value a screen is given.
 * Nothing at or below the threshold reaches the power, which also keeps a
 * negative channel from becoming `NaN` on its way to being clamped away.
 */
const encode = (linear: number): number =>
  linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;

/** One channel as two hex digits, clamped to the 0..255 a screen has. */
const byte = (value: number): string =>
  Math.min(255, Math.max(0, Math.round(value * 255)))
    .toString(16)
    .padStart(2, '0');

/**
 * The colour an `oklch(…)` value states, as `#rrggbb` — or `#rrggbbaa` when
 * its alpha is not 1 — and `undefined` for text that is not one.
 */
export const oklchToHex = (value: string): string | undefined => {
  const colour = parse(value);
  if (colour === undefined) return undefined;

  const [red, green, blue] = linearSrgb(oklab(colour));
  const hex = `#${byte(encode(red))}${byte(encode(green))}${byte(encode(blue))}`;
  return colour.alpha === 1 ? hex : `${hex}${byte(colour.alpha)}`;
};
