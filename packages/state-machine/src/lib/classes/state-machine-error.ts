import type { StateMachineErrorData } from '../types/state-machine.js';

/** Identifies an engine failure while a state-machine definition is running. */
export class StateMachineError<States extends string = string> extends Error {
  readonly data: StateMachineErrorData<States>;

  constructor(data: StateMachineErrorData<States>, options?: ErrorOptions) {
    super(data.message, options);

    this.name = 'StateMachineError';

    this.data = data;
  }
}
