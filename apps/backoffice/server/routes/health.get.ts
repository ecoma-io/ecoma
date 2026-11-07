import { defineEventHandler } from 'h3';

/**
 * `GET /health` — liveness, không query database.
 *
 * Mirror `apps/account/server/routes/health.get.ts`. `/ready` là readiness có DB.
 */
export default defineEventHandler(() => {
  return { status: 'ok' };
});
