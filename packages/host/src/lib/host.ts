import type { ThreadControl } from './threads.js';

/** The per-prompt capability facade every tool handler receives. */
export interface Host {
  /** Control over the direct child threads of one active parent prompt. */
  readonly threads: ThreadControl;
  // Future namespaces are added per concrete need, never as a dumping ground:
  // readonly config: ConfigControl;
  // readonly vms: VmControl;
  // readonly providers: ProviderControl;
}
