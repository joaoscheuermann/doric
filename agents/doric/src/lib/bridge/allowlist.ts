// The host-side allowlist of the desktop bridge (stage 8 HR-10, stage 9
// R-ALLOW): the only contract methods a desktop caller reaches on the host.
// They are the replacements of today's semantic IPC channels (stage 8 §21.1,
// revised table) and the platform's own distribution and recovery calls.
// Everything else, such as `secrets/v1.resolve`/`resolveByKind`,
// `runtime/v1.recover`/`dispose`, the prompt-scoped controls of
// `runtime.threads/v1`, `runtime.lease/v1.exec`/`writeFile` and
// `terminal/v1.run`, answers `unavailable`: today no secret and no prompt
// control crosses the desktop boundary (HC-007).

import { ContractError } from 'bundle/contracts';

const allowed: Readonly<Record<string, readonly string[]>> = {
  // Platform: distribution (HR-2..HR-4), recovery actions (HR-6), storage
  // identity (R-HOSTID) and desktop quarantine reports.
  'doric.catalog/v1': [
    'get',
    'distribution',
    'artifact',
    'watch',
    'disable',
    'resetComposition',
  ],
  'doric.diagnostics/v1': ['report'],
  // doric:projects:* and the `/projects` namespace.
  'runtime/v1': [
    'projects',
    'createProject',
    'renameProject',
    'setProjectColor',
    'terminateProject',
    'deleteProject',
    'watchProject',
  ],
  // doric:threads:* and the `/threads` namespace.
  'runtime.threads/v1': [
    'threads',
    'thread',
    'createThread',
    'renameThread',
    'setThreadCwd',
    'terminateThread',
    'deleteThread',
    'prompt',
    'resume',
    'rewind',
    'pause',
    'queue',
    'resumeQueue',
    'queuedPrompt',
    'editQueued',
    'removeQueued',
    'usage',
    'watchThread',
  ],
  // Files, git and Project resources, read with the call scope.
  'runtime.lease/v1': [
    'files',
    'tree',
    'file',
    'diff',
    'changes',
    'fileDiff',
    'resources',
    'git',
    'branches',
  ],
  // doric:terminals:* and the terminal half of `/projects`.
  'runtime.terminals/v1': [
    'list',
    'create',
    'snapshot',
    'input',
    'resize',
    'stop',
    'watchProject',
  ],
  // doric:config:get / update.
  'host-config/v1': ['current', 'replace'],
  // doric:providers:kinds / models.
  'models/v1': ['kinds', 'catalog'],
  // doric:credentials:*; never `resolve`, `resolveByKind` or `redactions`.
  'secrets/v1': ['list', 'create', 'update', 'delete'],
  // doric:tools:catalog.
  'tools/v1': ['catalog'],
  // doric:resources:host.
  'resources/v1': ['host'],
};

const allowlist: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(allowed).map(([contract, methods]) => [
    contract,
    new Set(methods),
  ]),
);

/** Whether a desktop caller may reach `contract` `method` on the host. */
export const isBridgeAllowed = (contract: string, method: string): boolean =>
  allowlist.get(contract)?.has(method) === true;

/** Throws the refusal a method outside the allowlist answers. */
export const assertBridgeAllowed = (contract: string, method: string): void => {
  if (!isBridgeAllowed(contract, method)) {
    throw new ContractError(
      'unavailable',
      `${contract} ${method} is not available to the desktop.`,
      { contract, method },
    );
  }
};

/** The allowlist as data, for tests and diagnostics. */
export const bridgeAllowlist = (): Readonly<
  Record<string, readonly string[]>
> => allowed;
