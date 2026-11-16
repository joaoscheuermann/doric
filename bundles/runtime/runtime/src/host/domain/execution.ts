import {
  checkThreadExecution,
  type ExecutionConfiguration,
  type ThreadExecution,
  type ThreadExecutionIssue,
} from '../../contracts/execution.js';

/** Why the validator refuses an execution. */
export type ExecutionRefusal =
  /** `checkThreadExecution`'s issue. */
  | { readonly kind: 'invalid'; readonly issue: ThreadExecutionIssue }
  /**
   * `models/v1.resolve` rejected; `error` is its rejection, unchanged;
   * `message` is `error.message` for an `Error`, else `String(error)`.
   */
  | {
      readonly kind: 'unresolvable';
      readonly error: unknown;
      readonly message: string;
    };

/** Which keys of the execution the caller chose, so only those can be refused. */
export interface ExecutionChoice {
  readonly model: boolean;
  readonly effort: boolean;
}

/**
 * Builds the validator over `resolve` (`RuntimePorts.catalogSource`; its value
 * is ignored, and no effort is passed). The validator runs
 * `checkThreadExecution` — `provider` always counts, `model` and `effort`
 * only when `choice` says the caller chose that key — then
 * `resolve(providerId, model)`. It answers the first refusal, or `undefined`
 * when the execution is usable. It never rejects: a `resolve` rejection
 * becomes `unresolvable`.
 */
export const createExecutionValidator =
  (resolve: (providerId: string, model: string) => Promise<unknown>) =>
  async (
    configuration: ExecutionConfiguration,
    execution: ThreadExecution,
    choice: ExecutionChoice,
  ): Promise<ExecutionRefusal | undefined> => {
    const issue = checkThreadExecution(configuration, execution);
    if (issue !== undefined && (issue === 'provider' || choice[issue]))
      return { kind: 'invalid', issue };
    try {
      await resolve(execution.providerId, execution.model);
      return undefined;
    } catch (error) {
      return {
        kind: 'unresolvable',
        error,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };
