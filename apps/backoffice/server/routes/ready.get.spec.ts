import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import readyHandler from './ready.get';

describe('GET /ready', () => {
  let handler: WebHandler;

  beforeAll(() => {
    const app = createApp();
    const router = createRouter();
    router.get('/ready', readyHandler);
    app.use(router.handler);
    handler = toWebHandler(app);
  });

  beforeEach(() => {
    vi.stubGlobal('useRuntimeConfig', (): Record<string, unknown> => {
      return {};
    });
  });

  it('fails closed with 503 when no DB source is available', async () => {
    const response = await handler(new Request('http://localhost/ready'));
    expect(response.status).toBe(503);
  });

  it('reads runtime config through the request event', async () => {
    let captured: unknown;
    vi.stubGlobal('useRuntimeConfig', (event?: unknown): Record<string, unknown> => {
      captured = event;
      return {};
    });
    const response = await handler(new Request('http://localhost/ready'));
    expect(response.status).toBe(503);
    expect(captured).toBeDefined();
    expect(captured).toHaveProperty('path', '/ready');
  });
});
