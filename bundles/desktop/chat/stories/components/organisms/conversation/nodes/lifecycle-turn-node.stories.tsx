import {
  promptIdOf,
  type StoryLog,
  turnsOfType,
} from '../../../../support/conversation.js';
import { TurnsEditor } from '../../../../support/editor.js';

const prompt = promptIdOf(2601);

const lifecycle = (build: (log: StoryLog) => void) =>
  turnsOfType('lifecycle', (log) => {
    log.prompt(prompt, 'Upgrade the app to React 19 and fix the type errors.');
    log.push(prompt, { type: 'agent.started' });
    log.text(prompt, 'I bumped the versions; now running tsc.');
    build(log);
  });

export default {
  title: 'Chat/Nodes/Lifecycle turn',
};

/** The host stopped mid-run and the pause still stands: Resume is offered. */
export const PausedByHost = {
  render: () => (
    <TurnsEditor
      turns={lifecycle((log) =>
        log.push(prompt, { type: 'prompt.paused', reason: 'host_stopped' }),
      )}
    />
  ),
};

/** The reader stopped the run. */
export const StoppedByReader = {
  render: () => (
    <TurnsEditor
      turns={lifecycle((log) =>
        log.push(prompt, { type: 'prompt.paused', reason: 'reader_stopped' }),
      )}
    />
  ),
};

/** The host ran low on storage. */
export const StorageLow = {
  render: () => (
    <TurnsEditor
      turns={lifecycle((log) =>
        log.push(prompt, { type: 'prompt.paused', reason: 'storage_low' }),
      )}
    />
  ),
};

/** The host restarted; the prompt was taken up again (the pause and the resume). */
export const Resumed = {
  render: () => (
    <TurnsEditor
      turns={lifecycle((log) => {
        log.push(prompt, { type: 'prompt.paused', reason: 'host_restarted' });
        log.push(prompt, { type: 'prompt.resumed', attempt: 1 });
        log.push(prompt, { type: 'agent.started' });
      })}
    />
  ),
};

/** A later attempt, after a second stop. */
export const SecondAttempt = {
  render: () => (
    <TurnsEditor
      turns={lifecycle((log) => {
        log.push(prompt, { type: 'prompt.paused', reason: 'host_stopped' });
        log.push(prompt, { type: 'prompt.resumed', attempt: 1 });
        log.push(prompt, { type: 'agent.started' });
        log.push(prompt, { type: 'prompt.paused', reason: 'host_stopped' });
        log.push(prompt, { type: 'prompt.resumed', attempt: 2 });
        log.push(prompt, { type: 'agent.started' });
      })}
    />
  ),
};
