/**
 * A headless Chrome the conversation harness can be driven in.
 *
 * This is every part of the driving that speaks the DevTools protocol — opening a
 * browser on a page, reading an expression's value back, and the few input events a
 * person's hand would send. What the checks are, and what they mean, is stated by
 * `conversation-drive.mjs`; this module only carries them out.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket from 'ws';

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Repeats `attempt` until it answers something, and fails loudly when it never does:
 * a step that cannot run is the one result this driving must never report as a pass.
 */
export const waitFor = async (
  what,
  attempt,
  { timeout = 20000, interval = 100 } = {},
) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const answer = await attempt();
    if (answer !== undefined && answer !== null && answer !== false)
      return answer;
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeout} ms waiting for ${what}.`);
    await sleep(interval);
  }
};

/** A port nothing is listening on, so two browsers never share one. */
const freePort = () =>
  new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

/**
 * Where a click should land inside one element: over the first words it holds, so
 * the caret goes where the text is. An element with no words — the empty composer —
 * falls back to the box it occupies.
 */
export const pointIn = (host) => `(() => {
  const target = ${host};
  if (!target) return null;
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    const start = text.search(/\\S/);
    if (start === -1) continue;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + 1);
    const box = range.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
  }
  const box = target.getBoundingClientRect();
  return box.width > 0 && box.height > 0
    ? { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    : null;
})()`;

/**
 * Where the first word of an element is, so the pointer can be put over it.
 *
 * A word is what the checks select, by double-click, rather than by a drag: a drag
 * the protocol dispatches is not a drag the browser reads as a selection — the
 * selection comes back collapsed and the surface is asked nothing — while a
 * double-click selects the word under the pointer.
 */
export const wordIn = (host) => `(() => {
  const target = ${host};
  if (!target) return null;
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    const start = text.search(/\\S/);
    if (start === -1) continue;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + 1);
    const box = range.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
  }
  return null;
})()`;

/**
 * The DevTools protocol over one WebSocket: `send` answers with a method's result,
 * and never leaves a call pending without saying so.
 */
const connect = async (url) => {
  const socket = new WebSocket(url);
  await new Promise((done, fail) => {
    socket.once('open', done);
    socket.once('error', fail);
  });
  const pending = new Map();
  let next = 0;
  socket.on('message', (data) => {
    const message = JSON.parse(String(data));
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined)
      waiter.fail(new Error(message.error.message));
    else waiter.done(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      next += 1;
      const id = next;
      pending.set(id, { done, fail });
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id))
          fail(new Error(`The DevTools protocol never answered ${method}.`));
      }, 20000);
    });
  return { close: () => socket.close(), send };
};

/**
 * Opens `url` in a headless Chrome and answers the page it made: one expression run
 * against the document, and the input events a person's hand would send it.
 *
 * The viewport is a known size so a screenshot is readable and the coordinates the
 * checks ask for are stable, and the browser is this process's child, so closing the
 * page stops it.
 */
export const openBrowser = async ({
  chrome,
  url,
  width = 1280,
  height = 900,
}) => {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'doric-conversation-harness-'));
  const browser = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${String(port)}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      `--window-size=${String(width)},${String(height)}`,
      url,
    ],
    { stdio: 'ignore' },
  );
  /** Why the browser never opened, when it never did. */
  let failure;
  browser.on('error', (error) => {
    failure = error;
  });
  const target = await waitFor(
    'the headless browser to open the page',
    async () => {
      if (failure !== undefined) {
        throw new Error(`The browser could not be started: ${failure.message}`);
      }
      try {
        const response = await fetch(
          `http://127.0.0.1:${String(port)}/json/list`,
        );
        const targets = await response.json();
        return targets.find(
          (entry) => entry.type === 'page' && entry.webSocketDebuggerUrl,
        );
      } catch {
        return undefined;
      }
    },
    { timeout: 30000 },
  );
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    deviceScaleFactor: 1,
    height,
    mobile: false,
    width,
  });

  /** Runs one expression in the page and answers its value. */
  const evaluate = async (expression) => {
    const { exceptionDetails, result } = await cdp.send('Runtime.evaluate', {
      awaitPromise: true,
      expression,
      returnByValue: true,
    });
    if (exceptionDetails !== undefined) {
      throw new Error(
        `The page threw while running ${expression}: ${
          exceptionDetails.exception?.description ?? exceptionDetails.text ?? ''
        }`,
      );
    }
    return result.value;
  };

  const press = (at, clickCount) =>
    cdp.send('Input.dispatchMouseEvent', {
      button: 'left',
      buttons: 1,
      clickCount,
      type: 'mousePressed',
      x: at.x,
      y: at.y,
    });
  const release = (at, clickCount) =>
    cdp.send('Input.dispatchMouseEvent', {
      button: 'left',
      buttons: 0,
      clickCount,
      type: 'mouseReleased',
      x: at.x,
      y: at.y,
    });
  const move = (at) =>
    cdp.send('Input.dispatchMouseEvent', {
      button: 'left',
      buttons: 0,
      type: 'mouseMoved',
      x: at.x,
      y: at.y,
    });

  return {
    close: () => {
      cdp.close();
      browser.kill('SIGTERM');
    },
    evaluate,
    /** One click at a point, which is what puts the caret somewhere. */
    async click(at) {
      await move(at);
      await press(at, 1);
      await release(at, 1);
    },
    /** A double-click, which is how a person selects one word. */
    async selectWord(at) {
      await move(at);
      await press(at, 1);
      await release(at, 1);
      await press(at, 2);
      await release(at, 2);
    },
    /** Forgets the selection, so the next one is the only one on the page. */
    async clearSelection() {
      await evaluate('window.getSelection().removeAllRanges(); true');
    },
    /** Types into whatever holds the caret, as a keyboard would. */
    insertText(text) {
      return cdp.send('Input.insertText', { text });
    },
    /**
     * Cmd+Enter, which is what the surface sends a prompt with. 4 is the protocol's
     * Meta bit, and the surface accepts Ctrl (2) as well, so either key does.
     */
    async pressSend() {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', {
          code: 'Enter',
          key: 'Enter',
          modifiers: 4,
          nativeVirtualKeyCode: 13,
          type,
          windowsVirtualKeyCode: 13,
        });
      }
    },
    /** The page as a PNG, for the driver to write wherever it was told to. */
    async screenshot() {
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
      });
      return Buffer.from(data, 'base64');
    },
  };
};
