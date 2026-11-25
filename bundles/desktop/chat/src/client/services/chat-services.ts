// The chat's module services (D9-17): the activation `services` and the
// optional providers seen through `whenAvailable`. Persistent work (Thread
// watches, history writes, notifications) runs on these, never on an
// element's services, so it outlives the conversation that started it.

import { type ClientServices, ContractError } from 'bundle/contracts';

import type { HistorySnapshots } from '../api/history-contract.js';

let activation: ClientServices | undefined;
let history: HistorySnapshots | undefined;

export const initChat = (services: ClientServices | undefined): void => {
  activation = services;
};

/**
 * The activation services, host contracts over Connect (`ClientServices`);
 * `unavailable` outside an active chat part.
 */
export const chatServices = (): ClientServices => {
  if (activation === undefined) {
    throw new ContractError('unavailable', 'The chat bundle is not active.');
  }

  return activation;
};

/** `history.snapshots/v1` while a provider is available (D9-19). */
export const currentHistory = (): HistorySnapshots | undefined => history;

export const setHistory = (next: HistorySnapshots | undefined): void => {
  history = next;
};
