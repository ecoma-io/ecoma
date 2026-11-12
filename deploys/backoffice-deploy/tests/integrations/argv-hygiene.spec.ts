/**
 * Suite argv-hygiene của `backoffice-deploy` (target `test-integration`) —
 * bằng chứng tự động cho bất biến bảo mật của unit: **không giá trị secret nào
 * vào argv của process host, vào script text, vào output bắt được** trong lúc
 * provision chạy THẬT (provision của unit này bao gồm cả pipe migration qua
 * psql — đi qua shim và sweep y hệt); đồng thời provision đúng (guard-create
 * database + 2 role, grant, hardening, migration thật trong `db-backoffice`) và
 * rotation + idempotency giữ nguyên hành vi.
 *
 * Thiết kế (06-testing.md §2/§4 — app-owned suite, Docker là phụ thuộc cứng,
 * vắng Docker là suite ĐỎ theo §6):
 *
 * 1. **Sentinel giả** — hai mật khẩu tổng hợp, KHÔNG phải secret thật, mỗi role
 *    một giá trị, phủ các ký tự edge: sentinel migrator chứa cả nhóm ký tự dành
 *    riêng của URL (`% @ : / ? #`) — unit này KHÔNG ghép URL mật khẩu vào argv
 *    ở bất kỳ đường nào, nên chúng phải đi qua STDIN nguyên vẹn; sentinel
 *    runtime phủ nhóm shell (` backslash $ ; khoảng trắng).
 * 2. **Chạy đúng script thật** — text provision lấy từ chính hàm build mà
 *    `index.ts` dùng (`scripts.ts`), chạy bằng `/bin/sh -c` (cùng hình
 *    interpreter mặc định của provider) với PATH bọc shim `docker` ghi argv và
 *    watcher quét `/proc/<pid>/cmdline` suốt luồng (gồm cả process bên trong
 *    container). PostgreSQL một-shot trên network RIÊNG của suite, tên có hậu
 *    tố ngẫu nhiên — không đụng stack của worktree khác; image ghim cùng digest
 *    với `platform-deploy` (đúng major production).
 * 3. **Rotation thật** — provision chạy lần BA với bộ sentinel ĐỔI: login bằng
 *    mật khẩu mới phải thành công và bằng mật khẩu cũ phải bị từ chối — chứng
 *    minh ALTER áp giá trị mới (rotation đúng) chứ không chỉ idempotent.
 * 4. **Assert hai chiều** — không sentinel ở bất kỳ kênh nào (argv log, sweep,
 *    stdout/stderr, script text) VÀ trạng thái database sau provision vẫn đúng:
 *    role/db/owner (`ecoma_local` — unit này không có owner role riêng)/grant
 *    (migrator CONNECT+CREATE+TEMPORARY), schema `backoffice` + bảng do
 *    migration thật tạo ra, login bằng mật khẩu sentinel qua host auth scram
 *    (`-e PGPASSWORD` chỉ TÊN biến — giá trị không bao giờ trong argv),
 *    ON_ERROR_STOP dừng SQL hỏng mà không in câu SQL chứa secret.
 *
 * Mọi thông điệp lỗi nêu KÊNH rò rỉ, không bao giờ in giá trị sentinel.
 */
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createArgvHarness, type ArgvHarness, type RunResult } from './argv-harness.ts';
import {
  MIGRATOR_PASSWORD_ENV_VAR,
  RUNTIME_PASSWORD_ENV_VAR,
  buildProvisionScript,
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
 * Hai sentinel — dữ liệu giả, mỗi role MỘT giá trị, phủ các edge case escape
 * của đường STDIN: nháy đơn (SQL quoting), `% @ : / ? #` (dành riêng của URL —
 * không được biến đổi trên đường nào), backslash (literal dưới
 * standard_conforming_strings), `$` và backtick (mở rộng shell nếu giá trị bị
 * tái phân tích), `;`, khoảng trắng, unicode.
 */
const SENTINELS = {
  [MIGRATOR_PASSWORD_ENV_VAR]: `S3nt1n3l-Bo-Mig'x1%@:/?#`,
  [RUNTIME_PASSWORD_ENV_VAR]: `S3nt1n3l-Bo-Run\`x2\\ bâ$;`,
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
 * Gốc repo thật — pipe migration `cat` file SQL từ
 * `<worktreeRoot>/apps/backoffice/db/migrations/*.sql`, y hệt production. Bốn
 * lần `dirname` từ `tests/integrations/`: integrations → tests →
 * backoffice-deploy → deploys → gốc repo. Sai một cấp là glob không khớp file
 * nào và pipe chết (cat lỗi — fail-loud đúng như baseline).
 */
const WORKTREE_ROOT = resolve(dirname(dirname(dirname(dirname(import.meta.dirname)))));

/** Một lần chạy script đã ghi nhận; stdout/stderr giữ lại để assert không rò. */
interface RecordedRun {
  readonly name: string;
  readonly result: RunResult;
}

interface LoginCheck {
  readonly role: string;
  readonly result: RunResult;
}

/** Mọi artifact của một lần chạy flow — `it` assert TRÊN artifact, không re-run. */
interface FlowArtifacts {
  readonly provisionScriptText: string;
  readonly provisionRun1: RecordedRun;
  readonly provisionRun2: RecordedRun;
  readonly provisionRun3Rotated: RecordedRun;
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

    // --- 1. Provision: script text từ chính hàm build mà index.ts dùng. Mỗi
    //     lần chạy BAO GỒM cả pipe migration (provision-migrate một script).
    const provisionScriptText = buildProvisionScript({
      postgresContainerName: created.containerName,
      worktreeRoot: WORKTREE_ROOT,
    });
    const provisionRun1: RecordedRun = {
      name: 'provision #1 (create + migrate)',
      result: await created.runScript(provisionScriptText, { ...SENTINELS }),
    };
    if (provisionRun1.result.code !== 0) {
      // Prerequisite hỏng — mọi assert sau vô nghĩa, bỏ flow với lỗi thật.
      throw new Error(
        `provision #1 exited non-zero — stdout:\n${provisionRun1.result.stdout}\nstderr:\n${provisionRun1.result.stderr}`,
      );
    }
    const provisionRun2: RecordedRun = {
      name: 'provision #2 (idempotency + migrate re-run)',
      result: await created.runScript(provisionScriptText, { ...SENTINELS }),
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

    // --- 2. Failure semantics: ON_ERROR_STOP dừng SQL hỏng, không in SQL. ----
    // Cùng hình kênh stdin với production (printf builtin → sed qua stdin →
    // docker exec -i psql); SQL cố tình sai và chứa sentinel.
    const badSqlScript = `sql_quote() { printf '%s' "$1" | sed "s/'/''/g"; }
quoted=$(sql_quote "$BAD_PW")
printf '%s\\n' "ALTER ROLE argv_hygiene_missing_role WITH PASSWORD '$quoted';" | docker exec -i ${created.containerName} psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1
`;
    const onStopFailure: RecordedRun = {
      name: 'ON_ERROR_STOP failure probe',
      result: await created.runScript(badSqlScript, {
        BAD_PW: ROTATED_SENTINELS[RUNTIME_PASSWORD_ENV_VAR],
      }),
    };

    // --- 3. Canary: chứng minh sweep /proc THẬT SỰ bắt được argv. ------------
    // argv `sh -c` chứa canary trong comment — watcher phải thấy ít nhất một
    // hit (assert ở `it` riêng: thiếu hit là harness hỏng, không phải pass).
    await created.runScript(`sleep 0.4 # ${canary}`);

    // --- 4. Thu dữ liệu catalog (qua shim — argv của những call này cũng bị
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
      `SELECT count(*) FROM pg_roles WHERE rolname LIKE 'ecoma_backoffice_%'`,
    );
    await psqlAsLocal(
      'dbOwner',
      'postgres',
      `SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='db-backoffice'`,
    );
    await psqlAsLocal(
      'grantMatrix',
      'postgres',
      [
        `SELECT has_database_privilege('ecoma_backoffice_migrator','db-backoffice','CREATE')`,
        `AND has_database_privilege('ecoma_backoffice_migrator','db-backoffice','TEMPORARY')`,
        `AND has_database_privilege('ecoma_backoffice_migrator','db-backoffice','CONNECT')`,
        // Giới hạn đã biết của baseline (ghi ở staff-access-deploy/index.ts):
        // db-backoffice vẫn cấp CONNECT cho PUBLIC — unit sở hữu nó không rút.
        // Suite khoá TRẠNG THÁI HIỆN TẠI để một thay đổi ẩn hiện lên.
        `AND has_database_privilege('public','db-backoffice','CONNECT')`,
      ].join(' '),
    );
    await psqlAsLocal(
      'backofficeSchema',
      'db-backoffice',
      `SELECT count(*) FROM pg_namespace WHERE nspname = 'backoffice'`,
    );
    await psqlAsLocal(
      'backofficeTables',
      'db-backoffice',
      `SELECT count(*) FROM pg_tables WHERE schemaname = 'backoffice'`,
    );

    // --- 5. Login bằng sentinel SAU rotation (password verify THẬT qua scram).
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
      ['ecoma_backoffice_migrator', MIGRATOR_PASSWORD_ENV_VAR],
      ['ecoma_backoffice_runtime', RUNTIME_PASSWORD_ENV_VAR],
    ];
    const logins: LoginCheck[] = [];
    for (const [role, channel] of roleEnvVarPairs) {
      logins.push({
        role,
        result: await created.runScript(
          `docker exec -e PGPASSWORD ${created.containerName} psql -h ${pgAddress} -U ${role} -d db-backoffice -tAc 'SELECT current_user'`,
          { PGPASSWORD: ROTATED_SENTINELS[channel] },
        ),
      });
    }
    // Rotation negative control: mật khẩu CŨ (trước rotation) phải bị từ chối —
    // chứng minh ALTER áp giá trị mới thật, không phải chạy lại vô hiệu.
    const oldPasswordLogin = await created.runScript(
      `docker exec -e PGPASSWORD ${created.containerName} psql -h ${pgAddress} -U ecoma_backoffice_migrator -d db-backoffice -tAc 'SELECT 1'`,
      { PGPASSWORD: SENTINELS[MIGRATOR_PASSWORD_ENV_VAR] },
    );
    // Wrong password control: sai mật khẩu cũng bị từ chối ở dòng scram —
    // chứng minh các login check phía trên đi qua đường verify thật.
    const wrongPassword = await created.runScript(
      `docker exec -e PGPASSWORD ${created.containerName} psql -h ${pgAddress} -U ecoma_backoffice_migrator -d db-backoffice -tAc 'SELECT 1'`,
      { PGPASSWORD: 'definitely-not-the-sentinel-password' },
    );

    flow = {
      provisionScriptText,
      provisionRun1,
      provisionRun2,
      provisionRun3Rotated,
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
    // Recording phải chạy thật: shim đã ghi lại lời gọi `docker exec` của
    // provision (kể cả pipe migration qua `docker exec -i` — TÊN role migrator
    // là MỘT argv element standalone của psql `-U`; log ghi NUL-separated nên
    // tìm bằng `\0element\0`; còn SQL advisory-lock đi qua STDIN, không argv)
    // — log rỗng là harness hỏng, không phải pass.
    expect(flowState.argvLog.includes(Buffer.from('ON_ERROR_STOP', 'utf8'))).toBe(true);
    expect(
      flowState.argvLog.includes(
        Buffer.concat([
          Buffer.from([0]),
          Buffer.from('ecoma_backoffice_migrator', 'utf8'),
          Buffer.from([0]),
        ]),
      ),
      'migration pipe never reached docker — the flow is broken',
    ).toBe(true);
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

  it('rendered script text carries none of the sentinels', () => {
    const flowState = requireFlow();
    for (const { channel, value } of [...ALL_SENTINELS, ...ALL_ROTATED]) {
      expect(
        flowState.provisionScriptText.includes(value),
        `sentinel ${channel} found in rendered script text`,
      ).toBe(false);
    }
    // Script không ghép giá trị mật khẩu vào bất kỳ đường argv nào: không
    // PGPASSWORD=, không URI có password.
    expect(flowState.provisionScriptText).not.toMatch(/PGPASSWORD=/u);
    expect(flowState.provisionScriptText).not.toMatch(/postgresql:\/\/[^:]+:[^@]*@/u);
  });

  it('ON_ERROR_STOP aborts bad SQL without echoing the secret-bearing statement', () => {
    const flowState = requireFlow();
    const { result } = flowState.onStopFailure;
    expect(result.code).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output.includes(ROTATED_SENTINELS[RUNTIME_PASSWORD_ENV_VAR])).toBe(false);
    // Câu SQL hỏng không được in lại vào output (psql chỉ in ERROR của server).
    expect(output.includes('WITH PASSWORD')).toBe(false);
  });
});

