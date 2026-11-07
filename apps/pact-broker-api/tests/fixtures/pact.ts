/**
 * Fixture pact hợp lệ cho API test — port `test/helpers.ts#samplePact` của
 * upstream (spec metadata `2.0.0`, một interaction GET → 200).
 */

export function samplePact(
  overrides: {
    consumer?: string;
    provider?: string;
    path?: string;
    description?: string;
  } = {},
): Record<string, unknown> {
  return {
    consumer: { name: overrides.consumer ?? 'demo-c' },
    provider: { name: overrides.provider ?? 'demo-p' },
    interactions: [
      {
        description: overrides.description ?? 'a request',
        request: { method: 'GET', path: overrides.path ?? '/ping' },
        response: { status: 200 },
      },
    ],
    metadata: { pactSpecification: { version: '2.0.0' } },
  };
}
