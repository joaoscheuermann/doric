import type { HandlerContext } from '@connectrpc/connect';
import type { ServiceEntry } from 'bundle/host';
import { SessionService } from 'runtime/contracts/gen/doric/executor/session/v1/session_pb.js';

import type { SessionState } from './router.js';
import { type Enter, fakeOf } from './router-fakes.js';
import {
  chunksOf,
  type RecordItem,
  wireSource,
  writeOf,
} from './router-wire.js';

/** The in-memory `executor.session/v1` and its fake; `current` names the session of the latest run. */
export const sessionFake = (
  enter: Enter,
  current: () => string,
): { readonly session: SessionState; readonly entry: ServiceEntry } => {
  /** The sessions cancelled so far, and the `WatchCancel`s waiting for theirs. */
  const cancelled = new Set<string>();
  const waiting = new Map<string, Set<() => void>>();
  /** Called once a `WatchCancel` of the session yielded its item. */
  const yielded = new Map<string, Set<() => void>>();
  const session: SessionState = {
    format: undefined,
    parts: {},
    records: [],
    steering: [],
    attachments: new Map(),
    recordFailure: undefined,
    onEvent: () => undefined,
    watches: [],
    readHold: undefined,
    cancel: (id = current()) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          yielded.get(id)?.delete(done);
          reject(
            new Error(
              `No WatchCancel of session ${id} yielded its item in 5 s.`,
            ),
          );
        }, 5_000);
        const done = () => {
          clearTimeout(timer);
          yielded.get(id)?.delete(done);
          resolve();
        };
        yielded.set(id, (yielded.get(id) ?? new Set()).add(done));
        cancelled.add(id);
        for (const answer of [...(waiting.get(id) ?? [])]) answer();
      }),
  };

  return {
    session,
    entry: fakeOf(SessionService, {
      readHistory: async function* (
        request: { sessionId: string; part: string },
        context: HandlerContext,
      ) {
        enter(SessionService, 'readHistory', context, {
          sessionId: request.sessionId,
          part: request.part,
        });
        await session.readHold;
        yield {
          item: {
            case: 'head' as const,
            value:
              session.format === undefined ? {} : { format: session.format },
          },
        };
        const value = session.parts[request.part];
        if (value !== undefined) {
          for (const chunk of chunksOf(value)) {
            yield { item: { case: 'chunk' as const, value: chunk } };
          }
        }
      },
      record: async (
        requests: AsyncIterable<{ item: RecordItem }>,
        context: HandlerContext,
      ) => {
        const items: RecordItem[] = [];
        for await (const { item } of requests) items.push(item);
        const head = items[0];
        enter(SessionService, 'record', context, {
          sessionId: head?.case === 'head' ? head.value.sessionId : undefined,
        });
        const write = writeOf(items);
        session.records.push(write);
        if (session.recordFailure !== undefined) throw session.recordFailure;
        if (write.history !== undefined) {
          session.format = write.history.format;
          Object.assign(session.parts, write.history.parts);
        }
        if (write.event !== undefined) session.onEvent(write.event);
        return {};
      },
      takeSteers: (request: { sessionId: string }, context: HandlerContext) => {
        enter(SessionService, 'takeSteers', context, {
          sessionId: request.sessionId,
        });
        return {
          steers: session.steering.splice(0).map(({ prompt, source }) => ({
            prompt,
            source: wireSource(source),
          })),
        };
      },
      describeAttachment: (
        request: { sessionId: string; id: string },
        context: HandlerContext,
      ) => {
        enter(SessionService, 'describeAttachment', context, {
          sessionId: request.sessionId,
          id: request.id,
        });
        const attachment = session.attachments.get(request.id);
        return attachment === undefined ? {} : { attachment };
      },
      watchCancel: async function* (
        request: { sessionId: string },
        context: HandlerContext,
      ) {
        const id = request.sessionId;
        enter(SessionService, 'watchCancel', context, { sessionId: id });
        const watch = { sessionId: id, signal: context.signal, items: 0 };
        session.watches.push(watch);
        const answered = await new Promise<boolean>((resolve) => {
          const answer = () => {
            waiting.get(id)?.delete(answer);
            resolve(true);
          };
          if (cancelled.has(id)) {
            resolve(true);
            return;
          }
          waiting.set(id, (waiting.get(id) ?? new Set()).add(answer));
          context.signal.addEventListener(
            'abort',
            () => {
              waiting.get(id)?.delete(answer);
              resolve(false);
            },
            { once: true },
          );
        });
        if (!answered) return;
        watch.items += 1;
        try {
          yield {};
        } finally {
          for (const done of [...(yielded.get(id) ?? [])]) done();
        }
      },
    }),
  };
};
