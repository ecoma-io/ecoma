/**
 * Suite argv-hygiene của `account-deploy` (target `test-integration`) — bằng
 * chứng tự động cho bất biến bảo mật của unit: **không giá trị secret nào vào
 * argv của process host, vào script text, vào output bắt được** trong lúc
 * provision và migrate chạy THẬT; đồng thời provision đúng (4 role, grant,
 * revoke chéo, hardening), migrate nối đúng database, và rotation + idempotency
 * giữ nguyên hành vi.
 *
 * Thiết kế (06-testing.md §2/§4 — app-owned suite, Docker là phụ thuộc cứng,
 * vắng Docker là suite ĐỎ theo §6):
 *
 * 1. **Sentinel giả** — bốn mật khẩu tổng hợp, KHÔNG phải secret thật, mỗi role
 *    một giá trị, phủ các ký tự edge (nháy đơn/nháy kép, backslash, `$`,
 *    backtick, `;`, khoảng trắng, unicode) để khoá escaping SQL trên đường
 *    STDIN. Sentinel của migrator tránh `% @ : / ? #` vì production GHÉP URL
 *    TRẦN (không percent-encode) — suite chạy đúng hình production.
 * 2. **Chạy đúng script thật** — text provision/migrate lấy từ chính hàm build
 *    mà `index.ts` dùng (`scripts.ts`), chạy bằng `/bin/sh -c` (cùng hình
 *    interpreter mặc định của provider) với PATH bọc shim `docker` ghi argv và
 *    watcher quét `/proc/<pid>/cmdline` suốt luồng (gồm cả process bên trong
 *    container). PostgreSQL một-shot trên network RIÊNG của suite, tên có hậu
 *    tố ngẫu nhiên — không đụng stack của worktree khác; image ghim cùng digest
 *    với `platform-deploy` (đúng major production).
 * 3. **Rotation thật** — provision chạy lần BA với bộ sentinel ĐỔI: login bằng
 *    mật khẩu mới phải thành công và bằng mật khẩu cũ phải bị từ chối — chứng
 *    minh ALTER áp giá trị mới (rotation đúng) chứ không chỉ idempotent.
 * 4. **Assert hai chiều** — không sentinel ở bất kỳ kênh nào (argv log, sweep,
 *    stdout/stderr, script text) VÀ trạng thái database sau provision +
 *    migration vẫn đúng: role/db/owner/grant/schema, login bằng mật khẩu
 *    sentinel qua host auth scram (`-e PGPASSWORD` chỉ TÊN biến — giá trị
 *    không bao giờ trong argv), ON_ERROR_STOP dừng SQL hỏng mà không in câu SQL
 *    chứa secret.
 *
 * Mọi thông điệp lỗi nêu KÊNH rò rỉ, không bao giờ in giá trị sentinel.
 */
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createArgvHarness, type ArgvHarness, type RunResult } from './argv-harness.ts';
import {
  MIGRATOR_PASSWORD_ENV_VAR,
  OWNER_PASSWORD_ENV_VAR,
  PRUNER_PASSWORD_ENV_VAR,
  RUNTIME_PASSWORD_ENV_VAR,
  buildMigrateScript,
  buildProvisionScript,
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

/** Alias DNS của PostgreSQL platform trong network nội bộ — cùng hằng index.ts. */
const POSTGRES_HOST = 'ecoma-postgres';

/**
 * Bốn sentinel — dữ liệu giả, mỗi role MỘT giá trị, phủ các edge case escape
 * của đường STDIN: nháy đơn (SQL quoting), nháy kép, backslash (literal dưới
 * standard_conforming_strings), `$` và backtick (mở rộng shell nếu giá trị bị
 * tái phân tích), `;`, khoảng trắng, unicode. Sentinel migrator TRÁNH
 * `% @ : / ? #` vì production ghép URL trần (không percent-encode) — suite
 * dựng DATABASE_URL y hệt hình đó.
 */
const SENTINELS = {
  [OWNER_PASSWORD_ENV_VAR]: `S3nt1n3l-Ac-Own'x1$`,
  [MIGRATOR_PASSWORD_ENV_VAR]: `S3nt1n3l-Ac-Mig'x2;â`,
  [RUNTIME_PASSWORD_ENV_VAR]: `S3nt1n3l-Ac-Run\`x3\\ bâ;`,
  [PRUNER_PASSWORD_ENV_VAR]: `S3nt1n3l-Ac-Prn'x4"x4;â\\`,
} as const;

/** Bộ sentinel SAU rotation — chỉ đổi segment `x` thành `y`, giữ nguyên bảng ký tự. */
const ROTATED_SENTINELS = Object.fromEntries(
  Object.entries(SENTINELS).map(([channel, value]) => [channel, value.replaceAll('x', 'y')]),
) as Record<string, string>;

const ALL_CHANNELS = Object.keys(SENTINELS) as Array<keyof typeof SENTINELS>;

const ALL_SENTINELS: ReadonlyArray<{ channel: string; value: string }> = ALL_CHANNELS.map(
  (channel) => ({ channel, value: SENTINELS[channel] }),
);

const ALL_ROTATED: ReadonlyArray<{ channel: string; value: string }> = ALL_CHANNELS.map(
  (channel) => ({ channel, value: ROTATED_SENTINELS[channel] }),
);

/**
 * Gốc repo thật — mount `/repo` của script migrate, y hệt production. Bốn lần
 * `dirname` từ `tests/integrations/`: integrations → tests → account-deploy →
 * deploys → gốc repo. Sai một cấp là `/repo` mất subtree `apps/` và workdir
 * `/repo/apps/account` không tồn tại trong container (runc mkdir trên mount
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
  readonly migrateScriptText: string;
  readonly provisionRun1: RecordedRun;
  readonly provisionRun2: RecordedRun;
  readonly provisionRun3Rotated: RecordedRun;
  readonly migrateRun: RecordedRun;
  readonly onStopFailure: RecordedRun;
  readonly catalog: Record<string, RunResult>;
  readonly logins: LoginCheck[];
  readonly oldPasswordLogin: RunResult;
  readonly wrongPassword: RunResult;
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
    // Pattern gồm CẢ hai bộ sentinel: rotation xảy ra GIỮA luồng, giá trị cũ
    // phải biến mất hoàn toàn khỏi mọi kênh argv sau khi đã rotate.
    await created.startWatcher({
      canary,
      ...Object.fromEntries(ALL_SENTINELS.map(({ channel, value }) => [channel, value])),
      ...Object.fromEntries(ALL_ROTATED.map(({ channel, value }) => [channel, value])),
    });
    await created.startPostgres(POSTGRES_IMAGE);

    // --- 1. Provision: script text từ chính hàm build mà index.ts dùng. -----
    const provisionScriptText = buildProvisionScript({
      postgresContainerName: created.containerName,
    });
    const provisionEnv = (): Record<string, string> => ({ ...SENTINELS });
    const provisionRun1: RecordedRun = {
      name: 'provision #1 (create)',
      result: await created.runScript(provisionScriptText, provisionEnv()),
    };
    if (provisionRun1.result.code !== 0) {
      // Prerequisite hỏng — mọi assert sau vô nghĩa, bỏ flow với lỗi thật.
      throw new Error(
        `provision #1 exited non-zero — stdout:\n${provisionRun1.result.stdout}\nstderr:\n${provisionRun1.result.stderr}`,
      );
    }
    const provisionRun2: RecordedRun = {
      name: 'provision #2 (idempotency)',
      result: await created.runScript(provisionScriptText, provisionEnv()),
    };
    if (provisionRun2.result.code !== 0) {
      throw new Error(
        `provision #2 (idempotency) exited non-zero — stdout:\n${provisionRun2.result.stdout}\nstderr:\n${provisionRun2.result.stderr}`,
      );
    }
    // --- 1b. Rotation: lần BA với bộ giá trị ĐỔI — ALTER phải áp giá trị mới.
    const provisionRun3Rotated: RecordedRun = {
      name: 'provision #3 (rotation)',
      result: await created.runScript(provisionScriptText, { ...ROTATED_SENTINELS }),
    };
    if (provisionRun3Rotated.result.code !== 0) {
      throw new Error(
        `provision #3 (rotation) exited non-zero — stdout:\n${provisionRun3Rotated.result.stdout}\nstderr:\n${provisionRun3Rotated.result.stderr}`,
      );
    }

    // --- 2. Migrate — DATABASE_URL ghép y hệt production (URL trần, không
    //    percent-encode) với mật khẩu migrator SAU rotation.
    const migrateScriptText = buildMigrateScript({
      networkName: created.networkName,
      worktreeRoot: WORKTREE_ROOT,
      nodeImage: NODE_IMAGE,
    });
    const databaseUrl = `postgresql://ecoma_account_migrator:${ROTATED_SENTINELS[MIGRATOR_PASSWORD_ENV_VAR]}@${POSTGRES_HOST}:5432/db-account`;
    const migrateRun: RecordedRun = {
      name: 'migrate db-account',
      result: await created.runScript(migrateScriptText, { DATABASE_URL: databaseUrl }),
    };
    if (migrateRun.result.code !== 0) {
      throw new Error(
        `migrate exited non-zero — stdout:\n${migrateRun.result.stdout}\nstderr:\n${migrateRun.result.stderr}`,
      );
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
      result: await created.runScript(badSqlScript, {
        BAD_PW: ROTATED_SENTINELS[OWNER_PASSWORD_ENV_VAR],
      }),
    };

    // --- 4. Canary: chứng minh sweep /proc THẬT SỰ bắt được argv. ------------
    // argv `sh -c` chứa canary trong comment — watcher phải thấy ít nhất một
    // hit (assert ở `it` riêng: thiếu hit là harness hỏng, không phải pass).
    await created.runScript(`sleep 0.4 # ${canary}`);

    // --- 5. Thu dữ liệu catalog (qua shim — argv của những call này cũng bị
    //    ghi vào log và bị quét; SQL không chứa secret nào). Query catalog hỏng
    //    là lỗi flow (prerequisite), abort với stderr thật.
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
      `SELECT count(*) FROM pg_roles WHERE rolname LIKE 'ecoma_account_%'`,
    );
    await psqlAsLocal(
      'ownerExists',
      'postgres',
      `SELECT count(*) FROM pg_roles WHERE rolname='ecoma_owner'`,
    );
    await psqlAsLocal(
      'dbOwner',
      'postgres',
      `SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='db-account'`,
    );
    await psqlAsLocal(
      'grantMatrix',
      'postgres',
      [
        `SELECT has_database_privilege('ecoma_account_migrator','db-account','CREATE')`,
        `AND has_database_privilege('ecoma_account_migrator','db-account','TEMPORARY')`,
        `AND has_database_privilege('ecoma_account_runtime','db-account','CONNECT')`,
        `AND has_database_privilege('ecoma_account_nonce_pruner','db-account','CONNECT')`,
        // 'public' chữ thường: has_database_privilege resolve TÊN role literal,
        // pseudo-role PUBLIC chỉ tồn tại dưới tên 'public' (GRANT/REVOKE syntax
        // mới nhận 'PUBLIC' — không áp dụng cho catalog function).
        `AND NOT has_database_privilege('public','db-account','CONNECT')`,
      ].join(' '),
    );
    await psqlAsLocal(
      'accountSchema',
      'db-account',
      `SELECT count(*) FROM pg_namespace WHERE nspname = 'account'`,
    );
    await psqlAsLocal(
      'accountTables',
      'db-account',
      `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace` +
        ` WHERE n.nspname = 'account' AND c.relkind IN ('r', 'p')`,
    );

    // --- 6. Login bằng sentinel SAU rotation (password verify THẬT qua scram).
    //    pg_hba của image: các dòng loopback trust của initdb đứng TRƯỚC,
    //    entrypoint chỉ APPEND `host all all all scram-sha-256` (first-match
    //    wins) — nối 127.0.0.1 là trust và password không bao giờ được kiểm.
    //    Nên mỗi login nối tới IP eth0 của container (resolve trước bằng docker
    //    inspect, giá trị không phải secret) để rơi vào dòng scram. PGPASSWORD
    //    đi bằng env (docker exec -e chỉ mang TÊN biến — giá trị không bao giờ
    //    trong argv).
    const pgAddressRun = await created.runScript(
      `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${created.containerName}`,
    );
    if (pgAddressRun.code !== 0 || pgAddressRun.stdout.trim() === '') {
      throw new Error(
        `could not resolve postgres container address — stdout:\n${pgAddressRun.stdout}\nstderr:\n${pgAddressRun.stderr}`,
      );
    }
    const pgAddress = pgAddressRun.stdout.trim();
    const roleEnvVarPairs: ReadonlyArray<readonly [string, string]> = [
      ['ecoma_owner', OWNER_PASSWORD_ENV_VAR],
      ['ecoma_account_migrator', MIGRATOR_PASSWORD_ENV_VAR],
      ['ecoma_account_runtime', RUNTIME_PASSWORD_ENV_VAR],
      ['ecoma_account_nonce_pruner', PRUNER_PASSWORD_ENV_VAR],
    ];
    const logins: LoginCheck[] = [];
    for (const [role, channel] of roleEnvVarPairs) {
      logins.push({
        role,
        database: 'db-account',
        result: await created.runScript(
          `docker exec -e PGPASSWORD ${created.containerName} psql -h ${pgAddress} -U ${role} -d db-account -tAc 'SELECT current_user'`,
          { PGPASSWORD: ROTATED_SENTINELS[channel] },
        ),
      });
    }
    // Rotation negative control: mật khẩu CŨ (trước rotation) phải bị từ chối —
    // chứng minh ALTER áp giá trị mới thật, không phải chạy lại vô hiệu.
    const oldPasswordLogin = await created.runScript(
      `docker exec -e PGPASSWORD ${created.containerName} psql -h ${pgAddress} -U ecoma_account_migrator -d db-account -tAc 'SELECT 1'`,
      { PGPASSWORD: SENTINELS[MIGRATOR_PASSWORD_ENV_VAR] },
    );
    // Wrong password control: sai mật khẩu cũng bị từ chối ở dòng scram —
    // chứng minh các login check phía trên đi qua đường verify thật.
    const wrongPassword = await created.runScript(
      `docker exec -e PGPASSWORD ${created.containerName} psql -h ${pgAddress} -U ecoma_account_migrator -d db-account -tAc 'SELECT 1'`,
      { PGPASSWORD: 'definitely-not-the-sentinel-password' },
    );

    flow = {
      provisionScriptText,
      migrateScriptText,
      provisionRun1,
      provisionRun2,
      provisionRun3Rotated,
      migrateRun,
      onStopFailure,
      catalog,
      logins,
      oldPasswordLogin,
      wrongPassword,
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
    for (const { channel, value } of [...ALL_SENTINELS, ...ALL_ROTATED]) {
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
    const runs: RecordedRun[] = [
      flowState.provisionRun1,
      flowState.provisionRun2,
      flowState.provisionRun3Rotated,
      flowState.migrateRun,
      flowState.onStopFailure,
      ...flowState.logins.map((login) => ({
        name: `login ${login.role}`,
        result: login.result,
      })),
      { name: 'old password control', result: flowState.oldPasswordLogin },
      { name: 'wrong password control', result: flowState.wrongPassword },
      ...Object.entries(flowState.catalog).map(([key, result]) => ({
        name: `catalog ${key}`,
        result,
      })),
    ];
    const captured = Buffer.from(
      runs.map((run) => `${run.result.stdout}\n${run.result.stderr}`).join('\n'),
      'utf8',
    );
    for (const { channel, value } of [...ALL_SENTINELS, ...ALL_ROTATED]) {
      expect(
        captured.includes(Buffer.from(value, 'utf8')),
        `sentinel ${channel} found in captured command output`,
      ).toBe(false);
    }
  });

  it('rendered script texts carry none of the sentinels', () => {
    const flowState = requireFlow();
    for (const text of [flowState.provisionScriptText, flowState.migrateScriptText]) {
      for (const { channel, value } of [...ALL_SENTINELS, ...ALL_ROTATED]) {
        expect(text.includes(value), `sentinel ${channel} found in rendered script text`).toBe(
          false,
        );
      }
    }
    // Script migrate chỉ mang TÊN biến `DATABASE_URL` trong argv của docker run.
    expect(flowState.migrateScriptText).toContain('-e DATABASE_URL \\');
    expect(flowState.migrateScriptText).not.toContain('DATABASE_URL=postgresql://');
  });

  it('ON_ERROR_STOP aborts bad SQL without echoing the secret-bearing statement', () => {
    const flowState = requireFlow();
    const { result } = flowState.onStopFailure;
    expect(result.code).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output.includes(ROTATED_SENTINELS[OWNER_PASSWORD_ENV_VAR])).toBe(false);
    // Câu SQL hỏng không được in lại vào output (psql chỉ in ERROR của server).
    expect(output.includes('WITH PASSWORD')).toBe(false);
  });
});

describe('provision state: create, rotation and idempotency', () => {
  it('provision create, idempotent re-run and rotation all exit zero', () => {
    const flowState = requireFlow();
    expect(flowState.provisionRun1.result.code).toBe(0);
    expect(flowState.provisionRun2.result.code).toBe(0);
    expect(flowState.provisionRun3Rotated.result.code).toBe(0);
  });

  it('created the owner plus the three db-account roles', () => {
    const flowState = requireFlow();
    expect(flowState.catalog.ownerExists?.stdout.trim()).toBe('1');
    expect(flowState.catalog.roleCount?.stdout.trim()).toBe('3');
  });

  it('db-account is owned by ecoma_owner with the documented grant matrix', () => {
    const flowState = requireFlow();
    expect(flowState.catalog.dbOwner?.stdout.trim()).toBe('ecoma_owner');
    expect(flowState.catalog.grantMatrix?.stdout.trim()).toBe('t');
  });

  it('login succeeds with the rotated password for every role (real scram verify)', () => {
    const flowState = requireFlow();
    for (const login of flowState.logins) {
      expect(login.result.code, `login ${login.role} exited non-zero`).toBe(0);
      expect(login.result.stdout.trim(), `login ${login.role} wrong identity`).toBe(login.role);
    }
  });

  it('login with the pre-rotation password is rejected (rotation really applied)', () => {
    const flowState = requireFlow();
    expect(flowState.oldPasswordLogin.code).not.toBe(0);
  });

  it('login with a wrong password is rejected (logins above went through real verification)', () => {
    const flowState = requireFlow();
    expect(flowState.wrongPassword.code).not.toBe(0);
  });
});

describe('migration state: connected to the right database through the canonical runner', () => {
  it('migration applied on db-account and the schema is present there', () => {
    const flowState = requireFlow();
    expect(flowState.migrateRun.result.code).toBe(0);
    // stdout của `db/apply.mts`: "applied <file>" + "done N file(s) applied; ...".
    expect(flowState.migrateRun.result.stdout).toContain('file(s) applied');
    expect(flowState.catalog.accountSchema?.stdout.trim()).toBe('1');
  });

  it('migration produced tables inside db-account', () => {
    const flowState = requireFlow();
    const tables = Number(flowState.catalog.accountTables?.stdout.trim() ?? '0');
    expect(Number.isNaN(tables)).toBe(false);
    expect(tables).toBeGreaterThan(0);
  });
});
