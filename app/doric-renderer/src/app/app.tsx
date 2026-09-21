import { DeleteDialog } from '@/components/delete-dialog';
import {
  ProjectSidebar,
  type SidebarActions,
  type SidebarModel,
} from '@/components/project-sidebar';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import {
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from '@/components/ui/sidebar';
import { Textarea } from '@/components/ui/textarea';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  FileTextIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
} from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { usePanelRef } from 'react-resizable-panels';

import type { Draft, Entity, Project, Thread } from './workspace';
import {
  messageFrom,
  threadsForProject,
  threadSubtreeIds,
  upsert,
  withoutThreadSubtree,
} from './workspace';

/** The panel owns the sidebar width, so the sidebar fills whatever it drags to. */
const panelWidth = {
  '--sidebar-width': '100%',
} as CSSProperties;

/** Clears the native macOS traffic lights while preserving left alignment. */
const titleBarInset = 'pl-20';

function SidebarToggle() {
  const { open, toggleSidebar } = useSidebar();

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={open ? 'Hide sidebar' : 'Show sidebar'}
      className="self-center [app-region:no-drag]"
      onClick={toggleSidebar}
    >
      {open ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
    </Button>
  );
}

function WorkspaceLayout({
  children,
  sidebar,
}: {
  readonly children: ReactNode;
  readonly sidebar: ReactNode;
}) {
  const { open, setOpen } = useSidebar();
  const panel = usePanelRef();

  useEffect(() => {
    if (open) panel.current?.expand();
    else panel.current?.collapse();
  }, [open, panel]);

  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel
        panelRef={panel}
        collapsible
        collapsedSize={0}
        defaultSize="15rem"
        minSize="11rem"
        maxSize="24rem"
        onResize={(size) => setOpen(size.asPercentage > 0)}
      >
        {sidebar}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel className="min-w-0">{children}</ResizablePanel>
    </ResizablePanelGroup>
  );
}

