// Registers the `doric` scheme before the app is ready (decision 74). It is
// imported for its side effect at the top of `main.ts`.

import { protocol } from 'electron';

import { DORIC_SCHEME } from './scheme';

protocol.registerSchemesAsPrivileged([
  {
    scheme: DORIC_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      codeCache: true,
    },
  },
]);
