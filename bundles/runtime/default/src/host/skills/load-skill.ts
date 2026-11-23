import { posix } from 'node:path';

import type { Call } from 'bundle/contracts';
import type { ProviderMessage } from 'llms';
import { defineTool, excerpt, type Tool } from 'tool';
import { z } from 'zod';

import { skillSourcesMethods } from '../../contracts/index.js';
import type { SkillReadPorts } from '../ports.js';
import { loadedSkills } from './loaded.js';
import { type CatalogSkill, skillBody } from './sources.js';

/** The longest result `load_skill` returns, before the `excerpt` marker. */
const LOADED_SKILL_MAX_CHARS = 64_000;

/** The source line, if any, and body of one listed skill, read now from its origin. */
const read = async (
  { origin }: CatalogSkill,
  call: Call,
  ports: SkillReadPorts,
): Promise<readonly string[]> => {
  switch (origin.kind) {
    case 'bundle':
      return [origin.body];
    case 'workspace':
      return [
        `From the workspace: \`${origin.path}\`. Paths in it are relative to \`${posix.dirname(origin.path)}\`.`,
        skillBody(await ports.lease.readFile(origin.path, call)),
      ];
    case 'source': {
      // The source bounds the read; the prompt's signal ends it.
      const source = (await ports.skillSources(call)).find(
        ({ bundleId }) => bundleId === origin.bundleId,
      );
      if (source === undefined)
        throw new Error(
          `The skill source ${origin.bundleId} is not available.`,
        );
      const parsed = skillSourcesMethods.read.output.safeParse(
        await source.api.read({ reference: origin.reference }, call),
      );
      if (!parsed.success)
        throw new Error(
          `The skill source ${origin.bundleId} answered an invalid skill: ${parsed.error.message}`,
        );
      const { origin: line, text } = parsed.data;
      return [...(line === undefined ? [] : [line]), skillBody(text)];
    }
  }
};

export const LOAD_SKILL_TOOL = 'load_skill';

/** The note a load of a skill the history already holds unchanged answers. */
const alreadyLoaded = (name: string): string =>
  `Skill ${name} is already loaded above; follow it.`;

/** A text without one trailing newline. */
const unterminated = (text: string): string =>
  text.endsWith('\n') ? text.slice(0, -1) : text;

/** The failure of a name `listed` does not hold. */
const unknownSkill = (
  name: string,
  listed: ReadonlyMap<string, CatalogSkill>,
): Error =>
  new Error(
    listed.size === 0
      ? `Unknown skill id "${name}". No skill can be loaded now.`
      : `Unknown skill id "${name}". Call load_skill with one of: ${[
          ...listed.keys(),
        ]
          .map((locator) => `\`${locator}\``)
          .join(', ')}.`,
  );

/**
 * Always built; input schema never changes during a run: `{ name: string }`,
 * strict; output a string. listed() and history() read on every call.
 * Name in listed(): reads again from its source (bundle body /
 * RuntimeLeaseV1.readFile / the source's `read`); fresh output =
 * `# Skill: <name>`, the source line when there is one, the body, joined by
 * '\n\n', cut to 64 000 with `...`. If the most recent entry of <name> in
 * loadedSkills(history()) is not cut and its text equals the fresh output
 * (ignoring one trailing '\n' on either side) → `Skill <name> is already
 * loaded above; follow it.`; else the fresh output.
 * Failures (thrown): name not in listed() while it holds locators →
 * `Unknown skill id "<name>". Call load_skill with one of: \`a\`, \`b\`.`
 * (listed() order); listed() empty → `Unknown skill id "<name>". No skill can
 * be loaded now.`; read failure → `The skill <name> could not be loaded:
 * <cause message>` with the cause attached. Nothing read for an unknown name.
 */
export const loadSkillTool = (
  listed: () => ReadonlyMap<string, CatalogSkill>,
  history: () => readonly ProviderMessage[],
  call: Call,
  ports: SkillReadPorts,
): Tool =>
  defineTool({
    name: LOAD_SKILL_TOOL,
    description:
      'Loads a skill listed under "Skills to load" in your instructions or in a later "Skills changed" message, and returns its instructions. Call it before starting work that a listed skill\'s description matches.',
    input: z
      .object({
        name: z
          .string()
          .describe("The skill's id, as listed in the Skill column."),
      })
      .strict(),
    output: z.string(),
    strict: true,
    execute: async ({ name }, _call, deps: SkillReadPorts) => {
      const skills = listed();
      const skill = skills.get(name);
      if (skill === undefined) throw unknownSkill(name, skills);
      let parts: readonly string[];
      try {
        parts = await read(skill, call, deps);
      } catch (cause) {
        throw new Error(
          `The skill ${name} could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
      const fresh = excerpt(
        [`# Skill: ${name}`, ...parts].join('\n\n'),
        LOADED_SKILL_MAX_CHARS,
      );
      const last = loadedSkills(history()).find(
        ({ locator }) => locator === name,
      );
      return last !== undefined &&
        !last.cut &&
        unterminated(last.text) === unterminated(fresh)
        ? alreadyLoaded(name)
        : fresh;
    },
  })
    .bind(ports)
    .toTool(call);
