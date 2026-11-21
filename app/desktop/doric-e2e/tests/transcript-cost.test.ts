// AC5.4 (bundle isolation 5(b), section 7 of the step plan; OD46 (c)): the
// cost of drawing a long transcript. For the committed 500-call transcript
// (`support/transcript-500.ts`), the median over ten runs of the time from
// the click that selects the Thread to its whole transcript drawn: its oldest
// row (`TRANSCRIPT_START`) and its newest (`TRANSCRIPT_END`) both present, and
// every element a registrant draws a call or an input with holding what it
// rendered, two animation frames later. The chat fills a long transcript
// newest-first, so the newest row alone is drawn in the first pass; the
// oldest row present means every row is. Each run boots the workspace
// distribution with the real renderer and the drawing bundles (`terminal`,
// `threads`, `default` beside `files`) afresh.
//
// The build decides what one invocation measures: the built-in drawings
// (baseline) on a tree before the change, the registered elements on the
// change's tree. One invocation cannot build both, so the decision takes the
// session's earlier medians from the environment. On this kind of machine a
// baseline moves 3–13% between invocations, so one T₀ against a later T₁
// cannot resolve 10%: the decision needs at least three alternating
// baseline/registered pairs taken in one session.
//
// Procedure, on the reference machine, in one session, every invocation with
// DORIC_TRANSCRIPT_GATE=1 (skipped otherwise, as `startup-cost.test.ts` is):
//   1. Build a baseline tree (a scratch worktree at the commit before the
//      change, every drawing built in) and this tree.
//   2. Alternate, starting with the baseline: baseline → b₁, this tree → r₁,
//      baseline → b₂, this tree → r₂, baseline → b₃. Each invocation reports
//      its median ("median: … ms").
//   3. Run this tree once more with
//      DORIC_TRANSCRIPT_SESSION_MS="b₁,r₁,b₂,r₂,b₃" (more pairs may precede:
//      any odd count of at least five medians, in the order taken). Its own
//      median is the last registered one, rₙ. The test passes when the median
//      of the registered medians is at most 1.10 × the median of the
//      baselines, or when every pair rᵢ/bᵢ is at most 1.10.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { workspaceDistribution } from '../../doric/tests/support/core';
import { bootPlatform, page, startFakeHost, until } from './support/harness';
import { SIDEBAR_ROWS } from './support/prototype-states';
import { clickOn, go, inPage, waitFor } from './support/shell-page';
import {
  DRAWING_TAGS,
  serveTranscript,
  TRANSCRIPT_END,
  TRANSCRIPT_START,
  TRANSCRIPT_THREAD,
} from './support/transcript-500';
import { PROJECT_PATH, serveWorkspace } from './support/workspace-host';

const RUNS = 10;
const BUDGET = 1.1;
/** The fewest baseline/registered pairs a decision takes. */
const PAIRS = 3;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

/** One baseline median and the registered median taken after it. */
interface Pair {
  readonly baseline: number;
  readonly registered: number;
}

/**
 * The session's pairs: `session`, the medians taken so far in order,
 * baseline first and last, alternating; `measured`, this invocation's
 * registered median, which closes the last pair.
 */
const pairsOf = (session: string, measured: number): readonly Pair[] => {
  const medians = session.split(',').map((item) => Number(item.trim()));
  assert.ok(
    medians.every((value) => Number.isFinite(value) && value > 0),
    `DORIC_TRANSCRIPT_SESSION_MS holds a median that is not a time: ${session}`,
  );
  assert.ok(
    medians.length % 2 === 1 && medians.length >= 2 * PAIRS - 1,
    `DORIC_TRANSCRIPT_SESSION_MS needs at least ${PAIRS} pairs: baseline, registered, …, baseline (an odd count of at least ${2 * PAIRS - 1}), got ${medians.length}`,
  );
  const taken = [...medians, measured];
  return Array.from({ length: taken.length / 2 }, (_, index) => ({
    baseline: taken[2 * index] ?? 0,
    registered: taken[2 * index + 1] ?? 0,
  }));
};

/** What one run measured in the page. */
interface Measured {
  /** Click → last row drawn, in ms of the page's clock. */
  readonly elapsed: number;
  /** The element hosts drawn, by tag: which drawings were elements. */
  readonly hosts: Readonly<Record<string, number>>;
}

/**
 * Installed in the page before the click: marks the click's time on the
 * first pointer press, and watches the document until the transcript's
 * oldest and newest rows are drawn and every drawing element has rendered,
 * two frames later.
 */
