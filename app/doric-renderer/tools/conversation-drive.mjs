#!/usr/bin/env node
/**
 * Drives the conversation harness in a headless Chrome and reports what a person
 * would see and do there.
 *
 * The renderer's test target is DOM-free by design, so the rules about the Lexical
 * document — the caret in the composer, a sealed answer that takes no words, which
 * selection offers a comment, what a closed fold holds — have no other runnable
 * proof. This is that proof run without a person: it opens
 * `tools/conversation-harness.html`, drives the page the way a hand would, and
 * prints one JSON report of every check with the evidence behind it.
 *
 * Run it from the repository root:
 *
 *     node app/doric-renderer/tools/conversation-drive.mjs
 *
 * `DORIC_URL` points it at another page, `SHOT` moves the screenshot, and `CHROME`
 * names another browser. If nothing answers at the URL's origin it starts
 * `nx serve doric-renderer` itself and waits for the page to be served.
 *
 * The browser it drives through is `conversation-browser.mjs`, which is where the
 * DevTools protocol lives; this file is what the checks are and what they mean.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  openBrowser,
  pointIn,
  sleep,
  waitFor,
  wordIn,
} from './conversation-browser.mjs';

const projectRoot = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);
const targetUrl =
  process.env['DORIC_URL'] ??
  'http://localhost:4200/tools/conversation-harness.html';
const shot =
  process.env['SHOT'] ?? join('/tmp', 'doric-conversation-harness.png');
const chrome =
  process.env['CHROME'] ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const origin = new URL(targetUrl).origin;

/** Progress goes to stderr, so stdout is the report and nothing else. */
const note = (message) => {
  process.stderr.write(`conversation-drive: ${message}\n`);
};

/**
 * The harness page as the server sends it, or nothing while it cannot: the dev
 * server answers an unknown path with the app's own `index.html`, so a page that
 * does not name the harness entry is not the harness page.
 */
const harnessPage = async () => {
  try {
    const response = await fetch(targetUrl, {
      headers: { accept: 'text/html' },
    });
    if (!response.ok) return undefined;
    const body = await response.text();
    return body.includes('conversation-harness.js') ? body : undefined;
  } catch {
    return undefined;
  }
};

/** Whether anything is listening at the URL's origin at all. */
const originAnswers = async () => {
  try {
    await fetch(origin, { headers: { accept: 'text/html' } });
    return true;
  } catch {
    return false;
  }
};

let server;

/** Starts the renderer's dev server, which is what serves the harness page. */
const startServer = async () => {
  note(`nothing is listening on ${origin}; starting the dev server`);
  server = spawn('npx', ['nx', 'serve', 'doric-renderer'], {
    cwd: projectRoot,
    detached: true,
    env: {
      ...process.env,
      NX_SOCKET_DIR: process.env['NX_SOCKET_DIR'] ?? '/tmp/nx-tmp',
    },
    // Piped and forwarded rather than inherited: `nx` runs a target in a
    // pseudo-terminal whenever its own stdout is one, and that terminal wants a
    // stdin this driver does not have to give it.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => process.stderr.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  server.on('error', (error) => {
    note(`the dev server could not be started: ${error.message}`);
  });
  server.on('exit', (code) => {
    note(`the dev server exited with ${String(code)}`);
  });
};

const stopServer = () => {
  if (server === undefined || server.pid === undefined) return;
  // The dev server is a process group: npx spawns nx, which spawns webpack-cli.
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
};

/** The turn the surface is answering: the last one the log gave the agent. */
const LAST_ANSWER = `[...document.querySelectorAll('.doric-turn[data-role="agent"]')].at(-1)`;
/** The answer already left behind, which a comment must not be offered on. */
const FIRST_ANSWER_TURN = `document.querySelectorAll('.doric-turn[data-role="agent"]')[0]`;
const COMPOSER = `document.querySelector('.doric-turn[data-draft="true"] [data-doric-body]')`;
const proseOf = (turn) =>
  `${turn}?.querySelector('[data-part="text"] [data-doric-body]') ?? null`;

/**
 * What the page shows and what a hand does to it. Every check reads the document
 * itself — never the harness's own bookkeeping — so what it reports is what a
 * person would see.
 */
