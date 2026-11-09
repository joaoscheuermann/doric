// T-4.5.8, the startup cost of the live splash art (SR12): the median boot
// with the shader at most 150 ms above the median boot with the shaded image,
// in one build. Run on the reference Mac (Apple silicon, macOS) for the 4.5
// pull request with DORIC_STARTUP_GATE=1; skipped otherwise, and it fails
// where the unset boots draw no shader (no WebGPU: the gate cannot run there).

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { describe, test } from 'node:test';

import { coreDistribution } from '../../doric/tests/support/core';
import { type Booted, bootPlatform, startFakeHost } from './support/harness';

const BOOTS = 10;
const BOUND_MS = 150;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

/** The splash's art while its window is open: `shader`, `shaded` or ''. */
const artOf = async (booted: Booted): Promise<string | undefined> => {
  const contents = booted.platform.splashWindow?.webContents;

  if (contents === undefined || contents.isDestroyed()) {
    return undefined;
  }

  try {
    return (await contents.executeJavaScript(
      `document.querySelector('[data-art-pane]')?.firstElementChild?.dataset.art ?? ''`,
    )) as string;
  } catch {
    return undefined;
  }
};

/**
 * Watches the splash until it shows its art or closes. `settled` answers the
 * art: `shader`, `shaded`, or '' when the splash closed (or `stop` was called)
 * before either was drawn.
 */
const watchArt = (
  booted: Booted,
): { readonly settled: Promise<string>; stop(): void } => {
  let running = true;
  const settled = (async () => {
    while (running) {
      const art = await artOf(booted);

      if (art === 'shader' || art === 'shaded') {
        return art;
      }

      if (art === undefined && booted.platform.splashWindow === undefined) {
        return '';
      }

      await new Promise((done) => setTimeout(done, 25));
    }

    return '';
  })();

  return {
    settled,
    stop: () => {
      running = false;
    },
  };
};

describe('startup cost of the splash art (T-4.5.8)', () => {
  test(`the shader boots at most ${BOUND_MS} ms slower than the shaded image (medians of ${BOOTS / 2})`, {
    skip: process.env.DORIC_STARTUP_GATE !== '1',
  }, async (t) => {
    const previous = process.env.DORIC_SPLASH_ART;
    const shader: number[] = [];
    const shaded: number[] = [];
    const missing: number[] = [];

    try {
      for (let boot = 0; boot < BOOTS; boot += 1) {
        const live = boot % 2 === 0;

        if (live) {
          delete process.env.DORIC_SPLASH_ART;
        } else {
          process.env.DORIC_SPLASH_ART = 'shaded';
        }

        const host = await startFakeHost(await coreDistribution());
        const started = performance.now();
        const booted = await bootPlatform({ host });
        const art = watchArt(booted);

        try {
          await booted.window('workspace');

          const elapsed = performance.now() - started;
          // The art may still be deciding (S32's 1000 ms limit).
          const drawn = await Promise.race([
            art.settled,
            new Promise<string>((done) => setTimeout(() => done(''), 2_000)),
          ]);

          (live ? shader : shaded).push(elapsed);
          t.diagnostic(
            `boot ${boot + 1} ${live ? 'unset' : 'shaded'}: ${elapsed.toFixed(1)} ms, art ${drawn || 'none'}`,
          );

          if (live && drawn !== 'shader') {
            missing.push(boot + 1);
          }
        } finally {
          art.stop();
          await art.settled;
          await booted.dispose();
          await host.close();
        }
      }
    } finally {
      if (previous === undefined) {
        delete process.env.DORIC_SPLASH_ART;
      } else {
        process.env.DORIC_SPLASH_ART = previous;
      }
    }

    const withShader = median(shader);
    const withShaded = median(shaded);

    t.diagnostic(`median unset (shader): ${withShader.toFixed(1)} ms`);
    t.diagnostic(`median shaded: ${withShaded.toFixed(1)} ms`);
    assert.deepEqual(
      missing,
      [],
      `unset boots that drew no canvas[data-art="shader"] (no WebGPU: the gate cannot run here): ${missing.join(', ')}`,
    );
    assert.ok(
      withShader - withShaded <= BOUND_MS,
      `the shader's median ${withShader.toFixed(1)} ms is more than ${BOUND_MS} ms above the shaded median ${withShaded.toFixed(1)} ms`,
    );
  });
});
