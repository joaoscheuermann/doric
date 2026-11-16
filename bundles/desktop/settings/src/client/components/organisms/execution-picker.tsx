import { type ErrorInfo, errorFrom, errorInfo } from 'desktop/reads';
import { ErrorNotice } from 'desktop/ui/error-notice';
import { Input } from 'desktop/ui/input';
import { useEffect, useMemo, useState } from 'react';
import {
  resolveThreadExecution,
  restErrors,
  type Thread,
} from 'runtime/contracts';

import { api } from '../../api/settings-api.js';
import {
  type Configuration,
  effortLabel,
  isReasoningEffort,
  type ModelExecution,
  modelChoiceKey,
  modelDefaultEffort,
  modelEfforts,
  modelGroups,
  type ReasoningEffort,
  selectModelChoice,
  setExecutionEffort,
  updateModel,
  withExecution,
} from '../../domain/config.js';
import { settingsErrorCatalog } from '../../domain/error-catalog.js';
import { modelIconRequests } from '../../domain/model-icons.js';
import { useConfigSnapshot } from '../../hooks/use-config-snapshot.js';
import { useModelIcons } from '../../hooks/use-model-icons.js';
import { useSelectedThread } from '../../hooks/use-selected-thread.js';
import { EffortPicker } from '../molecules/effort-picker.js';
import { ModelPicker } from '../molecules/model-picker.js';

/** What the locked triggers tell the reader when no Thread is selected. */
const LOCKED_TITLE =
  'New threads start on the workspace default. Change it in Settings.';

/**
 * A refused write, shown only while its own Thread is selected: the Thread it
 * was for, the refusal as `ErrorInfo` (`errorFrom(code, message)` of the
 * runtime's REST error, or `errorInfo` of a rejection), and the execution the
 * write asked for, which the notice's Retry writes again (§5.2).
 */
type Alert = {
  readonly threadId: string;
  readonly error: ErrorInfo;
  readonly next: ModelExecution;
};

const sameExecution = (a: ModelExecution, b: ModelExecution): boolean =>
  a.providerId === b.providerId && a.model === b.model && a.effort === b.effort;

/** A Thread record's execution, as the picker shows it (§1 rule 1). */
const threadExecution = (
  thread: Thread,
  configuration: Configuration,
): ModelExecution => {
  const { providerId, model, effort } = resolveThreadExecution(
    thread,
    configuration,
  );
  return effort !== undefined && isReasoningEffort(effort)
    ? { providerId, model, effort }
    : { providerId, model };
};

/** Whether the record `a` is later than `b`. */
const isLater = (a: Thread, b: Thread): boolean =>
  Date.parse(a.updatedAt) > Date.parse(b.updatedAt);

const without = <Value,>(
  entries: ReadonlyMap<string, Value>,
  id: string,
): ReadonlyMap<string, Value> => {
  const next = new Map(entries);
  next.delete(id);
  return next;
};

/**
 * The selected Thread's model and reasoning effort, edited from the
 * conversation footer. A choice sets that Thread's execution through
 * `runtime.threads/v1.setThreadExecution`; the picker never writes the
 * workspace default. Without a selected Thread it shows the default, locked.
 */
