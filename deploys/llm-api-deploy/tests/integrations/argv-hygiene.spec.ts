/**
 * Suite argv-hygiene của `llm-api-deploy` (target `test-integration`) — bằng
 * chứng tự động cho bất biến bảo mật của unit: **không giá trị secret nào vào
 * argv của process host, vào script text, vào output bắt được** trong lúc
 * provision và migrate chạy THẬT.
 *
 * Thiết kế (06-testing.md §2/§4 — app-owned suite, Docker là phụ thuộc cứng,
 * vắng Docker là suite ĐỎ theo §6):
 *
 * 1. **Sentinel giả** — sáu mật khẩu tổng hợp, KHÔNG phải secret thật, mỗi role
 *    một giá trị, có chứa nháy đơn và các ký tự edge (`% @ : / ? # $ \` \`) để
 *    khoá cả hai lớp escape (SQL quoting trong shell của script provision,
 *    percent-encoding của userinfo DATABASE_URL phía migrate).
 * 2. **Chạy đúng script thật** — text provision/migrate lấy từ chính hàm build
 *    mà `index.ts` dùng (`scripts.ts`), chạy bằng `/bin/sh -c` (cùng hình
 *    interpreter mặc định của provider) với PATH bọc shim `docker` ghi argv và
 *    watcher quét `/proc/<pid>/cmdline` suốt luồng (gồm cả process bên trong
 *    container). PostgreSQL một-shot trên network RIÊNG của suite, tên có hậu
 *    tố ngẫu nhiên — không đụng stack của worktree khác; image ghim cùng digest
 *    với `platform-deploy` (đúng major production).
 * 3. **Assert hai chiều** — không sentinel ở bất kỳ kênh nào (argv log, sweep,
 *    stdout/stderr, script text) VÀ trạng thái database sau provision +
 *    migration vẫn đúng: role/db/owner/grant/revoke/schema, login bằng mật
 *    khẩu sentinel qua host auth scram (`-e PGPASSWORD` chỉ TÊN biến — giá trị
 *    không bao giờ trong argv), wrong password bị từ chối (negative control),
 *    ON_ERROR_STOP dừng SQL hỏng mà không in câu SQL chứa secret.
 *
 * Mọi thông điệp lỗi nêu KÊNH rò rỉ, không bao giờ in giá trị sentinel.
 */
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createArgvHarness, type ArgvHarness, type RunResult } from './argv-harness.ts';
import {
  DATABASES,
  type Database,
  buildMigrateScript,
  buildProvisionScript,
  dbName,
  migratorRole,
  passwordEnvVar,
  runtimeRole,
} from '../../scripts.ts';

/**
 * Image PostgreSQL của suite — GHIM CÙNG DIGEST với `deploys/platform-deploy`
 * (PostgreSQL 17.11 + TimescaleDB): provision của unit chạy trên đúng major
 * production. Ghim lặp lại ở hai unit là có chủ đích (06-testing.md §6: không
 * shared test-support giữa các deploy unit).
 */
const POSTGRES_IMAGE =
  'timescale/timescaledb@sha256:b346edcdb51a1fd6020e3965e0bd1c9f3406fa6d5fbce1e28f4852587ef934e2';

/**
 * Image Node pin của migrate — cùng DIGEST với hằng `NODE_IMAGE` của
 * `index.ts`. Không export từ `index.ts` được (module đó là chương trình Pulumi
 * có side effect ở top-level — import vào test là khởi động Pulumi), nên hai
 * chỗ ghim hai digest là bản sao có chủ đích; đổi digest phải đổi cả hai.
 */
const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

/**
 * Sáu sentinel — dữ liệu giả, mỗi role MỘT giá trị, phủ các edge case escape:
 * nháy đơn (SQL quoting), `%` (percent-encode URL), `@ : / ? #` (delineator
 * userinfo), `$` và backtick (mở rộng shell nếu giá trị bị tái phân tích),
 * backslash (printf/sed).
 */
