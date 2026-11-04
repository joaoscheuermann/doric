// The icon of the model that answered a turn, as the chat reads it from the
// host's `models/v1.icons`. The handle is the boundary: a test hands the
// adapter a fake `icons`, or none, and reads what `readModelIcon` answers.
// "Known absent" (`null`) draws the bot glyph; a rejection leaves the mark
// empty, so only a refusal that proves the host has no icons may answer `null`.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  ContractError,
  type ModelIconAnswers,
  type Models,
} from 'bundle/contracts';

import {
  readModelIcon,
  setModelsApi,
} from '../../src/client/api/model-icons.js';

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>';

type IconsInput = Parameters<Models['icons']>[0];

/** A handle whose `icons` answers what `answer` gives for the input it was sent. */
const handle = (
  answer: (input: IconsInput) => Promise<ModelIconAnswers>,
): Pick<Models, 'icons'> => ({ icons: (input) => answer(input) });

/** Whether the input asks for exactly one provider's one model. */
const asksFor = (input: IconsInput, providerId: string, model: string) => {
  const [request, ...rest] = input.requests;
  return (
    rest.length === 0 &&
    request !== undefined &&
    'providerId' in request &&
    request.providerId === providerId &&
    request.models.length === 1 &&
    request.models[0] === model
  );
};

afterEach(() => {
  setModelsApi(undefined);
});

describe("the icon of a turn's answering model", () => {
  test('with no handle the icon is known absent', async () => {
    setModelsApi(undefined);

    assert.equal(await readModelIcon('or', 'a'), null);
  });

  test("with a handle the pair's SVG is answered, and none when the answer names none", async () => {
    setModelsApi(
      handle(
        async (input): Promise<ModelIconAnswers> =>
          asksFor(input, 'or', 'a')
            ? { svgs: { openai: SVG }, answers: [{ models: ['openai'] }] }
            : { svgs: {}, answers: [{ models: [null] }] },
      ),
    );

    assert.equal(await readModelIcon('or', 'a'), SVG);
    assert.equal(await readModelIcon('or', 'b'), null);
  });

  test('a name the answer holds no SVG for is known absence', async () => {
    setModelsApi(
      handle(async () => ({
        svgs: {},
        answers: [{ models: ['toString'] }],
      })),
    );

    assert.equal(await readModelIcon('or', 'a'), null);
  });

  test("the window's own refusal of icons is known absence; any other unavailable or error rejects", async () => {
    const refusing = (error: unknown) => handle(() => Promise.reject(error));

    setModelsApi(
      refusing(
        new ContractError(
          'unavailable',
          'Contract "models/v1" has no method "icons".',
          { contract: 'models/v1', method: 'icons' },
        ),
      ),
    );
    assert.equal(await readModelIcon('or', 'a'), null);

    setModelsApi(
      refusing(
        new ContractError('unavailable', 'Doric backend is unavailable.'),
      ),
    );
    await assert.rejects(readModelIcon('or', 'a'));

    setModelsApi(
      refusing(
        new ContractError('unavailable', 'No active provider of "models/v1".', {
          contract: 'models/v1',
        }),
      ),
    );
    await assert.rejects(readModelIcon('or', 'a'));

    setModelsApi(
      refusing(
        new ContractError('internal', 'Contract "models/v1" failed.', {
          contract: 'models/v1',
          method: 'icons',
        }),
      ),
    );
    await assert.rejects(readModelIcon('or', 'a'));

    setModelsApi(refusing(new Error('broken')));
    await assert.rejects(readModelIcon('or', 'a'));
  });

  test('a handle that throws as it is called rejects rather than throwing', async () => {
    setModelsApi({
      icons: () => {
        throw new Error('broken');
      },
    });

    const read = readModelIcon('or', 'a');

    await assert.rejects(read);
  });
});
