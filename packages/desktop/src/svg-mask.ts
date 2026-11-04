/**
 * The CSS image an SVG is drawn from as a mask: a `url("data:image/svg+xml,…")`
 * with the markup percent-encoded, so no character of it can end the quoted
 * URL. The SVG is decoded as an image, which runs no script and loads nothing.
 */
export const svgMask = (svg: string): string =>
  `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
