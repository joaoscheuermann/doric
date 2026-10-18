import { promptIdOf, turnsOfType } from '../../../../support/conversation.js';
import { TurnsEditor } from '../../../../support/editor.js';

const prompt = promptIdOf(2701);

const failure = (error: unknown) =>
  turnsOfType('failure', (log) => {
    log.prompt(prompt, 'Deploy the preview to staging.');
    log.push(prompt, { type: 'agent.started' });
    log.push(prompt, { type: 'agent.failed', error });
    log.push(prompt, {
      type: 'prompt.finished',
      status: 'failed',
      text: '',
      source: { kind: 'user' },
    });
  });

export default {
  title: 'Chat/Nodes/Failure turn',
};

/** A run the provider failed, with the provider's message. */
export const ProviderError = {
  render: () => (
    <TurnsEditor
      turns={failure({
        name: 'ProviderError',
        code: 'rate_limited',
        message:
          'The model provider is rate limiting requests. Try again in a minute.',
      })}
    />
  ),
};

/** The host gave up taking the prompt up again: a warning, not an error. */
export const ResumeExhausted = {
  render: () => (
    <TurnsEditor
      turns={failure({
        name: 'ResumeError',
        code: 'resume_exhausted',
        message:
          'The prompt was interrupted three times and will not be resumed automatically.',
      })}
    />
  ),
};

/** A failure that names only its code. */
export const CodeOnly = {
  render: () => (
    <TurnsEditor turns={failure({ name: '', code: 'context_overflow' })} />
  ),
};

/** A long message, to see how the notice wraps. */
export const LongMessage = {
  render: () => (
    <TurnsEditor
      turns={failure(
        'The sandbox ran out of disk space while installing dependencies for the storefront package: npm could not write node_modules/.cache/esbuild (ENOSPC). Free some space in the Project volume and send the prompt again.',
      )}
    />
  ),
};
