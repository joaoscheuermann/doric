/**
 * Prompt acceptance mirrors the durable lifecycle. A Project keeps a sandbox for
 * its whole life, so a stopped Project stops every Thread under it; only queued,
 * ready, and running Threads still accept prompts.
 */
export const promptNotice = (
  threadState: string,
  projectState?: string,
): string | undefined => {
  if (projectState === 'failed' || projectState === 'cancelled') {
    return 'This project is no longer running, so its threads cannot accept prompts. Create a new project to continue.';
  }
  if (threadState === 'cancelling') return 'This thread is stopping.';
  if (threadState === 'failed') {
    return 'This thread failed and cannot accept prompts. Create a new thread to continue.';
  }
  if (threadState === 'cancelled') {
    return 'This thread was cancelled and cannot accept prompts. Create a new thread to continue.';
  }
  return undefined;
};