const SENTINELS: Record<Database, { migrator: string; runtime: string }> = {
  gateway: {
    migrator: `S3nt1n3l-Gw-Mig'x1%`,
    runtime: `S3nt1n3l-Gw-Run'x2$`,
  },
  tenant: {
    migrator: `S3nt1n3l-Tn-Mig'x3@:`,
    runtime: `S3nt1n3l-Tn-Run/x4?`,
  },
  marketplace: {
    migrator: `S3nt1n3l-Mp-Mig'x5\\`,
    runtime: `S3nt1n3l-Mp-Run\`x6#`,
  },
};

const ALL_SENTINELS: ReadonlyArray<{ channel: string; value: string }> = DATABASES.flatMap(
  (target) => [
    { channel: passwordEnvVar(target, 'migrator'), value: SENTINELS[target].migrator },
    { channel: passwordEnvVar(target, 'runtime'), value: SENTINELS[target].runtime },
  ],
);

/**
 * Gốc repo thật — mount `/repo` của script migrate, y hệt production. Bốn lần
 * `dirname` từ `tests/integrations/`: integrations → tests → llm-api-deploy →
 * deploys → gốc repo. Sai một cấp là `/repo` mất subtree `apps/` và workdir
 * `/repo/apps/llm-api` không tồn tại trong container (runc mkdir trên mount
 * `:ro` fail).
 */
const WORKTREE_ROOT = resolve(dirname(dirname(dirname(dirname(import.meta.dirname)))));

/** Một lần chạy script đã ghi nhận; stdout/stderr giữ lại để assert không rò. */
interface RecordedRun {
  readonly name: string;
  readonly result: RunResult;
}

interface LoginCheck {
  readonly role: string;
  readonly database: string;
  readonly result: RunResult;
}