export function ExecutionPicker() {
  const { configuration, error, reload, reloading } = useConfigSnapshot();
  const selected = useSelectedThread();
  /** The execution being written, per Thread id. */
  const [writes, setWrites] = useState<ReadonlyMap<string, ModelExecution>>(
    () => new Map(),
  );
  /** The record of each Thread's last `updated` answer. */
  const [answered, setAnswered] = useState<ReadonlyMap<string, Thread>>(
    () => new Map(),
  );
  const [alert, setAlert] = useState<Alert>();
  /** The typed model while the reader edits it; absent shows the model. */
  const [typed, setTyped] = useState<string>();

  const threadId = selected?.id;
  const writing = threadId === undefined ? undefined : writes.get(threadId);
  const answer = threadId === undefined ? undefined : answered.get(threadId);
  const record =
    selected !== undefined && answer !== undefined && isLater(answer, selected)
      ? answer
      : selected;

  // An answer is dropped once the layout's record is at least as late.
  const selectedUpdatedAt = selected?.updatedAt;
  useEffect(() => {
    if (threadId === undefined || selectedUpdatedAt === undefined) return;
    setAnswered((entries) => {
      const entry = entries.get(threadId);
      return entry !== undefined &&
        Date.parse(entry.updatedAt) <= Date.parse(selectedUpdatedAt)
        ? without(entries, threadId)
        : entries;
    });
  }, [threadId, selectedUpdatedAt]);

  const shown: ModelExecution | undefined =
    configuration === undefined
      ? undefined
      : (writing ??
        (record === undefined
          ? configuration.models.execution
          : threadExecution(record, configuration)));

  // The view configuration: the picker rules read the shown execution. One
  // per shown execution, so the icons' query key stays stable.
  const shownProviderId = shown?.providerId;
  const shownModel = shown?.model;
  const shownEffort = shown?.effort;
  const view = useMemo(
    () =>
      configuration === undefined ||
      shownProviderId === undefined ||
      shownModel === undefined
        ? undefined
        : withExecution(configuration, {
            providerId: shownProviderId,
            model: shownModel,
            ...(shownEffort === undefined ? {} : { effort: shownEffort }),
          }),
    [configuration, shownProviderId, shownModel, shownEffort],
  );
  const requests = useMemo(
    () => (view === undefined ? [] : modelIconRequests(view)),
    [view],
  );
  const icons = useModelIcons(requests);

  if (configuration === undefined || view === undefined || shown === undefined)
    return error === undefined ? null : (
      <div className="mr-auto flex items-center gap-1">
        <ErrorNotice
          announce
          catalog={settingsErrorCatalog}
          error={error}
          fallbackCode="config_read_failed"
          onRetry={reload}
          retrying={reloading}
          variant="inline"
        />
      </div>
    );

  const locked = selected === undefined;
  const disabled = locked || writing !== undefined;
  const title = locked ? LOCKED_TITLE : undefined;
  const { providerId, model, effort } = shown;

  const write = (next: ModelExecution): void => {
    if (selected === undefined || sameExecution(next, shown)) return;
    const id = selected.id;
    setAlert((current) => (current?.threadId === id ? undefined : current));
    setWrites((entries) => new Map(entries).set(id, next));
    Promise.resolve()
      .then(() => api().threads.setExecution({ id, ...next }))
      .then(
        (result) => {
          if (result.status === 'updated') {
            setAnswered((entries) => new Map(entries).set(id, result.thread));
            return;
          }
          const rest = restErrors.setThreadExecution(result);
          setAlert({
            threadId: id,
            error: errorFrom(
              rest?.code ?? 'invalid_execution',
              rest?.message ?? '',
            ),
            next,
          });
        },
        (reason: unknown) => {
          setAlert({ threadId: id, error: errorInfo(reason), next });
        },
      )
      .finally(() => {
        setWrites((entries) => without(entries, id));
      });
  };

  const commitTyped = (): void => {
    const value = typed?.trim();
    setTyped(undefined);
    if (value === undefined || value === '' || value === model) return;
    // On the shown provider when it is configured, else on the default's.
    const owner = configuration.providers.some(
      (provider) => provider.id === providerId,
    )
      ? providerId
      : configuration.models.execution.providerId;
    write(
      updateModel(view, { providerId: owner, model: value }).models.execution,
    );
  };

  const efforts = modelEfforts(view, providerId, model).filter(
    (value) => value !== 'none',
  );
  const groups = modelGroups(view, icons);
  // The typed field is drawn when no provider lists a model, even though the
  // list would hold the shown model alone.
  const listsModels = configuration.providers.some(
    (provider) => (provider.models?.length ?? 0) > 0,
  );
  const effortName =
    efforts.length === 0 ? 'Unavailable' : effortLabel(effort ?? 'none');
  const defaultEffort = modelDefaultEffort(view, providerId, model);
  const effortChoices = efforts.map((value) => ({
    label: effortLabel(value),
    value,
    // The level the model's own catalog names as its default is marked as such,
    // so a reader knows which one the model asks for when nothing chooses.
    ...(value === defaultEffort ? { note: '(default)' } : {}),
  }));
  const selectEffort = (value: string): void => {
    write(setExecutionEffort(view, value as ReasoningEffort).models.execution);
  };
  const shownAlert =
    alert !== undefined && alert.threadId === threadId ? alert : undefined;

  return (
    <div className="mr-auto flex items-center gap-1">
      {shownAlert !== undefined ? (
        <ErrorNotice
          announce
          catalog={settingsErrorCatalog}
          error={shownAlert.error}
          fallbackCode="invalid_execution"
          onRetry={() => write(shownAlert.next)}
          variant="inline"
        />
      ) : (
        error !== undefined && (
          <ErrorNotice
            announce
            catalog={settingsErrorCatalog}
            error={error}
            fallbackCode="config_read_failed"
            onRetry={reload}
            retrying={reloading}
            variant="inline"
          />
        )
      )}
      {listsModels ? (
        <ModelPicker
          ariaLabel="Execution model"
          disabled={disabled}
          title={title}
          groups={groups}
          label={model === '' ? 'Choose model' : model}
          icon={icons?.model(providerId, model)}
          value={modelChoiceKey(providerId, model)}
          onSelect={(key) =>
            write(selectModelChoice(view, key).models.execution)
          }
          reasoning={{
            choices: effortChoices,
            label: effortName,
            onSelect: selectEffort,
            value: effort,
          }}
        />
      ) : (
        <Input
          aria-label="Execution model"
          autoComplete="off"
          className="w-48 border-transparent bg-transparent shadow-none hover:bg-muted dark:hover:bg-muted/50 dark:bg-transparent"
          disabled={disabled}
          placeholder="Model id"
          title={title}
          value={typed ?? model}
          onBlur={commitTyped}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitTyped();
          }}
        />
      )}
      <span aria-hidden="true" className="text-muted-foreground">
        ·
      </span>
      <EffortPicker
        ariaLabel="Reasoning effort"
        choices={effortChoices}
        disabled={disabled || effortChoices.length === 0}
        label={effortName}
        title={title}
        value={effort}
        onSelect={selectEffort}
      />
    </div>
  );
}
