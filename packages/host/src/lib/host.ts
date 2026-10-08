import type { TerminalControl } from './terminals.js';
import type { ThreadControl } from './threads.js';
import type { WorkspaceControl } from './workspace.js';

/** The per-prompt capability facade every tool handler receives. */
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
