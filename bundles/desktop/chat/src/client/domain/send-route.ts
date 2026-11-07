// The composer's route for one message (conversation-openui.md D20): a steer of
// the Thread's running prompt, else a new prompt, resuming a paused, empty
// queue first. The composer's hook and `chat.send/v1.sendAction` both take it,
// each with its own ports.

/** What the route asks of the Thread, for one message. */
export interface SendRoutePorts {
  /** Steers the running prompt `promptId` with the message; true when it was taken (`steered` or `queued`). */
  steer(promptId: string): Promise<boolean>;
  /** The Thread's queue: whether it is paused, and whether it holds no prompt. */
  queue(): Promise<{ readonly paused: boolean; readonly empty: boolean }>;
  /** True when the queue was resumed. */
  resumeQueue(): Promise<boolean>;
  /** Starts a prompt with the message; true when it was taken. */
  prompt(): Promise<boolean>;
}

/** The composer's route for one message; false when the message was not taken. Never rejects. */
export const routeSend = async (
  activePromptId: string | undefined,
  ports: SendRoutePorts,
): Promise<boolean> => {
  try {
    if (activePromptId !== undefined) return await ports.steer(activePromptId);
    const queue = await ports.queue();
    if (queue.paused && queue.empty && !(await ports.resumeQueue()))
      return false;
    return await ports.prompt();
  } catch {
    return false;
  }
};
