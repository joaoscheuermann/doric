import type { ThreadEventView } from 'host';
import { defineTool } from 'tool';
import { z } from 'zod';

/** How much of one event a digest line carries. */
const summaryLimit = 400;

const excerpt = (value: string): string =>
  value.length <= summaryLimit ? value : `${value.slice(0, summaryLimit)}…`;

/**
 * A compact, always-safe summary of one persisted event. Assistant text and
 * deltas are excerpted directly; everything else falls back to excerpted JSON,
 * so a digest line never carries a whole tool payload unseen.
 */
const summary = (event: ThreadEventView): string => {
  const payload = event.event;

  if (typeof payload === 'string') return excerpt(payload);

  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.text === 'string') return excerpt(record.text);
    if (typeof record.delta === 'string') return excerpt(record.delta);
  }

  try {
    return excerpt(JSON.stringify(payload));
  } catch {
    return excerpt(String(payload));
  }
};

const digest = (event: ThreadEventView) => ({
  sequence: event.sequence,
  type: event.type,
  promptId: event.promptId,
  summary: summary(event),
});

export default defineTool({
  name: 'thread-events',
  description:
    "Read a bounded page of a direct child chat's persisted events after an exclusive sequence cursor, as a compact digest. The returned nextSequence continues the read. Prefer thread-get: the child's result already arrives automatically, so reach for this only to inspect intermediate progress.",
  input: z
    .object({
      threadId: z.uuid(),
      afterSequence: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
  output: z.string(),
  execute: async (_sandbox, host, input) => {
    const page = await host.threads.events(
      input.threadId,
      input.afterSequence ?? 0,
      input.limit ?? 20,
    );

    return JSON.stringify({
      events: page.events.map(digest),
      ...(page.nextSequence === undefined
        ? {}
        : { nextSequence: page.nextSequence }),
    });
  },
});
