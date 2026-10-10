import { bootstrapWindow } from 'desktop-client';

// Stage 9: every window shows the core outlet (D9-1); the legacy React tree
// under `legacy/` is no longer mounted and is removed by the cut-over (WP6).
void bootstrapWindow({});
