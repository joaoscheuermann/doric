export const splashMinimumMs = 5_000;

const splashMarkup = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Doric</title>
    <style>
      html,
      body {
        height: 100%;
        margin: 0;
      }

      body {
        display: flex;
        align-items: center;
        justify-content: center;
        background: oklch(0.2244 0.0074 67.437);
        color: oklch(0.9288 0.0126 255.5078);
        font: 600 32px/1.2 system-ui, sans-serif;
      }
    </style>
  </head>
  <body>Doric</body>
</html>
`;

/** Data URL keeps the frameless splash window independent of the renderer bundle. */
export const splashUrl = `data:text/html;charset=utf-8,${encodeURIComponent(
  splashMarkup,
)}`;

/** The splash stays visible at least this long, even once the backend answers. */
export const remainingSplashMs = (elapsedMs: number): number =>
  Math.max(0, splashMinimumMs - elapsedMs);
