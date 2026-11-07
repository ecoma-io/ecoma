import { createApp, toWebHandler } from 'h3';
import { describe, expect, it } from 'vitest';

import indexGet from './index.get';

const handler = toWebHandler(createApp().use(indexGet));

async function getRoot() {
  const response = await handler(new Request('http://localhost/'));
  return {
    status: response.status,
    location: response.headers.get('location'),
  };
}

describe('server/routes/index.get', () => {
  it('returns a 302 and redirects to /en (server-side)', async () => {
    const res = await getRoot();
    expect(res.status).toBe(302);
    expect(res.location).toBe('/en');
  });

  it('does not redirect to / (no loop)', async () => {
    const res = await getRoot();
    expect(res.location).not.toBe('/');
    expect(res.location).not.toBe('http://localhost/');
  });
});
