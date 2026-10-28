import { randomUUID } from 'node:crypto';

import { EventsV1 } from 'bundle/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

import { askedEvent, askInputSchema } from '../../contracts/index.js';
import { threadsOf } from '../threads.js';

const ASK_DESCRIPTION =
  "Ask the user one or more multiple-choice questions. The chat shows them as an interactive block where the user picks options or types a free answer. Use it when progress depends on a decision only the user can make: an approval, a choice between alternatives, or a missing requirement; do not ask what the workspace or your tools can answer. Write the questions and options in the user's language and mark the options you recommend. After calling it, end your turn without further tool calls: the answers arrive as the next user request, and until then nothing is approved or decided. Only the main thread can ask; a subagent puts its question in its result for its coordinator. A new call replaces any question still unanswered.";

const ASKED =
  'The questions are shown to the user. End your turn now without further tool calls; the answers arrive as the next user request.';

const REFUSED =
  'Not asked: only the main thread can ask the user. Put the question in your result instead, so your coordinator can ask the user or decide.';

/**
 * `ask`: shows the user one to five multiple-choice questions.
 * - On a main Thread (`origin` not `agent`) it writes `threads.asked/v1` with
 *   a fresh `askId`, under the call's Project, Thread and prompt, and returns
 *   the success text. The new ask supersedes any unanswered one.
 * - On an agent Thread it writes nothing and returns the refusal text; that
 *   is a tool result, not an error.
 * - Input that fails `askInputSchema` is rejected before `execute`.
 */
export const tool = defineTool({
  name: 'ask',
  description: ASK_DESCRIPTION,
  input: askInputSchema,
  output: z.string(),
  execute: async (input, call, services): Promise<string> => {
    const threadId = call.scope?.threadId;
    const thread =
      threadId === undefined
        ? undefined
        : await threadsOf(services, call).thread(threadId, call);

    if (thread?.origin === 'agent') return REFUSED;

    await services
      .use(EventsV1)
      .append(askedEvent, { askId: randomUUID(), ...input }, call);

    return ASKED;
  },
});
