// The stage-7 oracle: the Prisma stores that wrote and read the legacy
// `project`, `thread` and `thread_event` tables, frozen here when the kernel
// stopped serving them (57-WP-K). The migration test seeds the legacy rows
// through them and records what they read back before the move. They are
// test-only and leave with the legacy tables (`postgres` 2.0.0).
export { createProjectStore } from './projects.js';
export { json } from './storage.js';
export { createThreadStore } from './threads.js';
export type * from './types.js';