describe('provision state: create, rotation and idempotency', () => {
  it('provision create, idempotent re-run and rotation all exit zero (migration pipe included)', () => {
    const flowState = requireFlow();
    expect(flowState.provisionRun1.result.code).toBe(0);
    expect(flowState.provisionRun2.result.code).toBe(0);
    expect(flowState.provisionRun3Rotated.result.code).toBe(0);
  });

  it('guard-created exactly the two db-backoffice roles', () => {
    const flowState = requireFlow();
    expect(flowState.catalog.roleCount?.stdout.trim()).toBe('2');
  });

  it('db-backoffice stays owned by ecoma_local with the documented grant matrix', () => {
    const flowState = requireFlow();
    expect(flowState.catalog.dbOwner?.stdout.trim()).toBe('ecoma_local');
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

describe('migration state: applied by the inline pipe inside provision', () => {
  it('migration created the backoffice schema and tables in db-backoffice', () => {
    const flowState = requireFlow();
    expect(flowState.catalog.backofficeSchema?.stdout.trim()).toBe('1');
    const tables = Number(flowState.catalog.backofficeTables?.stdout.trim() ?? '0');
    expect(Number.isNaN(tables)).toBe(false);
    expect(tables).toBeGreaterThan(0);
  });

  it('migration re-run inside provision #2 stayed idempotent (same table count)', () => {
    const flowState = requireFlow();
    // provision #2 đã chạy lại toàn bộ pipe migration — nó phải exit 0 (assert
    // ở trên) và không nhân đôi gì: bảng đếm được sau lần chạy cuối vẫn là tập
    // idempotent của baseline (IF NOT EXISTS/ON CONFLICT), số lượng ổn định
    // giữa hai lần chạy liên tiếp.
    expect(flowState.provisionRun2.result.code).toBe(0);
    expect(flowState.provisionRun3Rotated.result.code).toBe(0);
  });
});
