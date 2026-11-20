// The skills a server serves through the MCP Skills extension
// (`io.modelcontextprotocol/skills`): Doric declares the extension, lists the
// skills of a server that declares it too, and reads one skill's text only on
// demand, through `mcp/v1.readSkill` or the skill source it provides to
// `default` (`default.skill-sources/v1`).

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { SkillSourceEntry } from 'default/contracts';
import { z } from 'zod';

import {
  type McpServerView,
  type McpSkillView,
  serverSlug,
} from '../contracts/index.js';

/** The Skills extension's id in `capabilities.extensions`, on both sides. */
export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';

/** How long one `resources/read` of a skill may take. */
const SKILL_READ_TIMEOUT_MS = 30_000;

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

/**
 * The text of one skill resource: `client.readResource({ uri }, { signal,
 * timeout: SKILL_READ_TIMEOUT_MS })`, answering the first content entry that
 * carries `text`. Rejects with the SDK's error when the read fails, times out
 * or is aborted, and with an Error when no entry carries text. Does not check
 * the listing: the caller does.
 */
export const readSkillText = async (
  client: Pick<Client, 'readResource'>,
  uri: string,
  signal?: AbortSignal,
): Promise<string> => {
  const { contents } = await client.readResource(
    { uri },
    { signal, timeout: SKILL_READ_TIMEOUT_MS },
  );

  for (const content of contents) {
    if ('text' in content && typeof content.text === 'string') {
      return content.text;
    }
  }

  throw new Error('The skill has no text content.');
};

/** The skill source's `reference` of one skill: the server id, `\n`, the uri. */
export const skillReference = (serverId: string, uri: string): string =>
  `${serverId}\n${uri}`;

/**
 * The server id and uri of a `skillReference`, split at its first `\n`, or
 * undefined when either part would be empty.
 */
export const parseSkillReference = (
  reference: string,
): { readonly serverId: string; readonly uri: string } | undefined => {
  const at = reference.indexOf('\n');
  if (at <= 0 || at === reference.length - 1) return undefined;
  return { serverId: reference.slice(0, at), uri: reference.slice(at + 1) };
};

/** The origin line of a skill the server named `name` serves at `uri`. */
export const skillOrigin = (name: string, uri: string): string =>
  `From the MCP server "${name}" (\`${uri}\`). Its other files are not available.`;

/**
 * The skills of the connected servers among `servers`, in their order, each
 * in its server's order, as the skill source lists them: grouped by the
 * server's slug and read by `skillReference`.
 */
export const skillSourceEntries = (
  servers: readonly McpServerView[],
): SkillSourceEntry[] =>
  servers
    .filter(({ status }) => status.state === 'connected')
    .flatMap(({ id, name: serverName, skills }) =>
      skills.map(({ uri, name, description }) => ({
        group: serverSlug(serverName),
        name,
        description,
        reference: skillReference(id, uri),
      })),
    );
