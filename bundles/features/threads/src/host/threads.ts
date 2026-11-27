import type { Call } from 'bundle/contracts';
import type { AgentDefinition } from 'default/contracts';
import type { ThreadControl } from 'runtime/contracts';

/** What a delegation tool reaches, per call. */
export interface ThreadToolPorts {
  /**
   * The direct-child controls of the prompt `call` belongs to
   * (`runtime.threads/v1` `Spawn`…`Terminate` under `call`'s scope). Each
   * method answers the kernel's value and rejects with the provider's
   * `ContractError` (code, message and details kept).
   */
  controls(call: Call): ThreadControl;
  /**
   * `default.agents/v1.Resolve{name}` under `call`. When no provider of
   * `default.agents/v1` can answer, rejects with
   * `Error('Agent types are unavailable in this runtime.')`; every other
   * failure unchanged (`not_found`, `invalid_definition`, `invalid_input`).
   */
  resolveAgent(name: string, call: Call): Promise<AgentDefinition>;
}
