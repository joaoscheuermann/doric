import { ServerDialog } from '../src/client/server-dialog.js';
import {
  fakeApi,
  filesServer,
  linearServer,
  projectId,
} from './support/fixtures.js';

const close = () => console.info('closed');

export default {
  title: 'MCP/Server dialog',
  component: ServerDialog,
  // A modal dialog: laid out at the window's width, not the pane's.
  parameters: { layout: 'fullscreen' },
};

/** Adding a server: it starts as an enabled HTTP one, with no headers. */
export const AddHttp = {
  render: () => (
    <ServerDialog api={fakeApi} projectId={projectId} onClose={close} />
  ),
};

/** Editing an http server: its URL, and a header that holds a credential. */
export const EditHttp = {
  render: () => (
    <ServerDialog
      api={fakeApi}
      projectId={projectId}
      server={linearServer}
      onClose={close}
    />
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
