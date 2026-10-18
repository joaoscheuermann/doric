import type { Cardinality } from '../define.js';
import type { Environment } from '../ids.js';
import { commandsMethods } from './commands.js';
import type { MethodSpecs } from './common.js';
import { eventsMethods } from './events.js';
import { hooksMethods } from './hooks.js';
import { logMethods } from './log.js';
import { menusMethods } from './menus.js';
import { modelsMethods, modelsProviderMethods } from './models.js';
import { navigationMethods } from './navigation.js';
import { regionsMethods } from './regions.js';
import { secretsBackendMethods, secretsMethods } from './secrets.js';
import { settingsMethods } from './settings.js';
import { skillsMethods } from './skills.js';
import { storageBackendMethods, storageMethods } from './storage.js';
import { toolsMethods } from './tools.js';
import { uiMethods } from './ui.js';
import { windowsMethods } from './windows.js';

export interface BasicContractSpec {
  readonly cardinality: Cardinality;
  readonly environments: readonly Environment[];
  readonly methods: MethodSpecs;
}

const spec = (
  cardinality: Cardinality,
  environments: readonly Environment[],
  methods: MethodSpecs,
): BasicContractSpec =>
  Object.freeze({
    cardinality,
    environments: Object.freeze([...environments]),
    methods,
  });

const all: readonly Environment[] = ['host', 'desktopMain', 'client'];

/** The fixed table of basic contracts: cardinality, environments and method spec. */
export const basicContracts = Object.freeze({
  'hooks/v1': spec('one', all, hooksMethods),
  'log/v1': spec('one', all, logMethods),
  'tools/v1': spec('one', ['host'], toolsMethods),
  'skills/v1': spec('one', ['host'], skillsMethods),
  'settings/v1': spec('one', ['host', 'desktopMain'], settingsMethods),
  'secrets/v1': spec('one', ['host'], secretsMethods),
  'secrets.backend/v1': spec('one', ['host'], secretsBackendMethods),
  'storage/v1': spec('one', ['host'], storageMethods),
  'storage.backend/v1': spec('one', ['host'], storageBackendMethods),
  'events/v1': spec('one', ['host'], eventsMethods),
  'models/v1': spec('one', ['host'], modelsMethods),
  'models.provider/v1': spec('many', ['host'], modelsProviderMethods),
  'commands/v1': spec('one', ['desktopMain', 'client'], commandsMethods),
  'ui/v1': spec('one', ['client'], uiMethods),
  'navigation/v1': spec('one', ['client'], navigationMethods),
  'regions/v1': spec('one', ['client'], regionsMethods),
  'windows/v1': spec('one', ['desktopMain'], windowsMethods),
  'menus/v1': spec('one', ['desktopMain'], menusMethods),
} satisfies Record<string, BasicContractSpec>);

export type BasicContractId = keyof typeof basicContracts;

export const isBasicContract = (id: string): id is BasicContractId =>
  Object.hasOwn(basicContracts, id);

export const basicContractSpec = (id: string): BasicContractSpec | undefined =>
  isBasicContract(id) ? basicContracts[id] : undefined;

export * from './commands.js';
export * from './common.js';
export * from './events.js';
export * from './hooks.js';
export * from './log.js';
export * from './menus.js';
export * from './models.js';
export * from './navigation.js';
export * from './regions.js';
export * from './secrets.js';
export * from './settings.js';
export * from './skills.js';
export * from './storage.js';
export * from './tools.js';
export * from './ui.js';
export * from './windows.js';
