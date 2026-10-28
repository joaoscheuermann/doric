/**
 * Whether the dev server's overlay shows a runtime error of the window. The
 * dev server sends this function to the page as its source text, so it reads
 * nothing from outside itself.
 *
 * Left out, along the error's `cause` chain:
 * - a ResizeObserver loop: the browser reporting that an observer resized what
 *   it observes and deferred the rest to the next frame, a notice and not a
 *   failure;
 * - an error raised by an artifact preview's module (served from
 *   `doric://app/artifacts/`): that module is a Project's code, built into an
 *   immutable revision, and its failures are the preview's, which its console
 *   keeps, not the app's. React's #520 is one, its cause in the preview.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function showsInOverlay(error) {
  for (let at = error, depth = 0; at && depth < 8; depth += 1) {
    const { message, stack, cause } = /** @type {Error} */ (at);
    if (/^ResizeObserver loop/.test(String(message ?? ''))) return false;
    if (String(stack ?? '').includes('doric://app/artifacts/')) return false;
    at = cause;
  }
  return true;
}

module.exports = { showsInOverlay };
