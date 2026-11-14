/**
 * Suite argv-hygiene của `pact-broker-api-deploy` (target `test-integration`)
 * — bằng chứng tự động cho bất biến bảo mật của unit: **không giá trị secret
 * nào vào argv của process host, vào script text, vào output bắt được** trong
 * lúc provision, migrate và bootstrap tenant chạy THẬT.
 *
 * Bản sao pattern của `deploys/llm-api-deploy/tests/integrations/argv-hygiene.spec.ts`
 * (06-testing.md §6: không shared test-support giữa các deploy unit), mở rộng
 * đúng BỐN đường mà unit này có: provision (hai role), migrate (`db/apply.mts`),
 * bootstrap tenant canonical (`db/bootstrap-tenant.mts`). Script provision
 * token máy của BFF đã bị retire (ADR-0031 §5, #206) — không còn step nào để
 * đo ở đây; hành vi script `db/provision-machine-token.mts` (còn là công cụ
 * operator cho machine path của Pact CLI) nằm ở `apps/pact-broker-api`
 * `tests/databases/provision-machine-token.spec.ts`.
 *
 * Thiết kế (06-testing.md §2/§4 — app-owned suite, Docker là phụ thuộc cứng,
 * vắng Docker là suite ĐỎ theo §6):
 *
 * 1. **Sentinel giả** — mật khẩu tổng hợp, KHÔNG phải secret thật, mỗi
 *    credential loại/khoảnh khắc một giá trị (mật khẩu migrator/runtime lần
 *    tạo, cặp mật khẩu lần xoay), có chứa
 *    nháy đơn và các ký tự edge (`% @ : / ; $ \` \\`) để khoá cả hai lớp escape
 *    (SQL quoting trong shell của script provision, percent-encoding của
 *    userinfo DATABASE_URL phía migrate/runtime).
 * 2. **Chạy đúng script thật** — text của cả bốn script lấy từ chính hàm build
 *    mà `index.ts` dùng (`scripts.ts`), chạy bằng `/bin/sh -c` (cùng hình
 *    interpreter mặc định của provider) với PATH bọc shim `docker` ghi argv và
 *    watcher quét `/proc/<pid>/cmdline` suốt luồng (gồm cả process bên trong
 *    container). PostgreSQL một-shot trên network RIÊNG của suite, tên có hậu
 *    tố ngẫu nhiên — không đụng stack của worktree khác; image ghim cùng digest
 *    với `platform-deploy` (đúng major production).
 * 3. **Assert hai chiều** — không sentinel ở bất kỳ kênh nào (argv log, sweep,
 *    stdout/stderr, script text) VÀ trạng thái database sau flow vẫn đúng:
 *    role/db/schema/grant, provision idempotent khi chạy lại, xoay password
 *    thật (login scram bằng mật khẩu mới, mật khẩu cũ bị từ chối — negative
 *    control), tenant `ecoma` thuộc owner giả, ON_ERROR_STOP dừng SQL hỏng
 *    mà không in câu SQL chứa secret.
 *
 * Mọi thông điệp lỗi nêu KÊNH rò rỉ, không bao giờ in giá trị sentinel.
 */
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createArgvHarness, type ArgvHarness, type RunResult } from './argv-harness.ts';
import {
  DATABASE_NAME,
  MIGRATOR_PASSWORD_ENV_VAR,
  MIGRATOR_ROLE,
  RUNTIME_PASSWORD_ENV_VAR,
  RUNTIME_ROLE,
  buildBootstrapTenantScript,
  buildMigrateScript,
  buildMigratorConnectionUrl,
  buildProvisionScript,
  buildRuntimeConnectionUrl,
} from '../../scripts.ts';

/**
 * Image PostgreSQL của suite — GHIM CÙNG DIGEST với `deploys/platform-deploy`
 * (PostgreSQL 17.11 + TimescaleDB): provision của unit chạy trên đúng major
 * production. Ghim lặp lại ở các unit là có chủ đích (06-testing.md §6: không
 * shared test-support giữa các deploy unit).
 */
const POSTGRES_IMAGE =
  'timescale/timescaledb@sha256:b346edcdb51a1fd6020e3965e0bd1c9f3406fa6d5fbce1e28f4852587ef934e2';

