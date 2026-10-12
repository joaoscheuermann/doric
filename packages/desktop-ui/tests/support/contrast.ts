/**
 * A colour as a contrast is read: the unit-linear sRGB that WCAG's ratio and
 * alpha compositing are both defined in.
 *
 * The palette states its colours in oklch, which is the right notation for
 * choosing them and the wrong one for judging them: a ratio is measured on the
 * light a screen adds, and an alpha is mixed there too. Linear sRGB is the space
 * both happen in, so it is the one this module hands around — `0` to `1` per
 * channel, unclamped, because a value outside that gamut is a real answer about
 * the palette and clamping it would hide that.
 */
export type LinearRgb = readonly [number, number, number];

/** An oklch colour as the palette states it: lightness, chroma, hue degrees. */
export type Oklch = {
  readonly l: number;
  readonly c: number;
  readonly h: number;
};

/**
 * The oklch to linear-sRGB conversion, from Oklab's own definition: the three
 * cone responses, cubed, then the matrix that brings them to sRGB's primaries.
 */
export const linearRgb = ({ c, h, l }: Oklch): LinearRgb => {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const cube = (value: number): number => value ** 3;
  const long = cube(l + 0.3963377774 * a + 0.2158037573 * b);
  const medium = cube(l - 0.1055613458 * a - 0.0638541728 * b);
  const short = cube(l - 0.0894841775 * a - 1.291485548 * b);

  return [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ];
};

/**
 * What a screen shows where one colour is drawn over another at an alpha: the
 * two mixed channel by channel, which is what a `/10` in a class name means.
 */
export const blend = (
  top: LinearRgb,
  bottom: LinearRgb,
  alpha: number,
): LinearRgb => [
  alpha * (top[0] ?? 0) + (1 - alpha) * (bottom[0] ?? 0),
  alpha * (top[1] ?? 0) + (1 - alpha) * (bottom[1] ?? 0),
  alpha * (top[2] ?? 0) + (1 - alpha) * (bottom[2] ?? 0),
];

/** WCAG's relative luminance: the light a colour adds, weighted by cone response. */
const luminance = (colour: LinearRgb): number =>
  0.2126 * (colour[0] ?? 0) +
  0.7152 * (colour[1] ?? 0) +
  0.0722 * (colour[2] ?? 0);

/**
 * WCAG's contrast ratio between two colours, from `1` (the same colour) up: the
 * lighter luminance plus a floor, over the darker one plus the same floor, so
 * the answer never divides by zero and reads the same both ways round.
 */
export const contrastRatio = (left: LinearRgb, right: LinearRgb): number => {
  const a = luminance(left);
  const b = luminance(right);

  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
