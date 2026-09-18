import type { AgentError } from '../types/agent.js';

/** Structured error thrown only for agent-owned lifecycle failures. */
export class AgentErrorObject extends Error {
  readonly data: AgentError;

  constructor(data: AgentError, options?: ErrorOptions) {
    super(data.message, options);

    this.name = 'AgentErrorObject';

    this.data = data;
  }
}
