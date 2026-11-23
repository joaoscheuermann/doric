// `claude-login`'s host part as a process (phase 3, slice S50b):
// `claude.login/v1` served through the router, storing the authorization
// through `secrets/v1`. The running host keeps the kernel entry
// (`./index.ts`) until S62.
import { runBundle } from 'bundle/host';

import { LoginService } from '../contracts/gen/doric/claude/login/v1/login_pb.js';
import { createClaudeLoginService } from './rpc/login.js';

const login = createClaudeLoginService();

runBundle({
  services: [[LoginService, login.implementation]],
  activate: (context) => login.activate(context),
  deactivate: () => login.deactivate(),
});