export function App() {
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [threadsByProject, setThreadsByProject] = useState<
    Readonly<Record<string, readonly Thread[]>>
  >({});
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [draft, setDraft] = useState<Draft>();
  const [editing, setEditing] = useState<Entity>();
  const [deleting, setDeleting] = useState<Entity>();
  const [deletingPending, setDeletingPending] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingThreadProjects, setLoadingThreadProjects] = useState<
    ReadonlySet<string>
  >(new Set());
  const [error, setError] = useState<string>();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const intent = useRef(0);
  const loadSequences = useRef(new Map<string, number>());
  const mutationSequences = useRef(new Map<string, number>());

  const nextMutation = (key: string): number => {
    const sequence = (mutationSequences.current.get(key) ?? 0) + 1;
    mutationSequences.current.set(key, sequence);
    return sequence;
  };

  const mutationIsCurrent = (key: string, sequence: number): boolean =>
    mutationSequences.current.get(key) === sequence;

  const invalidateThreadLoads = (projectId: string): void => {
    loadSequences.current.set(
      projectId,
      (loadSequences.current.get(projectId) ?? 0) + 1,
    );
    setLoadingThreadProjects((current) => {
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  };

  const loadThreads = async (projectId: string) => {
    const requestIntent = intent.current;
    const sequence = (loadSequences.current.get(projectId) ?? 0) + 1;
    loadSequences.current.set(projectId, sequence);
    setLoadingThreadProjects((current) => new Set([...current, projectId]));
    try {
      const nextThreads = await window.doric.threads.list(projectId);
      if (loadSequences.current.get(projectId) === sequence) {
        setThreadsByProject((current) => ({
          ...current,
          [projectId]: threadsForProject(nextThreads, projectId),
        }));
      }
    } catch (reason) {
      if (loadSequences.current.get(projectId) === sequence) {
        if (intent.current === requestIntent) setError(messageFrom(reason));
      }
    } finally {
      if (loadSequences.current.get(projectId) === sequence) {
        setLoadingThreadProjects((current) => {
          const next = new Set(current);
          next.delete(projectId);
          return next;
        });
      }
    }
  };

  useEffect(() => {
    let active = true;
    const initialIntent = intent.current;
    void window.doric.projects
      .list()
      .then((nextProjects) => {
        if (!active) return;
        setProjects((current) => {
          const known = new Set(current.map((project) => project.id));
          return [
            ...current,
            ...nextProjects.filter((project) => !known.has(project.id)),
          ];
        });
        const first = nextProjects[0];
        if (first && intent.current === initialIntent) {
          setSelectedProjectId(first.id);
          void loadThreads(first.id);
        }
      })
      .catch((reason: unknown) => {
        if (active && intent.current === initialIntent) {
          setError(messageFrom(reason));
        }
      })
      .finally(() => {
        if (active) setLoadingProjects(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const selectProject = (project: Project) => {
    intent.current += 1;
    setError(undefined);
    setDraft(undefined);
    setEditing(undefined);
    setSelectedProjectId(project.id);
    setSelectedThreadId(undefined);
    void loadThreads(project.id);
  };

  const beginProject = () => {
    intent.current += 1;
    setError(undefined);
    setEditing(undefined);
    setSelectedProjectId(undefined);
    setSelectedThreadId(undefined);
    setDraft({ kind: 'project' });
  };

  const beginThread = (projectId: string, parentThreadId?: string) => {
    intent.current += 1;
    setError(undefined);
    setEditing(undefined);
    setSelectedThreadId(undefined);
    setDraft({ kind: 'thread', projectId, parentThreadId });
    if (selectedProjectId !== projectId) {
      setSelectedProjectId(projectId);
    }
    if (threadsByProject[projectId] === undefined) {
      void loadThreads(projectId);
    }
  };

  const createProject = async (name: string) => {
    const operationIntent = intent.current;
    const sequence = nextMutation('projects:create');
    const project = await window.doric.projects.create(name);
    setProjects((current) => upsert(current, project));
    if (
      mutationIsCurrent('projects:create', sequence) &&
      intent.current === operationIntent
    ) {
      setSelectedProjectId(project.id);
      setSelectedThreadId(undefined);
      setThreadsByProject((current) => ({ ...current, [project.id]: [] }));
      setDraft((current) =>
        current?.kind === 'project' ? undefined : current,
      );
    }
  };

  const createThread = async (name: string) => {
    if (draft?.kind !== 'thread') return;
    const operationDraft = draft;
    const operationIntent = intent.current;
    const key = `threads:create:${operationDraft.projectId}`;
    const sequence = nextMutation(key);
    invalidateThreadLoads(operationDraft.projectId);
    const thread = await window.doric.threads.create(
      operationDraft.projectId,
      name,
      operationDraft.parentThreadId,
    );
    invalidateThreadLoads(thread.projectId);
    setThreadsByProject((current) => ({
      ...current,
      [thread.projectId]: upsert(
        threadsForProject(current[thread.projectId] ?? [], thread.projectId),
        thread,
      ),
    }));
    if (
      mutationIsCurrent(key, sequence) &&
      intent.current === operationIntent
    ) {
      setSelectedProjectId(thread.projectId);
      setSelectedThreadId(thread.id);
      setDraft((current) => (current === operationDraft ? undefined : current));
    }
  };

  const rename = async (entity: Entity, name: string) => {
    const key = `${entity.kind}:rename:${entity.value.id}`;
    const sequence = nextMutation(key);
    const operationIntent = intent.current;

    if (entity.kind === 'project') {
      const project = await window.doric.projects.rename(entity.value.id, name);
      if (!mutationIsCurrent(key, sequence)) return;
      setProjects((current) => upsert(current, project));
    } else {
      invalidateThreadLoads(entity.value.projectId);
      const thread = await window.doric.threads.rename(entity.value.id, name);
      if (!mutationIsCurrent(key, sequence)) return;
      invalidateThreadLoads(thread.projectId);
      setThreadsByProject((current) => ({
        ...current,
        [thread.projectId]: upsert(
          threadsForProject(current[thread.projectId] ?? [], thread.projectId),
          thread,
        ),
      }));
    }

    if (intent.current === operationIntent) {
      setEditing((current) =>
        current?.kind === entity.kind && current.value.id === entity.value.id
          ? undefined
          : current,
      );
    }
  };

  const deleteEntity = async () => {
    if (!deleting) return;
    setDeletingPending(true);
    setError(undefined);
    const entity = deleting;
    const operationIntent = intent.current;
    const key = `${entity.kind}:delete:${entity.value.id}`;
    const sequence = nextMutation(key);
    try {
      if (entity.kind === 'project') {
        invalidateThreadLoads(entity.value.id);
        await window.doric.projects.terminate(entity.value.id);
        await window.doric.projects.delete(entity.value.id);
        if (!mutationIsCurrent(key, sequence)) return;
        setProjects((current) =>
          current.filter((project) => project.id !== entity.value.id),
        );
        setThreadsByProject((current) =>
          Object.fromEntries(
            Object.entries(current).filter(
              ([projectId]) => projectId !== entity.value.id,
            ),
          ),
        );
        if (
          intent.current === operationIntent &&
          selectedProjectId === entity.value.id
        ) {
          setSelectedProjectId(undefined);
          setSelectedThreadId(undefined);
        }
      } else {
        invalidateThreadLoads(entity.value.projectId);
        const removedIds = threadSubtreeIds(
          threadsByProject[entity.value.projectId] ?? [],
          entity.value.id,
        );
        await window.doric.threads.terminate(entity.value.id);
        await window.doric.threads.delete(entity.value.id);
        if (!mutationIsCurrent(key, sequence)) return;
        setThreadsByProject((current) => ({
          ...current,
          [entity.value.projectId]: withoutThreadSubtree(
            current[entity.value.projectId] ?? [],
            entity.value.id,
          ),
        }));
        setSelectedThreadId((current) =>
          current !== undefined && removedIds.has(current)
            ? undefined
            : current,
        );
        void loadThreads(entity.value.projectId);
      }
      setDeleting(undefined);
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setDeletingPending(false);
    }
  };

  const threads =
    selectedProjectId === undefined
      ? []
      : threadsForProject(
          threadsByProject[selectedProjectId] ?? [],
          selectedProjectId,
        );
  const selectedThread = threads.find(
    (thread) =>
      thread.id === selectedThreadId && thread.projectId === selectedProjectId,
  );
  const model: SidebarModel = {
    draft,
    editing,
    error,
    loadingProjects,
    loadingThreads:
      selectedProjectId !== undefined &&
      loadingThreadProjects.has(selectedProjectId),
    projects,
    selectedProjectId,
    selectedThreadId,
    threads,
  };
  const actions: SidebarActions = {
    beginProject,
    beginThread,
    cancelDraft: () => {
      intent.current += 1;
      setDraft(undefined);
    },
    cancelRename: () => {
      intent.current += 1;
      setEditing(undefined);
    },
    createProject,
    createThread,
    copyThreadId: (id) => {
      setError(undefined);
      void navigator.clipboard
        .writeText(id)
        .catch(() => setError('Unable to copy the thread ID.'));
    },
    deleteEntity: setDeleting,
    rename,
    selectProject,
    selectThread: (thread) => {
      intent.current += 1;
      setDraft(undefined);
      setEditing(undefined);
      setSelectedProjectId(thread.projectId);
      setSelectedThreadId(thread.id);
    },
    startRename: (entity) => {
      intent.current += 1;
      setDraft(undefined);
      setEditing(entity);
    },
  };

  return (
    <TooltipProvider>
      <SidebarProvider
        style={panelWidth}
        className="h-svh min-h-0 flex-col overflow-hidden"
      >
        <header
          className={`flex h-8 shrink-0 items-center border-b pr-2 [app-region:drag] ${titleBarInset}`}
        >
          <div className="flex h-full items-center [app-region:no-drag]">
            <SidebarToggle />
          </div>
        </header>
        <WorkspaceLayout
          sidebar={<ProjectSidebar actions={actions} model={model} />}
        >
          <SidebarInset className="min-h-0">
            <section
              aria-label="Thread editor"
              className="flex min-h-0 flex-1 p-4"
            >
              {selectedThread ? (
                <Field className="min-h-0 flex-1">
                  <FieldLabel htmlFor={`editor-${selectedThread.id}`}>
                    {selectedThread.name}
                  </FieldLabel>
                  <Textarea
                    id={`editor-${selectedThread.id}`}
                    className="min-h-0 flex-1 resize-none"
                    placeholder="Write a note…"
                    value={notes[selectedThread.id] ?? ''}
                    onChange={(event) =>
                      setNotes((current) => ({
                        ...current,
                        [selectedThread.id]: event.target.value,
                      }))
                    }
                  />
                </Field>
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FileTextIcon />
                    </EmptyMedia>
                    <EmptyTitle>No thread selected</EmptyTitle>
                    <EmptyDescription>
                      Select a thread to open its text editor.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </section>
          </SidebarInset>
        </WorkspaceLayout>
        <DeleteDialog
          entity={deleting}
          pending={deletingPending}
          onDelete={deleteEntity}
          onOpenChange={(open) => {
            if (!open && !deletingPending) setDeleting(undefined);
          }}
        />
      </SidebarProvider>
    </TooltipProvider>
  );
}

export default App;
