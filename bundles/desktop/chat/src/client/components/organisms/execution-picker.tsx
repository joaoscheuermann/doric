import { type ErrorInfo, errorFrom, errorInfo } from 'desktop/reads';
import { ErrorNotice } from 'desktop/ui/error-notice';
import { Input } from 'desktop/ui/input';
import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  type RuntimeRecords,
  type RuntimeThreads,
  restErrors,
  type Thread,
} from 'runtime/contracts';
import type {
  ModelExecution,
  SettingsModels,
  StoredExecution,
} from 'settings/contracts';

import type { WorkspaceSelectionService } from '../../api/workspace-selection.js';
import { chatErrorCatalog } from '../../domain/error-catalog.js';
import { EffortPicker } from '../molecules/effort-picker.js';
import { ModelPicker } from '../molecules/model-picker.js';

export interface ExecutionPickerSources {
  readonly models: SettingsModels;
  /** Absent without `workspace`: the picker shows the default, locked. */
  readonly selection?: WorkspaceSelectionService;
  readonly records: Pick<RuntimeRecords, 'thread' | 'subscribe'>;
  readonly setThreadExecution: RuntimeThreads['setThreadExecution'];
}

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

/** What a Thread record stores of its execution, its absent fields left out. */
const storedOf = ({ providerId, model, effort }: Thread): StoredExecution => ({
  ...(providerId === undefined ? {} : { providerId }),
  ...(model === undefined ? {} : { model }),
  ...(effort === undefined ? {} : { effort }),
});

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

/** The id of the Thread the window selects; `undefined` without one or without `workspace`. */
const useSelectedThreadId = (
  selection: WorkspaceSelectionService | undefined,
): string | undefined => {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (selection === undefined) return () => undefined;
      const subscription = selection.subscribe(onChange);
      return () => subscription.dispose();
    },
    [selection],
  );
  return useSyncExternalStore(subscribe, () => selection?.current().threadId);
};

/** The records mirror's record of `threadId`, re-read on every records change. */
const useThreadRecord = (
  records: ExecutionPickerSources['records'],
  threadId: string | undefined,
): Thread | undefined => {
  // A record read through the service is a fresh copy on every call, so the
  // snapshot is a version counter bumped on every notification.
  const version = useRef(0);
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = records.subscribe(() => {
        version.current += 1;
        onChange();
      });
      return () => subscription.dispose();
    },
    [records],
  );
  useSyncExternalStore(subscribe, () => version.current);
  return threadId === undefined ? undefined : records.thread(threadId);
};

/**
 * The selected Thread's model and reasoning effort, edited from the
 * conversation footer. Everything it shows, and the execution each pick
 * yields, comes from `settings.models/v1`; a choice sets the Thread's
 * execution through `runtime.threads/v1.setThreadExecution`, and the picker
 * never writes the workspace default. Without a selected Thread it shows the
 * default, locked.
 */
export function ExecutionPicker({
  sources,
}: {
  readonly sources: ExecutionPickerSources;
}): ReactElement | null {
  const { models, selection, records, setThreadExecution } = sources;
  const threadId = useSelectedThreadId(selection);
  const selected = useThreadRecord(records, threadId);
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

  const selectedId = selected?.id;
  const writing = selectedId === undefined ? undefined : writes.get(selectedId);
  const answer =
    selectedId === undefined ? undefined : answered.get(selectedId);
  const record =
    selected !== undefined && answer !== undefined && isLater(answer, selected)
      ? answer
      : selected;

  // An answer is dropped once the records mirror's record is at least as late.
  const selectedUpdatedAt = selected?.updatedAt;
  useEffect(() => {
    if (selectedId === undefined || selectedUpdatedAt === undefined) return;
    setAnswered((entries) => {
      const entry = entries.get(selectedId);
      return entry !== undefined &&
        Date.parse(entry.updatedAt) <= Date.parse(selectedUpdatedAt)
        ? without(entries, selectedId)
        : entries;
    });
  }, [selectedId, selectedUpdatedAt]);

  // The write in flight, else the record's execution, else the default.
  const stored: StoredExecution | undefined =
    writing ?? (record === undefined ? undefined : storedOf(record));
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = models.subscribe(onChange);
      return () => subscription.dispose();
    },
    [models],
  );
  const view = useSyncExternalStore(subscribe, () => models.view(stored));
  const reload = (): void => models.reload();

  if (view.status === 'loading')
    return view.error === undefined ? null : (
      <div className="mr-auto flex items-center gap-1">
        <ErrorNotice
          announce
          catalog={chatErrorCatalog}
          error={view.error}
          fallbackCode="config_read_failed"
          onRetry={reload}
          retrying={view.reloading}
          variant="inline"
        />
      </div>
    );

  const shown = view.execution;
  const locked = selected === undefined;
  const disabled = locked || writing !== undefined;
  const title = locked ? LOCKED_TITLE : undefined;
  const { model, effort } = shown;

  const write = (next: ModelExecution): void => {
    if (selected === undefined || sameExecution(next, shown)) return;
    const id = selected.id;
    setAlert((current) => (current?.threadId === id ? undefined : current));
    setWrites((entries) => new Map(entries).set(id, next));
    Promise.resolve()
      .then(() => setThreadExecution({ id, ...next }))
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
    write({ providerId: view.typedProviderId, model: value });
  };

  const selectModel = (value: string): void => {
    const choice = view.groups
      .flatMap((group) => group.choices)
      .find((candidate) => candidate.value === value);
    if (choice !== undefined) write(choice.execution);
  };
  const selectEffort = (value: string): void => {
    const choice = view.efforts.find((candidate) => candidate.value === value);
    if (choice !== undefined) write(choice.execution);
  };
  const shownAlert =
    alert !== undefined && alert.threadId === selectedId ? alert : undefined;

  return (
    <div className="mr-auto flex items-center gap-1">
      {shownAlert !== undefined ? (
        <ErrorNotice
          announce
          catalog={chatErrorCatalog}
          error={shownAlert.error}
          fallbackCode="invalid_execution"
          onRetry={() => write(shownAlert.next)}
          variant="inline"
        />
      ) : (
        view.error !== undefined && (
          <ErrorNotice
            announce
            catalog={chatErrorCatalog}
            error={view.error}
            fallbackCode="config_read_failed"
            onRetry={reload}
            retrying={view.reloading}
            variant="inline"
          />
        )
      )}
      {view.listsModels ? (
        <ModelPicker
          ariaLabel="Execution model"
          disabled={disabled}
          title={title}
          groups={view.groups}
          label={model === '' ? 'Choose model' : model}
          icon={view.icon}
          value={view.value}
          onSelect={selectModel}
          reasoning={{
            choices: view.efforts,
            label: view.effortLabel,
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
        choices={view.efforts}
        disabled={disabled || view.efforts.length === 0}
        label={view.effortLabel}
        title={title}
        value={effort}
        onSelect={selectEffort}
      />
    </div>
  );
}
