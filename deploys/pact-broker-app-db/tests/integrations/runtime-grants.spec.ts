/**
 * Contract vai role của `db-pact-broker-app` sau khi authority đã apply schema
 * (AC #378: "runtime/migrator role separation verify được cho cả 2 DB" — nửa
 * app; nửa `db-pact-broker` nằm ở `apps/pact-broker-api/tests/databases`).
 *
 * Phạm vi: grant matrix mà migration `0000` thiết lập — runtime role có DML
 * trên `pact_broker_app` (INSERT/UPDATE session là hành vi BFF) và KHÔNG có
 * DDL (CREATE TABLE bị PostgreSQL từ chối — schema không thuộc runtime,
 * `GRANT CREATE` chỉ dành cho migrator ở provisioning step). Mọi behavior
 * khác của runner (no-replay, stamp, lock, guard database) là của
 * `runner-integration.spec.ts`.
 *
 * ⚠️ Docker là phụ thuộc cứng (06-testing.md §6): probe hỏng làm cả run đỏ —
 * skip với exit 0 không phải kết quả được chấp nhận.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client } from 'pg';

import { CONTRACT_DATABASE, recreateContractDatabase, startPactDatabase } from './harness.ts';

const MIGRATOR_ROLE = 'ecoma_pact_broker_app_migrator';
const RUNTIME_ROLE = 'ecoma_pact_broker_app_runtime';
const ROLE_PASSWORD = 'ecoma_test_role_pw';

const projectRoot = resolve(import.meta.dirname, '../..');
const runnerPath = join(projectRoot, 'runner.mts');
const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');

describe(`${CONTRACT_DATABASE} runtime role grants (migration 0000)`, { timeout: 180_000 }, () => {
  let db: Awaited<ReturnType<typeof startPactDatabase>>;

  beforeAll(async () => {
    db = await startPactDatabase();
  });

  afterAll(async () => {
    await db.container.stop({ timeout: 10_000 });
  });

  it('lets the runtime role do session DML and nothing else', async () => {
    // Database trắng trước — DROP DATABASE xoá cả grant cấp database, nên
    // provisioning (role LOGIN + grant CREATE) phải chạy SAU recreate.
    await recreateContractDatabase(db.adminUrl);

    // Provisioning step (superuser, ngoài migration): role LOGIN với password
    // và grant CREATE database cho migrator — guard DO-block của `0000` thấy
    // role đã có sẽ bỏ qua; migrator giữ NOCREATEROLE nên không tự tạo được.
    const provision = new Client({ connectionString: db.databaseUrl });
    await provision.connect();
    try {
      await provision.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATOR_ROLE}') THEN
             CREATE ROLE ${MIGRATOR_ROLE} LOGIN PASSWORD '${ROLE_PASSWORD}'
               NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
           END IF;
           IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
             CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${ROLE_PASSWORD}'
               NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
           END IF;
         END $$;`,
      );
      await provision.query(
        `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${CONTRACT_DATABASE}" TO ${MIGRATOR_ROLE}`,
      );
      await provision.query(`GRANT CONNECT ON DATABASE "${CONTRACT_DATABASE}" TO ${RUNTIME_ROLE}`);
    } finally {
      await provision.end();
    }

    // Apply qua runner thật của authority — cùng đường mà lane chạy.
    const migratorUrl = new URL(db.databaseUrl);
    migratorUrl.username = MIGRATOR_ROLE;
    migratorUrl.password = ROLE_PASSWORD;
    const result = spawnSync(process.execPath, [tsxCli, runnerPath, 'migrate'], {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: migratorUrl.toString() },
      encoding: 'utf-8',
      timeout: 120_000,
    });
    expect(
      result.signal,
      `runner killed by signal ${String(result.signal)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBeNull();
    expect(
      result.status,
      `runner exited ${String(result.status)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);

    // Runtime là role thật (không SET ROLE): đúng kênh kết nối mà BFF dùng.
    const runtime = new Client({
      host: db.container.getHost(),
      port: db.container.getMappedPort(5_432),
      user: RUNTIME_ROLE,
      password: ROLE_PASSWORD,
      database: CONTRACT_DATABASE,
    });
    await runtime.connect();
    try {
      // DML được: INSERT session là hành vi bình thường của BFF callback.
      await runtime.query(
        `INSERT INTO pact_broker_app.bff_sessions
           (id_hash, account_sub, access_token, expires_at)
         VALUES (repeat('a', 64), 'sub-grant-probe', 'token-grant-probe', now() + interval '1 hour')`,
      );
      // UPDATE sliding expiry cũng được — guard trigger cho phép cột này.
      await runtime.query(
        `UPDATE pact_broker_app.bff_sessions SET expires_at = now() + interval '2 hours'
           WHERE id_hash = repeat('a', 64)`,
      );

      // DDL bị từ chối: runtime không sở hữu schema, không có CREATE.
      await expect(
        runtime.query(`CREATE TABLE pact_broker_app.grant_probe_should_fail (id int)`),
      ).rejects.toThrow(/permission denied/u);
    } finally {
      await runtime.end();
    }
  });
});
