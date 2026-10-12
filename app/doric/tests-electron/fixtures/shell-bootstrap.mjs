// The fixture shell's bootstrap: desktop-client's real bootstrap with a
// mount that only records the path it mounted, and a `ready()` that marks
// the page so tests can wait for it.

import { bootstrapWindow } from 'desktop-client';

const exposed = window.doric.desktop;
const desktop = {
  ...exposed,
  ready: async () => {
    await exposed.ready();
    document.body.dataset.ready = 'yes';
  },
  reportFailure: async (info) => {
    document.body.dataset.failure = info.message;
    await exposed.reportFailure(info);
  },
};

void bootstrapWindow({
  desktop,
  mount: ({ description }) => {
    document.body.dataset.mounted = description.path;
    if (description.path === '/settings' || description.path.startsWith('/settings/')) {
      document.title = 'Doric Settings';
    }
  },
});