const checks = [
  {
    name: 'the surface renders every turn with its chrome and avatar',
    async run(page) {
      const seen = await page.evaluate(
        `(() => {
          const turns = [...document.querySelectorAll('.doric-turn')];
          return {
            avatars: turns.filter((turn) => turn.querySelector('.doric-avatar') !== null).length,
            cards: document.querySelectorAll('.doric-comment-card').length,
            chrome: turns.filter((turn) => turn.querySelector('[data-doric-chrome]') !== null).length,
            code: document.querySelectorAll('.doric-code').length,
            composers: turns.filter((turn) => turn.dataset.draft === 'true').length,
            headings: document.querySelectorAll('.doric-h2').length,
            links: document.querySelectorAll('.doric-link').length,
            parts: document.querySelectorAll('[data-part]').length,
            turns: turns.length,
          };
        })()`,
      );
      const expected = 5;
      const wrong = [];
      if (seen.turns !== expected)
        wrong.push(`${String(seen.turns)} turns, expected ${String(expected)}`);
      if (seen.chrome !== expected)
        wrong.push(`${String(seen.chrome)} turns carry chrome`);
      if (seen.avatars !== expected)
        wrong.push(`${String(seen.avatars)} turns wear an avatar`);
      if (seen.composers !== 1)
        wrong.push(`${String(seen.composers)} composers, expected 1`);
      if (seen.cards < 1)
        wrong.push('the composed prompt rendered no comment card');
      if (seen.headings < 1 || seen.code < 1 || seen.links < 1) {
        wrong.push('the markdown answer lost its heading, code block or link');
      }
      return {
        detail: `${String(seen.turns)} turns (${String(seen.parts)} parts), ${String(seen.avatars)} avatars, ${String(seen.cards)} comment card, ${String(seen.headings)} heading, ${String(seen.code)} code block, ${String(seen.links)} link`,
        ok: wrong.length === 0,
        wrong,
      };
    },
  },
  {
    name: 'clicking into the composer and typing inserts the text',
    async run(page) {
      const typed = 'typed into the composer';
      const at = await page.evaluate(pointIn(COMPOSER));
      if (at === null) throw new Error('the composer has no box to click into');
      await page.click(at);
      await page.insertText(typed);
      const held = await waitFor(
        'the composer to hold what was typed',
        async () => {
          const text = await page.evaluate(`(${COMPOSER})?.textContent ?? ''`);
          return text.includes(typed) ? text : undefined;
        },
        { timeout: 5000 },
      );
      return {
        detail: `the composer holds ${JSON.stringify(held)}`,
        ok: true,
        wrong: [],
      };
    },
  },
  {
    name: 'typing into a sealed answer changes nothing',
    async run(page) {
      const before = await page.evaluate(`(${LAST_ANSWER})?.textContent ?? ''`);
      const at = await page.evaluate(pointIn(proseOf(LAST_ANSWER)));
      if (at === null)
        throw new Error('the last answer has no prose to click into');
      await page.click(at);
      await page.insertText('words the answer must refuse');
      await sleep(300);
      const after = await page.evaluate(`(${LAST_ANSWER})?.textContent ?? ''`);
      return {
        detail: `the answer still holds ${String(before.length)} characters, and ${String(after.length)} after typing into it`,
        ok: after === before && !after.includes('words the answer must refuse'),
        wrong:
          after === before
            ? []
            : ['the sealed answer changed while it was typed into'],
      };
    },
  },
  {
    name: 'a selection in the last answer offers the Comment button',
    async run(page) {
      await page.clearSelection();
      const at = await page.evaluate(wordIn(proseOf(LAST_ANSWER)));
      if (at === null)
        throw new Error('the last answer has no prose to select in');
      await page.selectWord(at);
      const label = await waitFor(
        'the Comment button to appear over the selection',
        async () => {
          const text = await page.evaluate(
            `document.querySelector('.doric-selection-toolbar button')?.textContent ?? ''`,
          );
          return text.trim().length > 0 ? text.trim() : undefined;
        },
        { timeout: 5000 },
      );
      const selected = await page.evaluate(
        "window.getSelection()?.toString() ?? ''",
      );
      return {
        detail: `selecting ${JSON.stringify(selected)} offers ${JSON.stringify(label)}`,
        ok: label === 'Comment',
        wrong:
          label === 'Comment'
            ? []
            : [`the button reads ${JSON.stringify(label)}`],
      };
    },
  },
  {
    name: 'a selection in an earlier answer offers nothing',
    async run(page) {
      // Clicking away first: the selection the check above made is not this one.
      const away = await page.evaluate(pointIn(COMPOSER));
      if (away !== null) await page.click(away);
      await page.clearSelection();
      await sleep(200);
      const at = await page.evaluate(wordIn(proseOf(FIRST_ANSWER_TURN)));
      if (at === null)
        throw new Error('the earlier answer has no prose to select in');
      await page.selectWord(at);
      await sleep(600);
      const seen = await page.evaluate(
        `({
          offered: document.querySelector('.doric-selection-toolbar') !== null,
          selected: window.getSelection()?.toString() ?? '',
        })`,
      );
      // The selection has to have happened: an earlier answer offering nothing while
      // nothing was selected would prove the check, not the rule.
      const ok = seen.offered === false && seen.selected.trim().length > 0;
      return {
        detail: `selecting ${JSON.stringify(seen.selected)} offers ${seen.offered ? 'a Comment button' : 'nothing'}`,
        ok,
        wrong: ok
          ? []
          : [
              seen.offered
                ? 'an earlier answer offered a Comment button'
                : 'the earlier answer held no selection to refuse',
            ],
      };
    },
  },
  {
    name: 'opening a fold shows its content and closing it leaves nothing inside',
    async run(page) {
      const stateOf = () =>
        page.evaluate(
          `(() => {
            const part = ${FIRST_ANSWER_TURN}?.querySelector('[data-part="thinking"]');
            const body = part?.querySelector('[data-doric-body]');
            return {
              expanded: part?.querySelector('[data-doric-head]')?.getAttribute('aria-expanded') ?? null,
              length: (body?.textContent ?? '').trim().length,
            };
          })()`,
        );
      const closed = await stateOf();
      const head = await page.evaluate(
        `(() => {
          const part = ${FIRST_ANSWER_TURN}?.querySelector('[data-part="thinking"]');
          const box = part?.querySelector('[data-doric-head]')?.getBoundingClientRect();
          return box && box.width > 0 ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
        })()`,
      );
      if (head === null)
        throw new Error('the reasoning fold has no head to click');
      await page.click(head);
      const opened = await waitFor(
        'the opened fold to show its reasoning',
        async () => {
          const state = await stateOf();
          return state.expanded === 'true' && state.length > 0
            ? state
            : undefined;
        },
        { timeout: 5000 },
      );
      await page.click(head);
      const shut = await waitFor(
        'the closed fold to hold nothing',
        async () => {
          const state = await stateOf();
          return state.expanded === 'false' && state.length === 0
            ? state
            : undefined;
        },
        { timeout: 5000 },
      );
      const ok = closed.length === 0 && closed.expanded === 'false';
      return {
        detail: `closed: ${String(closed.length)} characters; opened: ${String(opened.length)}; closed again: ${String(shut.length)}`,
        ok,
        wrong: ok
          ? []
          : [
              `the fold started with ${String(closed.length)} characters inside it`,
            ],
      };
    },
  },
  {
    name: 'the composer sends what it holds and the answer arrives',
    async run(page) {
      await page.clearSelection();
      const at = await page.evaluate(pointIn(COMPOSER));
      if (at === null) throw new Error('the composer has no box to click into');
      await page.click(at);
      const held = await page.evaluate(`(${COMPOSER})?.textContent ?? ''`);
      await page.pressSend();
      const sent = await waitFor(
        "the host to receive the composer's words",
        async () => {
          const prompts = await page.evaluate('window.__harness?.sent ?? []');
          return prompts.length > 0 ? prompts : undefined;
        },
        { timeout: 5000 },
      );
      const cleared = await waitFor(
        'the composer to empty itself once the prompt was accepted',
        async () => {
          const text = await page.evaluate(
            `(${COMPOSER})?.textContent ?? null`,
          );
          return text === '' ? text : undefined;
        },
        { timeout: 5000 },
      );
      const ok = sent.length === 1 && sent[0] === held.trim() && cleared === '';
      return {
        detail: `the host received ${JSON.stringify(sent)}, the composer held ${JSON.stringify(held)} and now holds nothing`,
        ok,
        wrong: ok
          ? []
          : [
              `the host received ${JSON.stringify(sent)} for ${JSON.stringify(held)}`,
            ],
      };
    },
  },
  {
    name: 'the page is written to a screenshot',
    async run(page) {
      writeFileSync(shot, await page.screenshot());
      return { detail: `written to ${shot}`, ok: true, wrong: [] };
    },
  },
];