/**
 * Image Node pin của migrate/bootstrap — GIỐNG HẰNG `NODE_IMAGE` của unit
 * (`node-image.ts`, module thuần import được vào test). Dòng này là bản sao có
 * chủ đích của hằng đó trong suite integration; đổi digest phải đổi cả hai.
 */
const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

/**
 * Sáu sentinel — dữ liệu giả, phủ các edge case escape: nháy đơn (SQL quoting),
 * `%` (percent-encode URL), `@ : / ? #` (delineator userinfo), `$` và backtick
 * và `;` (mở rộng shell nếu giá trị bị tái phân tích). Cặp `*2` là giá trị của
 * lần XOAY (provision lần ba với mật khẩu mới).
 */
const SENTINELS = {
  pwMigrator1: `S3nt1n3l-Pact-Mig'x1%`,
  pwRuntime1: `S3nt1n3l-Pact-Run'x2$`,
  pwMigrator2: `S3nt1n3l-Pact-Mig2/x3@:`,
  pwRuntime2: `S3nt1n3l-Pact-Run2\`x4?`,
} as const;

/** `sub` chủ tenant giả — định danh test, hợp lệ theo CHECK 1–200 ký tự trim. */
const OWNER_SUB = 'sub-argv-hygiene-owner';

const WATCHED: ReadonlyArray<{ channel: string; value: string }> = [
  { channel: MIGRATOR_PASSWORD_ENV_VAR, value: SENTINELS.pwMigrator1 },
  { channel: RUNTIME_PASSWORD_ENV_VAR, value: SENTINELS.pwRuntime1 },
  { channel: 'rotated-migrator-password', value: SENTINELS.pwMigrator2 },
  { channel: 'rotated-runtime-password', value: SENTINELS.pwRuntime2 },
];

/**
 * Gốc repo thật — mount `/repo` của script migrate/bootstrap, y hệt
 * production. Bốn lần `dirname` từ `tests/integrations/`: integrations → tests
 * → pact-broker-api-deploy → deploys → gốc repo. Sai một cấp là `/repo` mất
 * subtree `apps/` và workdir `/repo/apps/pact-broker-api` không tồn tại trong
 * container (runc mkdir trên mount `:ro` fail).
 */
const WORKTREE_ROOT = resolve(dirname(dirname(dirname(dirname(import.meta.dirname)))));

/** Một lần chạy script đã ghi nhận; stdout/stderr giữ lại để assert không rò. */
interface RecordedRun {
  readonly name: string;
  readonly result: RunResult;
}

interface LoginCheck {
  readonly role: string;
  readonly label: string;
  readonly result: RunResult;
}

/** Mọi artifact của một lần chạy flow — `it` assert TRÊN artifact, không re-run. */
interface FlowArtifacts {
  readonly provisionScriptText: string;
  readonly migrateScriptText: string;
  readonly bootstrapScriptText: string;
  readonly provisionRun1: RecordedRun;
  readonly provisionRun2: RecordedRun;
  readonly provisionRotation: RecordedRun;
  readonly migrateRun: RecordedRun;
  readonly bootstrapRun: RecordedRun;
  readonly bootstrapRerun: RecordedRun;
  readonly onStopFailure: RecordedRun;
  readonly catalog: Record<string, RunResult>;
  readonly logins: LoginCheck[];
  readonly wrongPassword: RunResult;
  readonly oldMigratorPassword: RunResult;
  readonly argvLog: Buffer;
  readonly watcherHits: string;
  readonly canary: string;
}

let harness: ArgvHarness | undefined;
let flow: FlowArtifacts | undefined;
let flowError: unknown;

/** Ném lại lỗi thật của flow thay vì một "expected undefined" mơ hồ. */
function requireFlow(): FlowArtifacts {
  if (flowError !== undefined) {
    throw flowError;
  }
  if (flow === undefined) {
    throw new Error('argv-hygiene flow did not produce artifacts');
  }
  return flow;
}

