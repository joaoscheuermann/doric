import {
  promptIdOf,
  type StoryLog,
  turnsOfType,
} from '../../../../support/conversation.js';
import { TurnsEditor } from '../../../../support/editor.js';

const prompt = promptIdOf(2501);

const compaction = (build: (log: StoryLog) => void) =>
  turnsOfType('compaction', (log) => {
    log.prompt(prompt, 'Run the whole test suite and fix what fails.');
    log.push(prompt, { type: 'agent.started' });
    build(log);
  });

const summary = [
  '## Summary',
  '',
  '- The checkout card was redesigned: the summary sits above the form.',
  '- The Pay button uses `bg-primary`; `CartSummary` uses `bg-card`.',
  '- Open question: the heading size on mobile.',
].join('\n');

export default {
  title: 'Chat/Nodes/Compaction turn',
};

/** A compaction that closed: the row the reader opens to read the summary. */
export const Completed = {
  render: () => (
    <TurnsEditor
      turns={compaction((log) => {
        log.push(prompt, { type: 'compaction.started', trigger: 'automatic' });
        log.push(prompt, {
          type: 'compaction.finished',
          summaryId: 'summary-1',
          summary,
          condensedMessages: 18,
          tokensFreed: 42_150,
        });
      })}
    />
  ),
};

/** A compaction still running. */
export const Compacting = {
  render: () => (
    <TurnsEditor
      turns={compaction((log) =>
        log.push(prompt, { type: 'compaction.started', trigger: 'manual' }),
      )}
    />
  ),
};

/** One message condensed. */
export const OneMessage = {
  render: () => (
    <TurnsEditor
      turns={compaction((log) => {
        log.push(prompt, { type: 'compaction.started', trigger: 'manual' });
        log.push(prompt, {
          type: 'compaction.finished',
          summaryId: 'summary-2',
          summary,
          condensedMessages: 1,
          tokensFreed: 980,
        });
      })}
    />
  ),
};

/** An older compaction whose log kept no counts and no summary. */
export const WithoutSummary = {
  render: () => (
    <TurnsEditor
      turns={compaction((log) => {
        log.push(prompt, { type: 'compaction.started', trigger: 'automatic' });
        log.push(prompt, { type: 'compaction.finished' });
      })}
    />
  ),
};

/** A compaction that failed, named by its code. */
export const Failed = {
  render: () => (
    <TurnsEditor
      turns={compaction((log) => {
        log.push(prompt, { type: 'compaction.started', trigger: 'automatic' });
        log.push(prompt, {
          type: 'compaction.failed',
          code: 'summarizer_failed',
        });
      })}
    />
  ),
};
