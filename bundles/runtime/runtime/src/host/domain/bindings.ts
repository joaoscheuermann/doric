import type { Call, CallScope } from 'bundle/contracts';
import type { Sandbox } from 'sandbox';

import { readRuntimeScope } from '../../contracts/scope.js';
import type { Host } from '../../contracts/tool-host/index.js';

/*
 * The prompt bindings (design 57 §4.4): what the stage-1 host-adapter's
 * `attach` kept, now kept by the runtime itself. The runner binds a prompt's
 * Host facade and sandbox before its executor runs and releases them once the
 * run settled; every prompt-scoped method resolves its call through `bound`.
 */

/** The prompt a binding serves: what every bound call's scope must name. */
export interface PromptScope {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
}

/** The per-prompt capabilities the runner built for one execution. */
export interface PromptBinding {
  readonly host: Host;
  readonly sandbox: Sandbox;
}

export interface Bindings {
  /** Binds the prompt's Host and sandbox to its scope until `release` runs. */
  attach(scope: PromptScope, binding: PromptBinding): () => void;
  /** The binding of the prompt `call` belongs to; an ended prompt has none. */
  bound(
    call: Call | { readonly scope?: CallScope },
  ): PromptScope & PromptBinding;
}

export const inactiveControl = (): Error =>
  new Error('Thread control is no longer active.');

export const createBindings = (): Bindings => {
  const bindings = new Map<string, PromptScope & PromptBinding>();

  return {
    attach: (scope, binding) => {
      const entry = { ...scope, ...binding };

      bindings.set(scope.promptId, entry);

      return () => {
        // A late release of a paused run never drops the binding of the run
        // that resumed the same prompt.
        if (bindings.get(scope.promptId) === entry)
          bindings.delete(scope.promptId);
      };
    },
    bound: (call) => {
      const scope = readRuntimeScope(call);
      const binding =
        scope.promptId === undefined ? undefined : bindings.get(scope.promptId);

      if (
        binding === undefined ||
        binding.threadId !== scope.threadId ||
        binding.projectId !== scope.projectId
      )
        throw inactiveControl();

      return binding;
    },
  };
};
