import { createError, defineEventHandler } from 'h3';

import {
  backofficeHyperdrive,
  backofficeNodeDatabaseUrl,
  createNodePool,
  withBackofficePool,
} from '@ecoma-io/backoffice-infrastructure';

import { readWorkerEnv } from '../db';

/**
 * `GET /ready` — readiness, có kiểm phụ thuộc DB/schema.
 *
 * Hoạt động ở **hai** runtime:
 *  - Workers: dùng Hyperdrive binding `DB_BACKOFFICE`.
 *  - Container Node local: dùng connection string từ `runtimeConfig.backofficeDatabaseUrl`
 *    (private, phủ từ `NITRO_BACKOFFICE_DATABASE_URL`).
 *
 * Fail-closed: thiếu nguồn kết nối hoặc probe DB/schema thất bại ⇒ 503.
 */
async function probeWithPool(pool: import('pg').Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Chạm DB thật và schema thật: bảng `backoffice.permissions` phải tồn tại.
    await client.query('SELECT 1 FROM backoffice.permissions LIMIT 1');
  } finally {
    client.release();
  }
}

export default defineEventHandler(async (event) => {
  const runtimeConfig = (
    typeof useRuntimeConfig === 'function' ? useRuntimeConfig(event) : {}
  ) as unknown;

  // Ưu tiên Hyperdrive binding (Workers).
  const hyperdrive = backofficeHyperdrive(readWorkerEnv(event as never));
  if (hyperdrive) {
    try {
      await withBackofficePool(hyperdrive, async (pool) => {
        await probeWithPool(pool);
      });
    } catch {
      throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
    }
    return { status: 'ready' };
  }

  // Fallback Node container local.
  const nodeUrl = backofficeNodeDatabaseUrl(runtimeConfig);
  if (nodeUrl) {
    const pool = createNodePool(nodeUrl);
    try {
      await probeWithPool(pool);
    } catch {
      throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
    } finally {
      await pool.end();
    }
    return { status: 'ready' };
  }

  // Không có nguồn kết nối nào ⇒ fail closed.
  throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
});