const MEASURE = `(() => {
  const start = ${JSON.stringify(TRANSCRIPT_START)};
  const end = ${JSON.stringify(TRANSCRIPT_END)};
  const tags = ${JSON.stringify(DRAWING_TAGS)};
  const state = { start: undefined, elapsed: undefined, hosts: undefined };
  window.__transcriptCost = state;
  const drawn = () => {
    const editor = document.querySelector('chat-view [data-lexical-editor]');
    if (editor === null) return false;
    const text = editor.textContent ?? '';
    if (!text.includes(start) || !text.includes(end)) return false;
    return tags.every((tag) =>
      [...document.querySelectorAll('chat-view ' + tag)].every(
        (element) => element.childElementCount > 0,
      ),
    );
  };
  const frame = () => new Promise((done) => requestAnimationFrame(() => done()));
  let checking = false;
  const check = async () => {
    if (state.start === undefined || state.elapsed !== undefined || checking) return;
    if (!drawn()) return;
    checking = true;
    await frame();
    await frame();
    checking = false;
    if (!drawn() || state.elapsed !== undefined) return;
    state.elapsed = performance.now() - state.start;
    state.hosts = Object.fromEntries(
      tags.map((tag) => [tag, document.querySelectorAll('chat-view ' + tag).length]),
    );
    observer.disconnect();
  };
  const observer = new MutationObserver(() => void check());
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  document.addEventListener(
    'pointerdown',
    () => {
      state.start ??= performance.now();
      void check();
    },
    { capture: true },
  );
  return true;
})()`;

/** One fresh boot: select the Thread and wait until its transcript is drawn. */
const measureOnce = async (): Promise<Measured> => {
  const host = await startFakeHost(
    await workspaceDistribution({ drawings: true }),
  );
  serveWorkspace(host);
  serveTranscript(host);
  const booted = await bootPlatform({ host, shell: 'renderer' });

  try {
    const contents = (await booted.window('workspace')).webContents;
    await waitFor(contents, 'Account');
    await go(contents, PROJECT_PATH);
    await until(
      () =>
        inPage<boolean>(
          contents,
          `deepAll(${JSON.stringify(SIDEBAR_ROWS)}).some((row) => visible(row) && (row.textContent ?? '').trim().startsWith(${JSON.stringify(TRANSCRIPT_THREAD.name)}))`,
        ).then((found) => (found ? true : undefined)),
      `the "${TRANSCRIPT_THREAD.name}" row`,
    );
    await page<boolean>(contents, MEASURE);
    await clickOn(contents, SIDEBAR_ROWS, TRANSCRIPT_THREAD.name);

    return await until(
      () =>
        page<Measured | undefined>(
          contents,
          `window.__transcriptCost?.elapsed === undefined ? undefined : { elapsed: window.__transcriptCost.elapsed, hosts: window.__transcriptCost.hosts }`,
        ),
      'the transcript to be drawn',
      120_000,
    );
  } finally {
    await booted.dispose();
    await host.close();
  }
};

describe('the cost of drawing a 500-call transcript (AC5.4)', () => {
  test(`the median of ${RUNS} runs from selecting the Thread to its whole transcript drawn, within ${BUDGET} × the built-in baseline over ${PAIRS} or more alternating pairs`, {
    skip: process.env.DORIC_TRANSCRIPT_GATE !== '1',
  }, async (t) => {
    assert.equal(
      process.env.DORIC_TRANSCRIPT_BASELINE_MS,
      undefined,
      "DORIC_TRANSCRIPT_BASELINE_MS (one T₀) is no longer a decision: give the session's medians in DORIC_TRANSCRIPT_SESSION_MS",
    );
    const times: number[] = [];
    let hosts: Readonly<Record<string, number>> = {};

    for (let run = 0; run < RUNS; run += 1) {
      const measured = await measureOnce();
      times.push(measured.elapsed);
      hosts = measured.hosts;
      t.diagnostic(`run ${run + 1}: ${measured.elapsed.toFixed(1)} ms`);
    }

    const drawnByElements = Object.entries(hosts).filter(
      ([, count]) => count > 0,
    );
    const measuredMedian = median(times);
    t.diagnostic(
      `drawings: ${
        drawnByElements.length === 0
          ? 'built in'
          : drawnByElements.map(([tag, count]) => `${tag} ×${count}`).join(', ')
      }`,
    );
    t.diagnostic(`median: ${measuredMedian.toFixed(1)} ms`);

    const session = process.env.DORIC_TRANSCRIPT_SESSION_MS;
    if (session === undefined) return;
    const pairs = pairsOf(session, measuredMedian);
    for (const [index, { baseline, registered }] of pairs.entries())
      t.diagnostic(
        `pair ${index + 1}: built in ${baseline.toFixed(1)} ms, registered ${registered.toFixed(1)} ms, ratio ${(registered / baseline).toFixed(3)}`,
      );
    const baselines = median(pairs.map(({ baseline }) => baseline));
    const registereds = median(pairs.map(({ registered }) => registered));
    const ratio = registereds / baselines;
    t.diagnostic(
      `median of medians: built in ${baselines.toFixed(1)} ms, registered ${registereds.toFixed(1)} ms, ratio ${ratio.toFixed(3)}`,
    );
    assert.ok(
      ratio <= BUDGET ||
        pairs.every(
          ({ baseline, registered }) => registered <= BUDGET * baseline,
        ),
      `over ${pairs.length} pairs, the registered median of medians ${registereds.toFixed(1)} ms is more than ${BUDGET} × the built-in ${baselines.toFixed(1)} ms, and not every pair is within ${BUDGET}`,
    );
  });
});
