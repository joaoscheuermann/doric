import { isContractError } from 'bundle/contracts';
import { agentNamePattern } from 'default/contracts';
import { reasoningEfforts, type SpawnOptions } from 'runtime/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

import type { ThreadToolPorts } from '../threads.js';

export const tool = defineTool({
  name: 'thread-spawn',
  description:
    "Create an agent thread and delegate a self-contained task. Returns immediately. The child shares this project workspace; its result arrives automatically in this chat. The reader can watch it, pause it, continue it and retry it, but never prompt or delete it, so the task must stand on its own. Give it a short title (up to 80 characters) naming the task, as the user sees it in the thread list; without one, the thread is named after the start of the prompt. Set agent to run the child as one of the agents listed under # Agents, with that agent's instructions; without it, the child is a plain thread. model and effort override the agent's defaults; without them the child uses the agent's, else yours.",
  input: z
    .object({
      prompt: z
        .string()
        .min(1)
        .refine((value) => value.trim().length > 0),
      title: z
        .string()
        .refine((value) => value.trim().length > 0)
        .optional(),
      agent: z.string().regex(agentNamePattern).optional(),
      model: z.string().min(1).optional(),
      effort: z.enum(reasoningEfforts).optional(),
    })
    .strict(),
  output: z.string(),
  execute: async (input, call, ports: ThreadToolPorts) => {
    const agent =
      input.agent === undefined
        ? undefined
        : await ports.resolveAgent(input.agent, call);
    const model = input.model ?? agent?.model;
    const effort = input.effort ?? agent?.effort;

    const options: SpawnOptions | undefined =
      agent === undefined && model === undefined && effort === undefined
        ? undefined
        : {
            ...(agent && {
              agent: {
                name: agent.name,
                source: agent.source,
                instructions: agent.instructions,
              },
            }),
            ...(model === undefined ? {} : { model }),
            ...(effort === undefined ? {} : { effort }),
          };

    try {
      return JSON.stringify(
        await ports.controls(call).spawn(input.prompt, input.title, options),
      );
    } catch (error) {
      // A model from the agent's definition: the reader also needs the agent.
      if (
        input.model === undefined &&
        agent?.model !== undefined &&
        isContractError(error) &&
        error.code === 'invalid_execution' &&
        typeof error.details === 'object' &&
        error.details !== null &&
        'issue' in error.details &&
        error.details.issue === 'model'
      ) {
        throw new Error(
          `Agent "${agent.name}" names model "${agent.model}", which its parent thread's provider does not list. ${error.message}`,
        );
      }
      throw error;
    }
  },
});
