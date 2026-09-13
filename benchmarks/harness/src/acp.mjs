import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';

/** Adapt each ACP prompt to an independent run in the task workspace. */
export const acp = ({ mode, createRunner }) => {
  const sessions = new Map();

  return agent({ name: 'doric-' + mode })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: 'doric-' + mode, version: '0.0.1' },
    }))
    .onRequest(methods.agent.session.new, ({ params }) => {
      const sessionId = randomUUID();

      sessions.set(sessionId, { cwd: params.cwd });

      return { sessionId };
    })
    .onRequest(methods.agent.session.prompt, async (context) => {
      const session = sessions.get(context.params.sessionId);

      if (!session || session.controller) {
        throw RequestError.internalError();
      }

      const controller = new AbortController();

      session.controller = controller;

      const signal = AbortSignal.any([controller.signal, context.signal]);

      try {
        const runner = await createRunner();

        await runner.run(
          {
            cwd: session.cwd,
            signal,
            prompt: context.params.prompt
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('\n'),
          },
          (event) =>
            context.client.notify(methods.client.session.update, {
              sessionId: context.params.sessionId,
              update: sessionUpdate(event),
            }),
        );

        return { stopReason: signal.aborted ? 'cancelled' : 'end_turn' };
      } catch {
        if (signal.aborted) {
          return { stopReason: 'cancelled' };
        }

        process.stderr.write('Benchmark agent run failed.\n');

        throw RequestError.internalError();
      } finally {
        session.controller = undefined;
      }
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      sessions.get(params.sessionId)?.controller?.abort();
    });
};

const sessionUpdate = (event) => {
  if (event.type === 'message_delta') {
    return {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: event.delta },
    };
  }

  if (event.type === 'tool_started') {
    return {
      sessionUpdate: 'tool_call',
      toolCallId: event.callId,
      title: event.name,
      kind: 'other',
      status: 'in_progress',
      rawInput: event.input,
    };
  }

  if (event.type === 'tool_completed') {
    return {
      sessionUpdate: 'tool_call_update',
      toolCallId: event.callId,
      status: 'completed',
      rawOutput: event.output,
    };
  }

  if (event.type === 'tool_failed') {
    return {
      sessionUpdate: 'tool_call_update',
      toolCallId: event.callId,
      status: 'failed',
    };
  }

  return {
    sessionUpdate: 'plan',
    entries: [
      { content: event.status, priority: 'medium', status: 'in_progress' },
    ],
  };
};

/** Keep stdout exclusively reserved for ACP. */
export const serveAcp = async (options) => {
  const connection = acp(options).connect(
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  );

  await connection.closed;
};
