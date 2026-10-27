// The skills a server serves through the MCP Skills extension
// (`io.modelcontextprotocol/skills`): Doric declares the extension and lists
// the skills of a server that declares it too. Listed only: no skill is ever
// loaded into a prompt.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';

import type { McpSkillView } from '../contracts/index.js';

/** The Skills extension's id in `capabilities.extensions`, on both sides. */
export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';

/** One page of `skills/list`; fields Doric does not show are ignored. */
const pageSchema = z.object({
  skills: z.array(
    z.object({
      uri: z.string(),
      frontmatter: z.object({ name: z.string(), description: z.string() }),
    }),
  ),
  nextCursor: z.string().optional(),
});

/**
 * Every page of the server's skills (following `nextCursor`) as views, in its
 * order; `[]` without a call when the server did not declare SKILLS_EXTENSION.
 * Rejects when a call fails or an entry lacks a string `uri`,
 * `frontmatter.name` or `frontmatter.description`; other fields are ignored.
 */
export const listSkills = async (
  client: Pick<Client, 'getServerCapabilities' | 'request'>,
  signal?: AbortSignal,
): Promise<McpSkillView[]> => {
  const extensions = client.getServerCapabilities()?.extensions ?? {};
  if (!Object.hasOwn(extensions, SKILLS_EXTENSION)) return [];

  const skills: McpSkillView[] = [];
  let cursor: string | undefined;

  do {
    const page = await client.request(
      { method: 'skills/list', params: { cursor } },
      pageSchema,
      { signal },
    );
    for (const { uri, frontmatter } of page.skills) {
      skills.push({ uri, ...frontmatter });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return skills;
};
