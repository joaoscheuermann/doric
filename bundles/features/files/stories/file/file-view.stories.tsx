import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'desktop/ui/sonner';
import { type ReactNode, useState } from 'react';

import {
  FileBody,
  FileContent,
  FileView,
} from '../../src/client/file/file-view.js';
import type { ProjectFileContent } from '../../src/client/reads/project-files.js';
import {
  createQueryClient,
  filesKeys,
} from '../../src/client/sandbox-store.js';
import type { ContentRead, LeaseOutcome } from '../../src/contracts/index.js';
import {
  lockfile,
  logo,
  paymentForm,
  project,
  readme,
} from '../support/fixtures.js';
import { storyServices } from '../support/services.js';

/** A file tab's frame: the workspace's tab area beside the conversation. */
function TabFrame({ children }: { readonly children: ReactNode }) {
  return (
    <div
      className="flex flex-col overflow-hidden rounded-md border bg-background"
      style={{ height: 520 }}
    >
      {children}
    </div>
  );
}

const read = (file: ProjectFileContent): LeaseOutcome<ContentRead> => ({
  status: 'ready',
  value: { status: 'read', ...file },
});

/**
 * One file tab over a seeded `files/v1`: `content` answers `outcome` for the
 * tab's path, and the query cache already holds the ready read when there is
 * one, so the text is on screen at once.
 */
function FileStory({
  path,
  outcome,
}: {
  readonly path: string;
  readonly outcome: () => Promise<LeaseOutcome<ContentRead>>;
}) {
  const [{ client, services }] = useState(() => {
    const client = createQueryClient();
    const services = storyServices({
      scoped: { 'files/v1': () => ({ content: outcome }) },
    });
    return { client, services };
  });
  return (
    <QueryClientProvider client={client}>
      <TabFrame>
        <FileView services={services} projectId={project.id} path={path} />
      </TabFrame>
      <Toaster />
    </QueryClientProvider>
  );
}

function SeededFileStory({ file }: { readonly file: ProjectFileContent }) {
  const [{ client, services }] = useState(() => {
    const client = createQueryClient();
    client.setQueryData(filesKeys.file(project.id, file.path), {
      status: 'ready',
      file,
    });
    const services = storyServices({
      scoped: { 'files/v1': () => ({ content: async () => read(file) }) },
    });
    return { client, services };
  });
  return (
    <QueryClientProvider client={client}>
      <TabFrame>
        <FileView services={services} projectId={project.id} path={file.path} />
      </TabFrame>
    </QueryClientProvider>
  );
}

export default {
  title: 'Files/File/File view',
  component: FileView,
};

export const TypeScriptFile = {
  render: () => <SeededFileStory file={paymentForm} />,
};

export const MarkdownFile = {
  render: () => <SeededFileStory file={readme} />,
};

export const TruncatedFile = {
  render: () => <SeededFileStory file={lockfile} />,
};

export const BinaryFile = {
  render: () => <SeededFileStory file={logo} />,
};

/** The first read on its way: the skeleton rows and `Updating…`. */
export const FirstRead = {
  render: () => (
    <FileStory
      path={paymentForm.path}
      outcome={() => new Promise<never>(() => undefined)}
    />
  ),
};

export const FileNoLongerInWorkspace = {
  render: () => (
    <FileStory
      path="apps/web/src/checkout/use-cart.ts"
      outcome={async () => ({
        status: 'ready',
        value: { status: 'not_found' },
      })}
    />
  ),
};

export const SandboxExpired = {
  render: () => (
    <FileStory
      path={paymentForm.path}
      outcome={async () => ({ status: 'expired' })}
    />
  ),
};

/** The host fails every read; after its retries the toast reports it. */
export const ReadFailed = {
  render: () => (
    <FileStory
      path={paymentForm.path}
      outcome={() => Promise.reject(new Error('unreachable'))}
    />
  ),
};

/** The file's text or why it is not shown, without the tab around it. */
export const BodyStates = {
  render: () => (
    <div className="grid grid-cols-2 gap-4">
      <TabFrame>
        <FileBody file={{ status: 'loading' }} />
      </TabFrame>
      <TabFrame>
        <FileBody file={{ status: 'pending', retryAfterSeconds: 2 }} />
      </TabFrame>
      <TabFrame>
        <FileBody file={{ status: 'invalid_path' }} />
      </TabFrame>
      <TabFrame>
        <FileBody file={{ status: 'missing' }} />
      </TabFrame>
    </div>
  ),
};

export const BodyAfterFailedRead = {
  render: () => (
    <TabFrame>
      <FileBody file={{ status: 'idle' }} failed />
    </TabFrame>
  ),
};

export const ContentOnly = {
  render: () => (
    <TabFrame>
      <FileContent file={paymentForm} />
    </TabFrame>
  ),
};

export const ContentTruncated = {
  render: () => (
    <TabFrame>
      <FileContent file={lockfile} />
    </TabFrame>
  ),
};
