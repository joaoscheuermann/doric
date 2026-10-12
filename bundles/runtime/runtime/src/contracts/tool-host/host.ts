import type { TerminalControl } from './terminals.js';
import type { ThreadControl } from './threads.js';
import type { WorkspaceControl } from './workspace.js';

/**
 * The per-prompt capability facade the runtime's runner builds for every
 * prompt and hands to the executor. Its types live with the `runtime` contracts
 * because only `runtime` builds it; tool bundles reach the same capabilities
 * through `runtime.threads/v1`, `runtime.workspace/v1` and `terminal/v1`.
 */
export interface Host {
  /** Control over the direct child threads of one active parent prompt. */
  readonly threads: ThreadControl;
  /** The working directory of the prompt's own Thread. */
  readonly workspace: WorkspaceControl;
  readonly terminals?: TerminalControl;
  // Future namespaces are added per concrete need, never as a dumping ground:
  // readonly config: ConfigControl;
  // readonly vms: VmControl;
  // readonly providers: ProviderControl;
}
