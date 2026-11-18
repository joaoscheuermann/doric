// The chat's module services (D9-17): the activation `services` and the
// optional providers seen through `whenAvailable`. Persistent work (Thread
// watches, history writes, notifications) runs on these, never on an
// element's services, so it outlives the conversation that started it.

import { ContractError, type Services } from 'bundle/contracts';

import type { HistorySnapshots } from '../api/history-contract.js';

let activation: Services | undefined;
let history: HistorySnapshots | undefined;

export const initChat = (services: Services | undefined): void => {
  activation = services;
};

/** The activation services; `unavailable` outside an active chat part. */
export const chatServices = (): Services => {
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
