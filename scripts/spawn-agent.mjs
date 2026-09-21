#!/usr/bin/env node

import { setTimeout as delay } from 'node:timers/promises';

const HELP = `Usage: npm run doric:spawn-agent -- --prompt <text> [options]

Creates a Project, creates its root Thread, submits a human prompt, and
replays durable events until that prompt finishes. No A2A or Session API is used.

Options:
  --url <url>       Doric server (DORIC_URL or http://127.0.0.1:3000).
  --prompt <text>   Required human prompt.
  --terminate      Terminate the Project on completion or failure.
  -h, --help       Show help.

Configure providers through /config and credentials on the server, not here.
Projects remain reserved unless --terminate is supplied. Output contains only
resource IDs, event metadata, and the Project SSH URL; never SSH keys or event bodies.`;

const parseArgs = (args) => {
  const options = {
    url: process.env.DORIC_URL ?? 'http://127.0.0.1:3000',
    terminate: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--terminate') {
      options.terminate = true;
      continue;
    }
    if (argument !== '--url' && argument !== '--prompt')
      throw new Error('Unknown option. Use --help.');
    const value = args[++index];
    if (!value || value.startsWith('--'))
      throw new Error(`${argument} requires a value.`);
    options[argument.slice(2)] = value;
  }
  if (!options.prompt?.trim()) throw new Error('--prompt is required.');
  const url = new URL(options.url);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('--url must be an HTTP(S) server URL without credentials.');
  }
  return options;
};

const run = async (options) => {
  const base = options.url.replace(/\/+$/, '');
  const request = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`Doric request failed (HTTP ${response.status}).`);
    return response.json();
  };
  const project = await request('/projects', { name: 'spawn-agent project' });
  console.log(
    JSON.stringify({
      projectId: project.id,
      ssh: `${base}/projects/${project.id}/ssh`,
    }),
  );
  try {
    const thread = await request(`/projects/${project.id}/threads`, {
      name: 'spawn-agent root',
    });
    const { promptId } = await request(`/threads/${thread.id}/prompt`, {
      prompt: options.prompt,
    });
    console.log(
      JSON.stringify({ projectId: project.id, threadId: thread.id, promptId }),
    );
    let sequence = 0;
    for (;;) {
      const page = await request(
        `/threads/${thread.id}/events?afterSequence=${sequence}`,
      );
      for (const event of page.events) {
        if (event.sequence <= sequence) continue;
        sequence = event.sequence;
        console.log(
          JSON.stringify({
            projectId: event.projectId,
            threadId: event.threadId,
            promptId: event.promptId,
            sequence: event.sequence,
            type: event.type,
          }),
        );
        if (event.promptId !== promptId) continue;
        if (event.type !== 'prompt.finished') continue;
        if (event.event?.status === 'completed') return;
        if (
          event.event?.status === 'failed' ||
          event.event?.status === 'cancelled'
        ) {
          throw new Error(
            'The prompt failed or was cancelled. Inspect Thread replay for details.',
          );
        }
      }
      const state = await request(`/threads/${thread.id}`);
      if (state.state === 'failed' || state.state === 'cancelled') {
        throw new Error('The Thread ended before prompt completion.');
      }
      await delay(250);
    }
  } finally {
    if (options.terminate) {
      await request(`/projects/${project.id}/terminate`, {});
      console.log(
        JSON.stringify({ projectId: project.id, terminationRequested: true }),
      );
    } else {
      console.log(
        `Project remains reserved. Terminate with POST ${base}/projects/${project.id}/terminate`,
      );
    }
  }
};

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) console.log(HELP);
  else await run(options);
} catch (error) {
  // Do not print network errors, response bodies, prompts, or server-side secrets.
  console.error(
    error instanceof Error &&
      (error.message.startsWith('Doric request failed') ||
        error.message.startsWith('The prompt') ||
        error.message.startsWith('The Thread') ||
        error.message.startsWith('--') ||
        error.message.startsWith('Unknown option'))
      ? error.message
      : 'Doric client failed. Check the server URL and connectivity.',
  );
  process.exitCode = 1;
}
