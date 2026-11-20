import { createApp, toWebHandler } from 'h3';
import { describe, expect, it } from 'vitest';

import healthGet from './health.get';

const handler = toWebHandler(createApp().use(healthGet));

async function getHealth() {
  const response = await handler(new Request('http://localhost/health'));
  return {
    status: response.status,
    body: (await response.json()) as { status?: string },
  };
}

describe('server/routes/health.get', () => {
  it('returns 200 with the liveness status marker', async () => {
    const res = await getHealth();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
