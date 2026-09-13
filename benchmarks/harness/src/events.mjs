/** Wait for host persistence; never silently continue after lost evidence. */
export const createEventPublisher =
  ({ baseUrl, apiKey }) =>
  async (event) => {
    const response = await fetch(baseUrl + '/events', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status !== 204) {
      throw new Error('Benchmark event persistence failed.');
    }
  };
