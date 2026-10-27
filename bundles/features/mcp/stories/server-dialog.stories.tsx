import { ServerDialog } from '../src/client/server-dialog.js';
import { fakeApi, filesServer, projectId } from './support/fixtures.js';

const close = () => console.info('closed');

export default {
  title: 'MCP/Server dialog',
  component: ServerDialog,
};

/** Adding a server: it starts as an enabled HTTP one, with no headers. */
export const AddHttp = {
  render: () => (
    <ServerDialog api={fakeApi} projectId={projectId} onClose={close} />
  ),
};

/** Editing a stdio server: its command, arguments, directory and environment. */
export const EditStdio = {
  render: () => (
    <ServerDialog
      api={fakeApi}
      projectId={projectId}
      server={filesServer}
      onClose={close}
    />
  ),
};
