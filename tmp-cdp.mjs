// One-off dev helper: talk to the Electron page over CDP.

import { writeFileSync } from 'node:fs';

import WebSocket from 'ws';

const [action, ...rest] = process.argv.slice(2);

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');
const ws = new WebSocket(page.webSocketDebuggerUrl, {
  maxPayload: 256 * 1024 * 1024,
});
await new Promise((res, rej) => {
  ws.once('open', res);
  ws.once('error', rej);
});

let id = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.exceptionDetails)
    return { error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

if (action === 'text') {
  const selector = rest[0];
  const expr = selector
    ? `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '(no match)')`
    : `document.body.innerText`;
  console.log(await evaluate(expr));
} else if (action === 'eval') {
  console.log(JSON.stringify(await evaluate(rest.join(' ')), null, 2));
} else if (action === 'shot') {
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  writeFileSync(
    rest[0] ?? '/tmp/shot.png',
    Buffer.from(shot.result.data, 'base64'),
  );
  console.log('saved', rest[0] ?? '/tmp/shot.png');
}
ws.close();
