import { describe, expect, it } from 'vitest';

import { BackofficeRouteError } from './route-error';

describe('BackofficeRouteError', () => {
  it('carries the HTTP status next to the message', () => {
    const error = new BackofficeRouteError('Backoffice route /api/staff trả về 401', 401);

    expect(error.status).toBe(401);
    expect(error.message).toBe('Backoffice route /api/staff trả về 401');
    expect(error.name).toBe('BackofficeRouteError');
  });

  it('is an Error, so existing string paths keep working', () => {
    expect(new BackofficeRouteError('x', 503)).toBeInstanceOf(Error);
  });

  it('distinguishes two errors by status, not by message text', () => {
    const unauthorized = new BackofficeRouteError('route trả về 401', 401);
    const forbidden = new BackofficeRouteError('route trả về 403', 403);

    expect(unauthorized.status).not.toBe(forbidden.status);
  });
});
