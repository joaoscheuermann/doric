// Dev-only: what the fake host seeds when it boots.
//
// The real host would have produced this Thread by running an agent against
// the fake Project's sandbox. The fake host runs no agent, so it writes the
// scripted history itself — one prompt and its answer.

/** The prompt the seeded conversation belongs to. */
export const SEEDED_PROMPT_ID = '00000000-0000-4000-8000-000000000001';

const SEEDED_PROMPT = 'Mostre o checkout com o botão de pagar.';

const SEEDED_PARAGRAPH =
  'O checkout tem o botão de pagar abaixo do resumo do pedido.';

/** Seeds the scripted history and returns how many events it wrote. */
export const seedDevWorkspace = ({ defaults, threads, log }) => {
  threads.setPromptId(defaults.threadId, SEEDED_PROMPT_ID);

  threads.appendMany({
    projectId: defaults.projectId,
    threadId: defaults.threadId,
    promptId: SEEDED_PROMPT_ID,
    values: [
      {
        type: 'prompt.accepted',
        event: {
          type: 'prompt.accepted',
          text: SEEDED_PROMPT,
          source: { kind: 'user' },
          queued: false,
        },
      },
      { type: 'prompt.started', event: { type: 'prompt.started' } },
      { type: 'agent.started', event: { type: 'agent.started' } },
      {
        type: 'text.delta',
        event: { type: 'text.delta', delta: SEEDED_PARAGRAPH },
      },
      {
        type: 'prompt.finished',
        event: {
          type: 'prompt.finished',
          status: 'completed',
          text: SEEDED_PARAGRAPH,
          source: { kind: 'user' },
        },
      },
    ],
  });

  const events = threads.counts()[defaults.threadId] ?? 0;

  log.note(
    `seeded ${events} events on Thread ${defaults.threadId} (project ${defaults.projectId}, prompt ${SEEDED_PROMPT_ID})`,
  );

  return { events };
};