const main = async () => {
  const report = {
    checks: [],
    failure: null,
    harness: null,
    ok: false,
    shot,
    url: targetUrl,
  };
  let page;
  try {
    if (!(await originAnswers())) await startServer();
    await waitFor(
      `the harness page at ${targetUrl} (is the dev server building, and does webpack.config.js add the harness entry?)`,
      harnessPage,
      { interval: 500, timeout: 300000 },
    );
    note(`the harness page answers at ${targetUrl}`);
    page = await openBrowser({ chrome, url: targetUrl });
    await waitFor(
      'the conversation surface to render',
      async () =>
        page.evaluate(
          `document.querySelectorAll('.doric-turn').length >= 5 || undefined`,
        ),
      { timeout: 30000 },
    );
    // The dev server's type checker draws an overlay that covers the page and takes
    // the pointer input with it, so it goes before anything is clicked.
    const removed = await page.evaluate(
      `(() => {
        const overlays = [
          ...document.querySelectorAll('webpack-dev-server-client-overlay, iframe#webpack-dev-server-client-overlay'),
        ];
        for (const overlay of overlays) overlay.remove();
        return overlays.length;
      })()`,
    );
    note(`removed ${String(removed)} dev-server overlay(s)`);
    for (const check of checks) {
      try {
        const { detail, ok, wrong } = await check.run(page);
        report.checks.push({ detail, name: check.name, ok, wrong });
        note(`${ok ? 'ok' : 'FAILED'} — ${check.name}`);
      } catch (error) {
        report.checks.push({
          detail: error instanceof Error ? error.message : String(error),
          name: check.name,
          ok: false,
          wrong: ['the step could not run'],
        });
        note(`FAILED — ${check.name}: ${String(error)}`);
        break;
      }
    }
    report.harness = await page.evaluate(
      `window.__harness ? {
        log: window.__harness.log.length,
        rewound: window.__harness.rewound,
        sent: window.__harness.sent,
      } : null`,
    );
    report.ok =
      report.checks.length === checks.length &&
      report.checks.every((check) => check.ok);
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
    note(`FAILED — ${report.failure}`);
  } finally {
    page?.close();
    stopServer();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
};

await main();
