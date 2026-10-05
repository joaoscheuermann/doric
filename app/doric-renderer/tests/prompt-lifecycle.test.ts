import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  lifecycleMarker,
  pauseReason,
  promptFailure,
  resumeAttempt,
  resumeExhausted,
  statesFailure,
} from '../src/domain/prompt-lifecycle';

/** A pause's own time, whose hour the row states in the reader's zone. */
const at = '2026-03-12T14:31:00.000Z';

describe('how a prompt lifecycle event reads', () => {
  test('names what each pause reason left the prompt unfinished for', () => {
    const stopped = lifecycleMarker({
      at,
      kind: 'pause',
      reason: 'host_stopped',
      standing: true,
    });
    assert.equal(stopped.icon, 'pause');
    assert.match(
      stopped.label,
      /^Execução pausada · o host parou às \d{2}:\d{2}$/,
    );

    assert.equal(
      lifecycleMarker({
        at,
        kind: 'pause',
        reason: 'host_restarted',
        standing: true,
      }).label,
      'Execução pausada · o host foi reiniciado inesperadamente',
    );
    assert.equal(
      lifecycleMarker({
        at,
        kind: 'pause',
        reason: 'reader_stopped',
        standing: true,
      }).label,
      'Execução pausada · você parou a execução',
    );
  });

  test('names the attempt a resume opened', () => {
    const marker = lifecycleMarker({ attempt: 2, kind: 'resume' });

    assert.equal(marker.label, 'Execução retomada · tentativa 2');
    assert.equal(marker.icon, 'play');
    assert.equal(marker.action, false);
  });

  test('offers the action on a pause that still stands, and none once it does not', () => {
    assert.equal(
      lifecycleMarker({
        at,
        kind: 'pause',
        reason: 'reader_stopped',
        standing: true,
      }).action,
      true,
    );
    assert.equal(
      lifecycleMarker({
        at,
        kind: 'pause',
        reason: 'reader_stopped',
        standing: false,
      }).action,
      false,
    );
  });

  test('names a host stop without an hour when its time cannot be read', () => {
    const marker = lifecycleMarker({
      at: 'not a date',
      kind: 'pause',
      reason: 'host_stopped',
      standing: true,
    });

    assert.equal(marker.label, 'Execução pausada · o host parou');
  });
});

describe('reading a prompt lifecycle event off the log', () => {
  test('keeps the pause reason in the combined resume marker tooltip', () => {
    const marker = lifecycleMarker({
      kind: 'resume',
      attempt: 2,
      pause: { reason: 'reader_stopped', at: '2026-01-01T00:00:00.000Z' },
    });
    assert.equal(marker.label, 'Execução retomada · tentativa 2');
    assert.equal(marker.tooltip, 'Execução pausada · você parou a execução');
    assert.equal(marker.action, false);
  });
  test('accepts only the pause reasons this vocabulary knows', () => {
    assert.equal(pauseReason('host_stopped'), 'host_stopped');
    assert.equal(pauseReason('host_restarted'), 'host_restarted');
    assert.equal(pauseReason('reader_stopped'), 'reader_stopped');
    assert.equal(pauseReason('something_else'), undefined);
    assert.equal(pauseReason(undefined), undefined);
  });

  test('accepts only an attempt number the host could have opened', () => {
    assert.equal(resumeAttempt(1), 1);
    assert.equal(resumeAttempt(7), 7);
    assert.equal(resumeAttempt(0), undefined);
    assert.equal(resumeAttempt(1.5), undefined);
    assert.equal(resumeAttempt('1'), undefined);
  });

  test('reads a failure out of the error the host redacted or shaped', () => {
    assert.deepEqual(
      promptFailure({
        code: 'resume_exhausted',
        message: 'three times',
        name: 'ResumeExhaustedError',
      }),
      {
        code: 'resume_exhausted',
        message: 'three times',
        name: 'ResumeExhaustedError',
      },
    );
    assert.deepEqual(promptFailure('redacted'), {
      code: '',
      message: 'redacted',
      name: '',
    });
    assert.deepEqual(promptFailure(undefined), {
      code: '',
      message: '',
      name: '',
    });
    assert.equal(statesFailure(promptFailure({ code: 'boom' })), true);
    assert.equal(statesFailure(promptFailure(undefined)), false);
  });

  test('recognises the resume that ran out of attempts as a warning', () => {
    assert.equal(resumeExhausted('resume_exhausted'), true);
    assert.equal(resumeExhausted('boom'), false);
    assert.equal(resumeExhausted(''), false);
    assert.equal(resumeExhausted(undefined), false);
  });
});