/** Mọi artifact của một lần chạy flow — `it` assert TRÊN artifact, không re-run. */
interface FlowArtifacts {
  readonly provisionScriptText: string;
  readonly migrateScriptTexts: Record<Database, string>;
  readonly provisionRun1: RecordedRun;
  readonly provisionRun2: RecordedRun;
  readonly migrateRuns: Record<Database, RecordedRun>;
  readonly onStopFailure: RecordedRun;
  readonly catalog: Record<string, RunResult>;
  readonly logins: LoginCheck[];
  readonly wrongPassword: RunResult;
  readonly crossRevoke: RunResult;
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
      ...Object.fromEntries(ALL_SENTINELS.map(({ channel, value }) => [channel, value])),
    });
    await created.startPostgres(POSTGRES_IMAGE);

    // --- 1. Provision: script text từ chính hàm build mà index.ts dùng. -----
    const provisionScriptText = buildProvisionScript({
      postgresContainerName: created.containerName,
    });
    const provisionEnv: Record<string, string> = {};
    for (const target of DATABASES) {
      provisionEnv[passwordEnvVar(target, 'migrator')] = SENTINELS[target].migrator;
      provisionEnv[passwordEnvVar(target, 'runtime')] = SENTINELS[target].runtime;
    }
    const provisionRun1: RecordedRun = {
      name: 'provision #1',
      result: await created.runScript(provisionScriptText, provisionEnv),
    };
    if (provisionRun1.result.code !== 0) {
      // Prerequisite hỏng — mọi assert sau vô nghĩa, bỏ flow với lỗi thật.
      throw new Error(
        `provision #1 exited non-zero — stdout:\n${provisionRun1.result.stdout}\nstderr:\n${provisionRun1.result.stderr}`,
      );
    }
    const provisionRun2: RecordedRun = {
      name: 'provision #2 (idempotency)',
      result: await created.runScript(provisionScriptText, provisionEnv),
    };

    // --- 2. Migrate cả BA target — DATABASE_URL ghép y hệt production. -------
    const migrateScriptTexts = {} as Record<Database, string>;
    const migrateRuns = {} as Record<Database, RecordedRun>;
    for (const target of DATABASES) {
      const migrateScriptText = buildMigrateScript({
        networkName: created.networkName,
        worktreeRoot: WORKTREE_ROOT,
        target,
        nodeImage: NODE_IMAGE,
      });
      migrateScriptTexts[target] = migrateScriptText;
      const databaseUrl =
        `postgresql://${migratorRole(target)}:${encodeURIComponent(SENTINELS[target].migrator)}` +
        `@ecoma-postgres:5432/${dbName(target)}`;
      const run: RecordedRun = {
        name: `migrate ${target}`,
        result: await created.runScript(migrateScriptText, { DATABASE_URL: databaseUrl }),
      };
      migrateRuns[target] = run;
      if (run.result.code !== 0) {
        throw new Error(
          `migrate ${target} exited non-zero — stdout:\n${run.result.stdout}\nstderr:\n${run.result.stderr}`,
        );
      }
    }

    // --- 3. Failure semantics: ON_ERROR_STOP dừng SQL hỏng, không in SQL. ----
    // Cùng hình kênh stdin với production (printf builtin → sed qua stdin →
    // docker exec -i psql); SQL cố tình sai và chứa sentinel.
    const badSqlScript = `sql_quote() { printf '%s' "$1" | sed "s/'/''/g"; }
quoted=$(sql_quote "$BAD_PW")
printf '%s\\n' "ALTER ROLE argv_hygiene_missing_role WITH PASSWORD '$quoted';" | docker exec -i ${created.containerName} psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1
`;
    const onStopFailure: RecordedRun = {
      name: 'ON_ERROR_STOP failure probe',
      result: await created.runScript(badSqlScript, { BAD_PW: SENTINELS.gateway.migrator }),
    };

    // --- 4. Canary: chứng minh sweep /proc THẬT SỰ bắt được argv. ------------
    // argv `sh -c` chứa canary trong comment — watcher phải thấy ít nhất một
    // hit (assert ở `it` riêng: thiếu hit là harness hỏng, không phải pass).
    // Window 8s: một vòng quét /proc toàn máy (một readFile mỗi pid) dưới tải
    // CI — nhiều suite chạy song song — có thể vượt xa 0.4s, canary sống ngắn
    // thì thoát khỏi mọi vòng quét (đo được: run 43294456886 đỏ ở 3 package,
    // cùng cơ chế). Window phải trội hơn chu kỳ quét xấu nhất — không tối ưu xuống.
    await created.runScript(`sleep 8 # ${canary}`);

    // --- 5. Thu dữ liệu catalog (qua shim — argv của những call này cũng bị
    //    ghi vào log và bị quét; SQL không chứa secret nào). pg_roles/pg_database
    //    là catalog TOÀN CỤ (chỉ thấy trong database nào cũng được), nhưng
    //    pg_namespace và pg_default_acl là catalog PER-DATABASE — query schema
    //    và ACL phải chạy BÊN TRONG database tương ứng, không phải `postgres`.
    //    Query catalog hỏng là lỗi flow (prerequisite), abort với stderr thật.
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
      `SELECT count(*) FROM pg_roles WHERE rolname LIKE 'ecoma_llm_%'`,
    );
    await psqlAsLocal(
      'dbCount',
      'postgres',
      `SELECT count(*) FROM pg_database WHERE datname LIKE 'db-llm-%'`,
    );
    for (const target of DATABASES) {
      await psqlAsLocal(
        `owner:${target}`,
        'postgres',
        `SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='${dbName(target)}'`,
      );
    }
    await psqlAsLocal(
      'grantMatrix',
      'postgres',
      [
        `SELECT has_database_privilege('${migratorRole('gateway')}','${dbName('gateway')}','CREATE')`,
        `AND has_database_privilege('${migratorRole('gateway')}','${dbName('gateway')}','TEMPORARY')`,
        `AND has_database_privilege('${runtimeRole('gateway')}','${dbName('gateway')}','CONNECT')`,
        // 'public' chữ thường: has_database_privilege resolve TÊN role literal,
        // pseudo-role PUBLIC chỉ tồn tại dưới tên 'public' (GRANT/REVOKE syntax
        // mới nhận 'PUBLIC' — không áp dụng cho catalog function).
        `AND NOT has_database_privilege('public','${dbName('gateway')}','CONNECT')`,
        `AND NOT has_database_privilege('${runtimeRole('gateway')}','${dbName('tenant')}','CONNECT')`,
      ].join(' '),
    );
    await psqlAsLocal(
      'gatewaySchemas',
      dbName('gateway'),
      `SELECT count(*) FROM pg_namespace WHERE nspname IN ('llm_financial','llm_seller')`,
    );
    await psqlAsLocal(
      'tenantSchemas',
      dbName('tenant'),
      `SELECT count(*) FROM pg_namespace WHERE nspname = 'llm_tenant'`,
    );
    await psqlAsLocal(
      'marketplaceDefaultAcl',
      dbName('marketplace'),
      `SELECT count(*) FROM pg_default_acl d JOIN pg_roles r ON r.oid = d.defaclrole` +
        ` WHERE r.rolname = '${migratorRole('marketplace')}'`,
    );

    // --- 6. Login bằng sentinel (password verify THẬT qua scram). pg_hba của
    //    image: các dòng loopback trust của initdb đứng TRƯỚC, entrypoint chỉ
    //    APPEND `host all all all scram-sha-256` (first-match wins) — nối
    //    127.0.0.1 là trust và password không bao giờ được kiểm. Nên mỗi login
    //    nối tới IP eth0 của container (resolve trước bằng docker inspect, giá
    //    trị không phải secret) để rơi vào dòng scram. PGPASSWORD đi bằng env
    //    (docker exec -e chỉ mang TÊN biến — giá trị không bao giờ trong argv);
    //    đúng đường mà migrate đi qua network nội bộ cũng là scram.
    const pgAddressRun = await created.runScript(
      `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${created.containerName}`,
    );
    if (pgAddressRun.code !== 0 || pgAddressRun.stdout.trim() === '') {
      throw new Error(
        `could not resolve postgres container address — stdout:\n${pgAddressRun.stdout}\nstderr:\n${pgAddressRun.stderr}`,
      );
    }
    const pgAddress = pgAddressRun.stdout.trim();
    const logins: LoginCheck[] = [];
    for (const target of DATABASES) {
      const roles = [
        { role: migratorRole(target), kind: 'migrator' as const },
        { role: runtimeRole(target), kind: 'runtime' as const },
      ];
      for (const { role, kind } of roles) {
        logins.push({
          role,
          database: dbName(target),
          result: await created.runScript(
            `docker exec -e PGPASSWORD ${created.containerName} psql -h ${pgAddress} -U ${role} -d ${dbName(target)} -tAc 'SELECT current_user'`,
            { PGPASSWORD: SENTINELS[target][kind] },
          ),
        });
      }
    }
    // Negative control: sai mật khẩu phải bị từ chối ở dòng scram — chứng minh
    // các login check phía trên đi qua đường verify thật (không phải trust).
    const wrongPassword = await created.runScript(
      `docker exec -e PGPASSWORD ${created.containerName} psql -h ${pgAddress} -U ${migratorRole('gateway')} -d ${dbName('gateway')} -tAc 'SELECT 1'`,
      { PGPASSWORD: 'definitely-not-the-sentinel-password' },
    );
    // Cross-revoke: runtime gateway không CONNECT được db-llm-tenant (socket
    // trust — server vẫn kiểm CONNECT privilege sau auth).
    const crossRevoke = await created.runScript(
      `docker exec ${created.containerName} psql -U ${runtimeRole('gateway')} -d ${dbName('tenant')} -tAc 'SELECT 1'`,
    );

    flow = {
      provisionScriptText,
      migrateScriptTexts,
      provisionRun1,
      provisionRun2,
      migrateRuns,
      onStopFailure,
      catalog,
      logins,
      wrongPassword,
      crossRevoke,
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
    ...DATABASES.map((target) => flowState.migrateRuns[target]),
    flowState.onStopFailure,
    ...flowState.logins.map((login) => ({
      name: `login ${login.role}`,
      result: login.result,
    })),
    { name: 'wrong password control', result: flowState.wrongPassword },
    { name: 'cross revoke', result: flowState.crossRevoke },
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
    // lẫn `docker run` (migrate) — log rỗng là harness hỏng, không phải pass.
    expect(flowState.argvLog.includes(Buffer.from('ON_ERROR_STOP', 'utf8'))).toBe(true);
    expect(flowState.argvLog.includes(Buffer.from('--network', 'utf8'))).toBe(true);
    for (const { channel, value } of ALL_SENTINELS) {
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
    for (const { channel, value } of ALL_SENTINELS) {
      expect(
        captured.includes(Buffer.from(value, 'utf8')),
        `sentinel ${channel} found in captured command output`,
      ).toBe(false);
    }
  });

  it('rendered script texts carry none of the sentinels', () => {
    const flowState = requireFlow();
    const texts = [
      flowState.provisionScriptText,
      ...DATABASES.map((target) => flowState.migrateScriptTexts[target]),
    ];
    for (const text of texts) {
      for (const { channel, value } of ALL_SENTINELS) {
        expect(text.includes(value), `sentinel ${channel} found in rendered script text`).toBe(
          false,
        );
      }
    }
  });

  it('ON_ERROR_STOP aborts bad SQL without echoing the secret-bearing statement', () => {
    const flowState = requireFlow();
    const { result } = flowState.onStopFailure;
    expect(result.code).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output.includes(SENTINELS.gateway.migrator)).toBe(false);
    // Câu SQL hỏng không được in lại vào output (psql chỉ in ERROR của server).
    expect(output.includes('WITH PASSWORD')).toBe(false);
  });

  it('provision is idempotent: the second run exits zero without rotation', () => {
    const flowState = requireFlow();
    expect(flowState.provisionRun1.result.code).toBe(0);
    expect(flowState.provisionRun2.result.code).toBe(0);
    // Chạy lần hai phải áp CÙNG giá trị (không rotate): login bằng sentinel
    // gốc sau hai lần provision vẫn thành công — assert ở `it` login dưới.
  });

  it('migrations applied on all three databases through the canonical runner', () => {
    const flowState = requireFlow();
    for (const target of DATABASES) {
      const { result } = flowState.migrateRuns[target];
      expect(result.code).toBe(0);
      // stdout của `db/apply.mts`: "applied <file>" + "done N file(s) applied".
      expect(result.stdout).toContain('file(s) applied');
    }
    // Trạng thái schema sau migration: gateway 2 schema, tenant 1 schema,
    // marketplace default-privilege ACL (không schema nghiệp vụ trong slice này).
    expect(flowState.catalog.gatewaySchemas?.stdout.trim()).toBe('2');
    expect(flowState.catalog.tenantSchemas?.stdout.trim()).toBe('1');
    // Default ACL của migrator (kênh cấp DML tương lai cho runtime): invariant
    // là ÍT NHẤT MỘT ACL do migrator sở hữu trong database. Số dòng chính xác
    // (per object-type, per schema) là chi tiết nội dung migration — thuộc slice
    // db-migration, không ghim cứng ở đây để hai suite không khoá nhau.
    expect(
      Number(flowState.catalog.marketplaceDefaultAcl?.stdout.trim()),
      'marketplace default ACL owned by migrator missing',
    ).toBeGreaterThanOrEqual(1);
  });

  it('provisioned the six roles, three databases, ownership and grant matrix', () => {
    const flowState = requireFlow();
    expect(flowState.catalog.roleCount?.stdout.trim()).toBe('6');
    expect(flowState.catalog.dbCount?.stdout.trim()).toBe('3');
    for (const target of DATABASES) {
      expect(flowState.catalog[`owner:${target}`]?.stdout.trim()).toBe('ecoma_owner');
    }
    expect(flowState.catalog.grantMatrix?.stdout.trim()).toBe('t');
    // Cross-revoke thực thi thật: connect bằng runtime gateway vào db tenant bị
    // server từ chối ở tầng CONNECT privilege.
    expect(flowState.crossRevoke.code).not.toBe(0);
  });

  it('every role logs in with its sentinel password through host auth', () => {
    const flowState = requireFlow();
    for (const login of flowState.logins) {
      expect(login.result.code, `login ${login.role} exited non-zero`).toBe(0);
      expect(login.result.stdout.trim(), `login ${login.role} wrong current_user`).toBe(login.role);
    }
    // Negative control: sai mật khẩu bị từ chối — login check ở trên đi qua
    // đường verify thật chứ không phải trust auth.
    expect(flowState.wrongPassword.code).not.toBe(0);
  });
});
