// A host part's own skills (spec `docs/designs/grpc-processes.md`, S62d3,
// SK-2): after `activate` resolves, the SDK registers each
// `src/skills/<folder>/SKILL.md` of the bundle directory through
// `skills/v1.Register`, as the calling instance, tracked for replay.

import { join } from 'node:path';

import { ConnectError } from '@connectrpc/connect';

import { isContractError } from '../../contracts/error.js';
import { SkillsService } from '../../contracts/gen/doric/skills/v1/skills_pb.js';
import { fromConnectError } from '../../contracts/status.js';
import { discoverSkills, parseSkillDocument } from '../../loader/skills.js';
import type { HostContext } from './context.js';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Registers the bundle's own skills through `skills/v1`, as the calling instance: each
 * `src/skills/<folder>/SKILL.md` of the bundle directory, folders in lexical order, a folder without `SKILL.md`
 * skipped (`discoverSkills` under the directory `context.assets.extract('src/skills')` answers). Each file is read
 * with `context.assets.read('src/skills/<folder>/SKILL.md')`, so `host.assets` must list it, and parsed as the build
 * and the kernel parse it (`parseSkillDocument`, `frontmatterAvailability: true`). Each skill is one
 * `context.registrations.track(SkillsService, (client) => client.register({ skill: { name, description, body,
 * allowedTools, indexText? }, options: { alwaysAvailable: alwaysAvailable ?? false, order? } }))`, awaited one after
 * the other in file order; a tracked skill is replayed to a new `skills/v1` provider instance.
 *
 * Resolves with the names registered, in order. Never rejects: no `src/skills/` (or none with a `SKILL.md`)
 * resolves `[]` and logs nothing; a failure of the discovery, of a read, of the parse or of `Register` skips that
 * skill (the discovery: all of them), logs `context.log.warn('skill not registered', { path, code?, error })` — `code`
 * the `ContractError` code when there is one — and goes on with the next. Registers nothing after
 * `context.signal` aborted.
 */
export const registerBundleSkills = async (
  context: Pick<HostContext, 'assets' | 'registrations' | 'log' | 'signal'>,
): Promise<readonly string[]> => {
  const skipped = (path: string, reason: unknown): void => {
    // A refused `Register` rejects with a `ConnectError` carrying the Doric code.
    const error =
      reason instanceof ConnectError ? fromConnectError(reason) : reason;

    context.log.warn('skill not registered', {
      path,
      ...(isContractError(error) ? { code: error.code } : {}),
      error: messageOf(error),
    });
  };
  let paths: readonly string[];

  try {
    paths = await discoverSkills(
      join(await context.assets.extract('src/skills'), 'src'),
    );
  } catch (error) {
    skipped('src/skills', error);

    return [];
  }

  const registered: string[] = [];

  for (const relative of paths) {
    if (context.signal.aborted) {
      break;
    }

    const path = `src/${relative}`;

    try {
      const text = new TextDecoder().decode(await context.assets.read(path));
      const { skill, alwaysAvailable, order } = parseSkillDocument(
        text,
        `skill "${path}"`,
        { frontmatterAvailability: true },
      );

      await context.registrations.track(SkillsService, (client) =>
        client.register({
          skill: {
            name: skill.name,
            description: skill.description,
            body: skill.body,
            allowedTools: [...skill.allowedTools],
            ...(skill.indexText === undefined
              ? {}
              : { indexText: skill.indexText }),
          },
          options: {
            alwaysAvailable: alwaysAvailable ?? false,
            ...(order === undefined ? {} : { order }),
          },
        }),
      );
      registered.push(skill.name);
    } catch (error) {
      skipped(path, error);
    }
  }

  return registered;
};