beforeAll(async () => {
  const created = await createArgvHarness();
  harness = created;
  const canary = `ecoma-argv-canary-${randomUUID().slice(0, 8)}`;
  try {
    // Watcher bắt đầu TRƯỚC mọi flow — cả boot container cũng nằm trong tầm quét.
    await created.startWatcher({
      canary,
      ...Object.fromEntries(WATCHED.map(({ channel, value }) => [channel, value])),
    });
    await created.startPostgres(POSTGRES_IMAGE);

    // --- 1. Provision: script text từ chính hàm build mà index.ts dùng. -----
    const provisionScriptText = buildProvisionScript({
      postgresContainerName: created.containerName,
    });
    const createEnv = {
      [MIGRATOR_PASSWORD_ENV_VAR]: SENTINELS.pwMigrator1,
      [RUNTIME_PASSWORD_ENV_VAR]: SENTINELS.pwRuntime1,
    };
    const provisionRun1: RecordedRun = {
      name: 'provision #1 (create)',
      result: await created.runScript(provisionScriptText, createEnv),
    };
    if (provisionRun1.result.code !== 0) {
      // Prerequisite hỏng — mọi assert sau vô nghĩa, bỏ flow với lỗi thật.
      throw new Error(
        `provision #1 exited non-zero — stdout:\n${provisionRun1.result.stdout}\nstderr:\n${provisionRun1.result.stderr}`,
      );
    }
    const provisionRun2: RecordedRun = {
      name: 'provision #2 (idempotency, same passwords)',
      result: await created.runScript(provisionScriptText, createEnv),
    };
    const provisionRotation: RecordedRun = {
      name: 'provision #3 (rotate both passwords)',
      result: await created.runScript(provisionScriptText, {
        [MIGRATOR_PASSWORD_ENV_VAR]: SENTINELS.pwMigrator2,
        [RUNTIME_PASSWORD_ENV_VAR]: SENTINELS.pwRuntime2,
      }),
    };

    // --- 2. Migrate — DATABASE_URL ghép y hệt production (URL builder, mật
    //     khẩu lần xoay) và đi bằng env của shell, không qua argv. ------------
    const migrateScriptText = buildMigrateScript({
      networkName: created.networkName,
      worktreeRoot: WORKTREE_ROOT,
      nodeImage: NODE_IMAGE,
    });
    const migrateRun: RecordedRun = {
      name: 'migrate db-pact-broker',
      result: await created.runScript(
        migrateScriptText,
        // ĐÚNG hình wiring: giá trị của map `environment` = URL từ builder.
        { DATABASE_URL: buildMigratorConnectionUrl({ password: SENTINELS.pwMigrator2 }) },
      ),
    };
    if (migrateRun.result.code !== 0) {
      throw new Error(
        `migrate exited non-zero — stdout:\n${migrateRun.result.stdout}\nstderr:\n${migrateRun.result.stderr}`,
      );
    }

    // --- 3. Bootstrap tenant canonical — container ephemeral trên network,
    //     DATABASE_URL qua env (name-only trong argv).
    //     RUNTIME (đúng hình wiring của index.ts) với mật khẩu lần xoay. -------
    const bootstrapScriptText = buildBootstrapTenantScript({
      networkName: created.networkName,
      worktreeRoot: WORKTREE_ROOT,
      nodeImage: NODE_IMAGE,
      tenantOwnerSub: OWNER_SUB,
    });
    const runtimeEnv = {
      DATABASE_URL: buildRuntimeConnectionUrl({ password: SENTINELS.pwRuntime2 }),
      CANONICAL_TENANT_OWNER_SUB: OWNER_SUB,
    };
    const bootstrapRun: RecordedRun = {
      name: 'bootstrap tenant ecoma',
      result: await created.runScript(bootstrapScriptText, runtimeEnv),
    };
    if (bootstrapRun.result.code !== 0) {
      throw new Error(
        `bootstrap tenant exited non-zero — stdout:\n${bootstrapRun.result.stdout}\nstderr:\n${bootstrapRun.result.stderr}`,
      );
    }
    const bootstrapRerun: RecordedRun = {
      name: 'bootstrap tenant ecoma re-run (idempotency)',
      result: await created.runScript(bootstrapScriptText, runtimeEnv),
    };

    // --- 4. Failure semantics: ON_ERROR_STOP dừng SQL hỏng, không in SQL. ----
    // Cùng hình kênh stdin với production (printf builtin → sed qua stdin →
    // docker exec -i psql); SQL cố tình sai và chứa sentinel.
    const badSqlScript = `sql_quote() { printf '%s' "$1" | sed "s/'/''/g"; }
quoted=$(sql_quote "$BAD_PW")
printf '%s\\n' "ALTER ROLE argv_hygiene_missing_role WITH PASSWORD '$quoted';" | docker exec -i ${created.containerName} psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1
`;
    const onStopFailure: RecordedRun = {
      name: 'ON_ERROR_STOP failure probe',
      result: await created.runScript(badSqlScript, { BAD_PW: SENTINELS.pwMigrator2 }),
    };

    // --- 5. Canary: chứng minh sweep /proc THẬT SỰ bắt được argv. ------------
    // argv `sh -c` chứa canary trong comment — watcher phải thấy ít nhất một
    // hit (assert ở `it` riêng: thiếu hit là harness hỏng, không phải pass).
    // Window 8s: một vòng quét /proc toàn máy (một readFile mỗi pid) dưới tải
    // CI — nhiều suite chạy song song — có thể vượt xa 0.4s, canary sống ngắn
    // thì thoát khỏi mọi vòng quét (đo được: run 43294456886 đỏ ở 3 package,
    // cùng cơ chế). Window phải trội hơn chu kỳ quét xấu nhất — không tối ưu xuống.
    await created.runScript(`sleep 8 # ${canary}`);

    // --- 6. Thu dữ liệu catalog (qua shim — argv của những call này cũng bị
    //    ghi vào log và bị quét; SQL không chứa secret nào). pg_roles/pg_database
    //    là catalog TOÀN CỤ, pg_namespace/pg_tables/pact.* là PER-DATABASE —
    //    query schema/table phải chạy BÊN TRONG database tương ứng. Query
    //    catalog hỏng là lỗi flow (prerequisite), abort với stderr thật.
    const catalog: Record<string, RunResult> = {};
    const psqlAsLocal = async (key: string, database: string, sql: string): Promise<void> => {
      const result: RunResult = await created.runScript(
        `docker exec ${created.containerName} psql -U ecoma_local -d ${database} -tAc ${shellQuoteForTest(sql)}`,
      );
      if (result.code !== 0) {
        throw new Error(
          `catalog query ${key} failed — stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }
      catalog[key] = result;
    };
    await psqlAsLocal(
      'roleCount',
      'postgres',
      `SELECT count(*) FROM pg_roles WHERE rolname IN ('${MIGRATOR_ROLE}','${RUNTIME_ROLE}')`,
    );
    await psqlAsLocal(
      'dbExists',
      'postgres',
      `SELECT count(*) FROM pg_database WHERE datname='${DATABASE_NAME}'`,
    );
    await psqlAsLocal(
      'grantMatrix',
      'postgres',
      [
        `SELECT has_database_privilege('${MIGRATOR_ROLE}','${DATABASE_NAME}','CREATE')`,
        `AND has_database_privilege('${MIGRATOR_ROLE}','${DATABASE_NAME}','TEMPORARY')`,
        `AND has_database_privilege('${RUNTIME_ROLE}','${DATABASE_NAME}','CONNECT')`,
        // 'public' chữ thường: has_database_privilege resolve TÊN role literal,
        // pseudo-role PUBLIC chỉ tồn tại dưới tên 'public'.
        `AND NOT has_database_privilege('public','${DATABASE_NAME}','CONNECT')`,
      ].join(' '),
    );
    await psqlAsLocal(
      'schemaTables',
      DATABASE_NAME,
      `SELECT count(*) FROM pg_tables WHERE schemaname='pact'`,
    );
    await psqlAsLocal(
      'tenantOwnerSub',
      DATABASE_NAME,
      `SELECT owner_sub FROM pact.tenants WHERE name='ecoma'`,
    );
    // --- 7. Login bằng sentinel (password verify THẬT qua scram). pg_hba của
    //    image: các dòng loopback trust của initdb đứng TRƯỚC, entrypoint chỉ
    //    APPEND `host all all all scram-sha-256` (first-match wins) — nối
    //    127.0.0.1 là trust và password không bao giờ được kiểm. Nên mỗi login
    //    nối tới IP eth0 của container (resolve trước bằng docker inspect, giá
    //    trị không phải secret) để rơi vào dòng scram. PGPASSWORD đi bằng env
    //    (docker exec -e chỉ mang TÊN biến — giá trị không bao giờ trong argv).
    const pgAddressRun = await created.runScript(
      `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${created.containerName}`,
    );
    if (pgAddressRun.code !== 0 || pgAddressRun.stdout.trim() === '') {
      throw new Error(
        `could not resolve postgres container address — stdout:\n${pgAddressRun.stdout}\nstderr:\n${pgAddressRun.stderr}`,
      );
    }
    const pgAddress = pgAddressRun.stdout.trim();
    const loginAs = async (role: string, label: string, password: string): Promise<LoginCheck> => ({
      role,
      label,
      result: await created.runScript(
        `docker exec -e PGPASSWORD ${created.containerName} psql -h ${pgAddress} -U ${role} -d ${DATABASE_NAME} -tAc 'SELECT current_user'`,
        { PGPASSWORD: password },
      ),
    });
    const logins: LoginCheck[] = await Promise.all([
      loginAs(MIGRATOR_ROLE, 'rotated migrator password accepted', SENTINELS.pwMigrator2),
      loginAs(RUNTIME_ROLE, 'rotated runtime password accepted', SENTINELS.pwRuntime2),
    ]);
    // Negative control: sai mật khẩu phải bị từ chối ở dòng scram — chứng minh
    // các login check phía trên đi qua đường verify thật (không phải trust).
    const wrongPassword = (
      await loginAs(
        MIGRATOR_ROLE,
        'wrong password rejected',
        'definitely-not-the-sentinel-password',
      )
    ).result;
    // Rotation thật: mật khẩu lần TẠO phải bị từ chối sau khi provision lần ba
    // áp mật khẩu mới (mỗi role giữ đúng MỘT password).
    const oldMigratorPassword = (
      await loginAs(MIGRATOR_ROLE, 'pre-rotation migrator password rejected', SENTINELS.pwMigrator1)
    ).result;

    flow = {
      provisionScriptText,
      migrateScriptText,
      bootstrapScriptText,
      provisionRun1,
      provisionRun2,
      provisionRotation,
      migrateRun,
      bootstrapRun,
      bootstrapRerun,
      onStopFailure,
      catalog,
      logins,
      wrongPassword,
      oldMigratorPassword,
      argvLog: await created.readArgvLog(),
      watcherHits: await created.readWatcherHits(),
      canary,
    };
  } catch (error) {
    flowError = error;
  }
});

afterAll(async () => {
  await harness?.stop();
});

/** Nối stdout/stderr của MỌI lần chạy đã ghi nhận thành một buffer tìm sentinel. */
function capturedOutputBuffer(flowState: FlowArtifacts): Buffer {
  const runs: RecordedRun[] = [
    flowState.provisionRun1,
    flowState.provisionRun2,
    flowState.provisionRotation,
    flowState.migrateRun,
    flowState.bootstrapRun,
    flowState.bootstrapRerun,
    flowState.onStopFailure,
    ...flowState.logins.map((login) => ({
      name: `login ${login.role} (${login.label})`,
      result: login.result,
    })),
    { name: 'wrong password control', result: flowState.wrongPassword },
    { name: 'pre-rotation password control', result: flowState.oldMigratorPassword },
    ...Object.entries(flowState.catalog).map(([key, result]) => ({
      name: `catalog ${key}`,
      result,
    })),
  ];
  return Buffer.from(
    runs.map((run) => `${run.result.stdout}\n${run.result.stderr}`).join('\n'),
    'utf8',
  );
}

/** Nháy đơn quoting cho đối số SQL trong script shell (dữ liệu test, không secret). */
function shellQuoteForTest(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

describe('argv hygiene: no sentinel ever reaches a host process argument', () => {
  it('docker argv log recorded the real flows and carries none of the sentinels', () => {
    const flowState = requireFlow();
    // Recording phải chạy thật: shim đã ghi lại cả `docker exec` (provision)
    // lẫn `docker run` (migrate/bootstrap) — log rỗng là harness hỏng.
    expect(flowState.argvLog.includes(Buffer.from('ON_ERROR_STOP', 'utf8'))).toBe(true);
    expect(flowState.argvLog.includes(Buffer.from('--network', 'utf8'))).toBe(true);
    for (const { channel, value } of WATCHED) {
      expect(
        flowState.argvLog.includes(Buffer.from(value, 'utf8')),
        `sentinel ${channel} found in docker argv log`,
      ).toBe(false);
    }
  });

  it('/proc sweep catches the canary and none of the sentinels', () => {
    const flowState = requireFlow();
    const hits = flowState.watcherHits.split('\n').filter((line) => line.length > 0);
    expect(
      hits.some((line) => line.startsWith('canary ') && line.includes(' pid=')),
      'canary not caught by the /proc sweep — the sweep itself is broken',
    ).toBe(true);
    const sentinelHits = hits.filter((line) => !line.startsWith('canary '));
    expect(sentinelHits, 'sentinel found in /proc cmdline sweep').toEqual([]);
  });

  it('captured stdout/stderr of every run carries none of the sentinels', () => {
    const flowState = requireFlow();
    const captured = capturedOutputBuffer(flowState);
    for (const { channel, value } of WATCHED) {
      expect(
        captured.includes(Buffer.from(value, 'utf8')),
        `sentinel ${channel} found in captured command output`,
      ).toBe(false);
    }
  });

  it('rendered script texts carry none of the sentinels', () => {
    const flowState = requireFlow();
    const scriptTexts = [
      flowState.provisionScriptText,
      flowState.migrateScriptText,
      flowState.bootstrapScriptText,
    ];
    for (const text of scriptTexts) {
      for (const { channel, value } of WATCHED) {
        expect(text.includes(value), `sentinel ${channel} found in rendered script text`).toBe(
          false,
        );
      }
    }
    // Hai script chạy container phải truyền secret qua TÊN biến, không giá trị.
    for (const text of [flowState.migrateScriptText, flowState.bootstrapScriptText]) {
      expect(text).toContain('-e DATABASE_URL \\');
      expect(text).not.toMatch(/-e DATABASE_URL=/u);
    }
  });

  it('ON_ERROR_STOP aborts bad SQL without echoing the secret-bearing statement', () => {
    const flowState = requireFlow();
    const { result } = flowState.onStopFailure;
    expect(result.code).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output.includes(SENTINELS.pwMigrator2)).toBe(false);
    // Câu SQL hỏng không được in lại vào output (psql chỉ in ERROR của server).
    expect(output.includes('WITH PASSWORD')).toBe(false);
  });
});

describe('provision creates, applies idempotently and rotates for real', () => {
  it('all three provision runs exit zero', () => {
    const flowState = requireFlow();
    expect(flowState.provisionRun1.result.code).toBe(0);
    expect(flowState.provisionRun2.result.code).toBe(0);
    expect(flowState.provisionRotation.result.code).toBe(0);
  });

  it('provisioned the two roles, the database and the grant matrix', () => {
    const flowState = requireFlow();
    expect(flowState.catalog.roleCount?.stdout.trim()).toBe('2');
    expect(flowState.catalog.dbExists?.stdout.trim()).toBe('1');
    expect(flowState.catalog.grantMatrix?.stdout.trim()).toBe('t');
  });

  it('rotation replaced the password: new accepted, pre-rotation rejected, wrong rejected', () => {
    const flowState = requireFlow();
    for (const login of flowState.logins) {
      expect(login.result.code, `login ${login.role} (${login.label}) exited non-zero`).toBe(0);
      expect(
        login.result.stdout.trim(),
        `login ${login.role} (${login.label}) wrong current_user`,
      ).toBe(login.role);
    }
    expect(flowState.wrongPassword.code).not.toBe(0);
    expect(flowState.oldMigratorPassword.code).not.toBe(0);
  });
});

describe('migrate runs the canonical runner against the right database', () => {
  it('applies all migrations through db/apply.mts with the rotated credential', () => {
    const flowState = requireFlow();
    const { result } = flowState.migrateRun;
    expect(result.code).toBe(0);
    // stdout của `db/apply.mts`: "applied <file>" + "done N file(s) applied; M
    // tables in schema pact" — số bảng tính trên DATABASE ĐANG KẾT NỐI, nên
    // dòng này là bằng chứng migrate nối đúng db-pact-broker.
    expect(result.stdout).toContain('file(s) applied');
    expect(result.stdout).toMatch(/tables in schema pact/u);
  });

  it('lands the pact tables inside db-pact-broker', () => {
    const flowState = requireFlow();
    expect(
      Number(flowState.catalog.schemaTables?.stdout.trim()),
      'pact tables missing in db-pact-broker',
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('bootstrap tenant runs end-to-end through the runtime credential', () => {
  it('created the canonical tenant owned by the configured sub', () => {
    const flowState = requireFlow();
    const { result } = flowState.bootstrapRun;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('tenant ecoma created');
    expect(flowState.catalog.tenantOwnerSub?.stdout.trim()).toBe(OWNER_SUB);
  });

  it('re-running bootstrap is a no-op that preserves state', () => {
    const flowState = requireFlow();
    const { result } = flowState.bootstrapRerun;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('already exists');
    expect(result.stdout).toContain('no-op, state preserved');
  });
});
