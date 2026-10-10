// The core's activation services, read by the core's own elements. An outlet
// the window bootstrap creates is not made by ui/v1.create, so it has no
// `element.services`; the core elements use the services of the activation
// that defined them.

import { ContractError, type Services } from 'bundle/contracts';

let current: Services | undefined;

export const setCoreServices = (services: Services | undefined): void => {
  current = services;
};

export const coreServices = (): Services => {
  if (current === undefined) {
    throw new ContractError(
      'unavailable',
      'The core client part is not active in this window.',
    );
  }

  return current;
};
