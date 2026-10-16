// Dev-only: what the fake host seeds when it boots.
//
// The real host would have produced this Thread by running an agent against
// the fake Project's sandbox. The fake host runs no agent, so it writes the
// scripted history itself — one prompt, its run, one `papercraft_preview` tool
// call and the artifact that call published.
//
// The artifact's payload is the fixture checked in beside this file, named by
// its Project-relative path exactly as the papercraft host part names the
// source it derives a preview from (`record.path` → `files/v1`). Nothing about
// the markup is authored here: the build derives it, the registry appends the
// event. When the papercraft host part is not built, the history still lands
// and the log says the preview has no markup.

import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** The id the seeded preview keeps, so a dev session is reproducible. */
export const SEEDED_ARTIFACT_ID = 'checkout-preview';

/** The prompt the seeded conversation belongs to. */
export const SEEDED_PROMPT_ID = '00000000-0000-4000-8000-000000000001';

/** The fixture the seeded preview is built from, relative to the repository. */
export const SEEDED_FIXTURE = 'scripts/fake-host/fixtures/checkout.html';

const SEEDED_TITLE = 'Checkout com o botão de pagar';

const SEEDED_PROMPT = 'Mostre o checkout com o botão de pagar como preview.';

const SEEDED_BUTTON = '<button type="button">Pagar agora</button>';

const SEEDED_PARAGRAPH =
  'O preview do checkout está na conversa — comente o que ajustar e eu publico uma revisão.';

/**
 * Seeds the scripted history and the preview artifact, and returns what it
 * wrote: the artifact id, the revision, the source path and whether the
 * preview has markup.
 */
export const seedDevWorkspace = async ({
  root,
  workspaceRoot,
  defaults,
  threads,
  artifacts,
  log,
}) => {
  const fixture = join(root, SEEDED_FIXTURE);
  const bytes = await readFile(fixture).catch(() => undefined);

  if (bytes === undefined) {
    log.note(
      `no fixture at ${fixture}: the seeded preview artifact is skipped`,
    );

    return { events: 0, artifactId: undefined };
  }

  const sourcePath = relative(workspaceRoot, fixture);

  if (sourcePath.startsWith('..')) {
    log.note(
      `the fixture ${fixture} is outside the Project workspace ${workspaceRoot}: the seeded preview artifact is skipped`,
    );

    return { events: 0, artifactId: undefined };
  }

  threads.setPromptId(defaults.threadId, SEEDED_PROMPT_ID);

  const scope = { projectId: defaults.projectId, threadId: defaults.threadId };

  threads.appendMany({
    ...scope,
    promptId: SEEDED_PROMPT_ID,
    values: [
      {
        type: 'prompt.accepted',
        event: {
          type: 'prompt.accepted',
          text: SEEDED_PROMPT,
          source: { kind: 'user' },
          queued: false,
        },
      },
      { type: 'prompt.started', event: { type: 'prompt.started' } },
      { type: 'agent.started', event: { type: 'agent.started' } },
      {
        type: 'tool.started',
        event: {
          type: 'tool.started',
          call: {
            id: 'call-preview-1',
            name: 'papercraft_preview',
            index: 0,
            payload: {
              title: SEEDED_TITLE,
              source: 'html',
              path: sourcePath,
            },
          },
        },
      },
    ],
  });

  // A preview from an `html` source names the source itself, as the tool's
  // own `defaultTargets` does.
  const targets = [{ path: sourcePath, line: 90, snippet: SEEDED_BUTTON }];

  const record = await artifacts.create({
    artifactId: SEEDED_ARTIFACT_ID,
    kind: 'preview',
    title: SEEDED_TITLE,
    targets,
    source: 'html',
    path: sourcePath,
  });

  const built = artifacts.payloadOf(SEEDED_ARTIFACT_ID, record.revision) ?? {
    files: [],
  };
  const hasMarkup = typeof built.markup === 'string' && built.markup.length > 0;

  log.note(
    hasMarkup
      ? `seeded preview ${SEEDED_ARTIFACT_ID} revision ${record.revision} from ${sourcePath} (${built.files.length} entr${built.files.length === 1 ? 'y' : 'ies'}, ${built.markup.length} bytes of markup)`
      : `seeded preview ${SEEDED_ARTIFACT_ID} revision ${record.revision} from ${sourcePath} without markup: the papercraft build answered none`,
  );

  threads.appendMany({
    ...scope,
    promptId: SEEDED_PROMPT_ID,
    values: [
      {
        type: 'tool.finished',
        event: {
          type: 'tool.finished',
          call: {
            id: 'call-preview-1',
            name: 'papercraft_preview',
            index: 0,
            payload: { title: SEEDED_TITLE, source: 'html', path: sourcePath },
          },
          result: { artifactId: SEEDED_ARTIFACT_ID, revision: record.revision },
          content: `${SEEDED_ARTIFACT_ID} revision ${record.revision}`,
          record: {
            id: 'call-record-1',
            callId: 'call-preview-1',
            toolName: 'papercraft_preview',
            input: JSON.stringify({
              title: SEEDED_TITLE,
              source: 'html',
              path: sourcePath,
            }),
            output: `artifact ${SEEDED_ARTIFACT_ID}, revision ${record.revision}, state open`,
          },
        },
      },
      {
        type: 'text.delta',
        event: { type: 'text.delta', delta: SEEDED_PARAGRAPH },
      },
      {
        type: 'prompt.finished',
        event: {
          type: 'prompt.finished',
          status: 'completed',
          text: SEEDED_PARAGRAPH,
          source: { kind: 'user' },
        },
      },
    ],
  });

  log.note(
    `seeded ${threads.counts()[defaults.threadId] ?? 0} events on Thread ${defaults.threadId} (project ${defaults.projectId}, prompt ${SEEDED_PROMPT_ID})`,
  );

  return {
    artifactId: SEEDED_ARTIFACT_ID,
    revision: record.revision,
    directory: artifacts.dirOf(SEEDED_ARTIFACT_ID),
    sourcePath,
    files: built.files,
    hasMarkup,
    events: threads.counts()[defaults.threadId] ?? 0,
  };
};
