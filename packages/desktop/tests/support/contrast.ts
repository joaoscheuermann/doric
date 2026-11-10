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
 * The inverse of `linearRgb`: linear sRGB to oklch, from Oklab's own
 * definition (Björn Ottosson, https://bottosson.github.io/posts/oklab/).
 * Linear sRGB goes through his M1 matrix to cone responses. Then the cube
 * root, then M2 to Lab, then `c = hypot(a, b)` and `h = atan2(b, a)` in
 * degrees.
 *
 * Accepts: any unit-linear sRGB, including values outside `0..1`.
 * Returns: `l` and `c` unclamped, and `h` in `[0, 360)`. When `c` is about 0,
 * `h` is whatever `atan2` gives, normalised, and has no meaning.
 * Fails: never.
 * Invariant: `linearRgb(oklch(rgb))` equals `rgb` within 1e-6 per channel.
 */
export const oklch = ([red, green, blue]: LinearRgb): Oklch => {
  const long = Math.cbrt(
    0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue,
  );
  const medium = Math.cbrt(
    0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue,
  );
  const short = Math.cbrt(
    0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue,
  );
  const l = 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short;
  const a = 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short;
  const b = 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short;
  const degrees = (Math.atan2(b, a) * 180) / Math.PI;

  return { l, c: Math.hypot(a, b), h: (degrees + 360) % 360 };
};

/** Below this chroma a colour has no hue worth mixing. */
const achromatic = 1e-6;

/**
 * What CSS `color-mix(in oklch, from, to amount)` paints. `amount` is the
 * share of `to` as a fraction from `0` to `1`, so `60%` is `0.6`. Note the
 * order: this is the reverse of `blend`, whose alpha weights the first
 * argument.
 * `l` and `c` mix linearly. `h` mixes along the shorter arc. A colour with
 * `c < 1e-6` has no hue and takes the other colour's hue; when both have no
 * hue, `h = 0`.
 *
 * Returns: the mix converted back to linear sRGB through `linearRgb`,
 * unclamped.
 * Fails: never. An `amount` outside `0..1` extrapolates and is not
 * validated.
 * Invariant: `amount = 0` gives `from` and `amount = 1` gives `to`, each
 * within 1e-6.
 */
export const mixOklch = (
  from: LinearRgb,
  to: LinearRgb,
  amount: number,
): LinearRgb => {
  const start = oklch(from);
  const end = oklch(to);
  const startHue = start.c < achromatic ? end.h : start.h;
  const endHue = end.c < achromatic ? startHue : end.h;
  const both = start.c < achromatic && end.c < achromatic;
  const turn = ((((endHue - startHue) % 360) + 540) % 360) - 180;
  const mix = (left: number, right: number): number =>
    left + (right - left) * amount;

  return linearRgb({
    l: mix(start.l, end.l),
    c: mix(start.c, end.c),
    h: both ? 0 : startHue + turn * amount,
  });
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
