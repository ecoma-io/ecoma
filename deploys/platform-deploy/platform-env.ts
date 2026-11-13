/**
 * Quản lý `.env` và mật khẩu PostgreSQL của lane local — SỞ HỮU bởi
 * `platform-deploy`.
 *
 * `.env` của worktree và mật khẩu PostgreSQL là artifact của up platform: đây
 * là nơi quyết định giá trị (stack config là nguồn sự thật canonical, `.env`
 * chỉ là bản sao), nên logic đọc/sinh/ghi sống cạnh entry của platform thay vì
 * trong lib dùng chung. Mọi unit khác chỉ ĐỌC `ROOT_HOST`/`POSTGRES_PASSWORD`
 * từ `.env` (xem `readRootHostFromEnv` của `@ecoma-io/deployment`) — không unit
 * nào ghi file này.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildRootHost,
  chmodFilePrivate,
  describeSpawnFailure,
  dockerResourceName,
  exec,
  fullStackRef,
  generatePostgresPassword,
  isConfigKeyMissing,
  LOCAL_ENV_OWNED_KEYS,
  LOCAL_ENV_RETIRED_KEYS,
  pulumiRun,
  type ExecResult,
  type LocalDeployContext,
} from '@ecoma-io/deployment';

/** Thư mục gốc của workspace, suy từ vị trí file này (`deploys/platform-deploy`). */
const WORKSPACE_ROOT = join(import.meta.dirname, '../..');

/** Key trong Pulumi stack config lưu mật khẩu PostgreSQL local. */
export const POSTGRES_PASSWORD_CONFIG_KEY = 'postgres:password';

/** Key trong Pulumi stack config lưu secret key S3 của remote cache local (#19). */
export const OBJECT_STORAGE_SECRET_KEY_CONFIG_KEY = 'objectStorage:remoteCacheSecretKey';

/** Kết quả đọc mật khẩu PostgreSQL từ stack config (nguồn sự thật canonical). */
export type PostgresPasswordLookup =
  | { state: 'found'; password: string }
  | { state: 'missing' }
  | { state: 'error'; detail: string };

/**
 * Đọc mật khẩu PostgreSQL từ stack config local.
 *
 * Config lưu **plaintext** (không `secure:`) — nên `pulumi config get` đọc
 * được mà không cần giải mã, và trả về giá trị rõ ràng. Đây là nguồn sự thật
 * canonical: `.env` chỉ là bản sao sinh ra từ đây.
 *
 * Phân biệt ba trạng thái thay vì hai: "chưa có key" (stack mới → được phép
 * sinh mật khẩu) khác "lỗi thật" (sai passphrase, backend hỏng → phải dừng,
 * không được sinh mật khẩu mới). Nhận diện sai ở đây là đúng loại lỗi khiến
 * Postgres bị khoá khỏi volume đã init.
 */
export function lookupPostgresPassword(result: ExecResult): PostgresPasswordLookup {
  if (result.status === 0) {
    const password = result.stdout.trim();
    if (password.length === 0) return { state: 'missing' };
    // Defense-in-depth: CLI `pulumi config get` trên 3.270 với đúng passphrase
    // trả về plaintext (không trả `[secret]`); masking `[secret]` chỉ xuất hiện
    // ở `pulumi config` (list) và ở Automation API (`stack output --json` không
    // `--show-secrets`, xem `@pulumi/pulumi@3.270.0` `automation/localWorkspace.js`).
    // Nhánh này vì vậy không đạt được qua đường gọi này, nhưng giữ lại để fail
    // loud nếu ever xuất hiện (vd. CLI đổi hành vi) thay vì dùng literal
    // `[secret]` làm password. Xem docs migration section để biết trigger thật.
    if (password === '[secret]') {
      return {
        state: 'error',
        detail:
          'Pulumi returned the `[secret]` masking string instead of the real password — the ' +
          'stack config is in a state where the real value cannot be read. Supply the ' +
          'correct passphrase via PULUMI_CONFIG_PASSPHRASE and retry; if it is still ' +
          'masked, see docs/architecture/local-development/03-operations.md (section Migration ' +
          'legacy postgres:password).',
      };
    }
    return { state: 'found', password };
  }
  if (isConfigKeyMissing(result)) return { state: 'missing' };
  // KHÔNG nhúng raw stderr/stdout vào detail: stdout của `pulumi config get
  // postgres:password` khi lệnh exit 0 CHÍNH LÀ mật khẩu — nếu CLI đổi hành vi
  // exit-code, nhét raw output vào error string là đường leak thật (detail đi
  // vào console.error). Thay bằng thông điệp cố định + hướng dẫn người dùng tự
  // chạy lệnh để xem stderr gốc.
  return {
    state: 'error',
    detail:
      `pulumi config get failed (exit ${String(result.status)}). Run ` +
      `'pulumi config get ${POSTGRES_PASSWORD_CONFIG_KEY} --stack <stack-ref>' manually in ` +
      'deploys/platform-deploy to see the original stderr — the output of this command is ' +
      'not logged because it may contain the password.',
  };
}

/** Tình trạng volume PostgreSQL của namespace — quyết định được sinh mật khẩu mới không. */
export type PostgresVolumeProbe =
  | { state: 'absent' }
  | { state: 'present' }
  | { state: 'unknown'; detail: string };

/**
 * Kiểm volume PostgreSQL của namespace có tồn tại không.
 *
 * Sự tồn tại của volume là thứ DUY NHẤT biết "database đã được init bằng mật
 * khẩu nào" — stack config có thể mất (ví dụ `pulumi stack rm` xoá cả config
 * trong khi volume `retainOnDelete` còn lại), nhưng volume thì vẫn giữ mật
 * khẩu superuser cũ. Vì vậy khi config mất mà volume còn, KHÔNG được sinh mật
 * khẩu mới: mật khẩu mới không bao giờ khớp volume đó.
 *
 * Phân biệt "không có" với "không xác định được": lỗi Docker (daemon không
 * chạy, socket sai) không phải bằng chứng volume vắng mặt — coi nó là
 * "vắng mặt" sẽ sinh mật khẩu mới rồi khoá người dùng ra khỏi dữ liệu cũ.
 */
export function probePostgresVolume(
  volumeName: string,
  env: NodeJS.ProcessEnv,
): PostgresVolumeProbe {
  const result = exec('docker', ['volume', 'inspect', volumeName], WORKSPACE_ROOT, env);
  if (result.status === 0) return { state: 'present' };
  if (result.status === null) {
    return { state: 'unknown', detail: describeSpawnFailure(result) };
  }
  const combined = `${result.stderr}\n${result.stdout}`;
  if (/not found|no such volume/iu.test(combined)) return { state: 'absent' };
  const firstLine = combined
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return { state: 'unknown', detail: firstLine ?? 'unknown Docker error' };
}

/**
 * Chuẩn bị mật khẩu PostgreSQL cho stack local — entry up của platform gọi.
 *
 * Nguồn sự thật CANONICAL là Pulumi stack config (`postgres:password`, lưu
 * plaintext). `.env` là bản sao sinh ra — nguồn của giá trị vẫn là config.
 *
 * Ba nhánh, theo thứ tự:
 *
 * 1. **Đã có trong config** → dùng lại nguyên giá trị. Không bao giờ sinh mới:
 *    sinh mới ở đây là đè mật khẩu đang dùng bởi volume đã init → Postgres
 *    không vào được dữ liệu cũ.
 * 2. **Chưa có trong config** → kiểm volume có tồn tại không:
 *    - Volume **có** → fail với lỗi có hướng dẫn hành động (config mất nhưng
 *      volume `retainOnDelete` còn — sinh mật khẩu mới là mật khẩu KHÔNG BAO
 *      GIỜ khớp volume đó).
 *    - Volume **không** → sinh mật khẩu ngẫu nhiên và ghi vào config.
 * 3. **Lỗi thật khi đọc config** (sai passphrase, backend hỏng) → fail, KHÔNG
 *    sinh mật khẩu mới: lỗi đó không phải bằng chứng "chưa có mật khẩu".
 */
export function resolvePostgresPassword(
  ctx: LocalDeployContext,
  env: NodeJS.ProcessEnv,
): { ok: true; password: string; generated: boolean } | { ok: false; error: string } {
  const platformDir = join(WORKSPACE_ROOT, 'deploys', 'platform-deploy');
  const lookup = lookupPostgresPassword(
    exec(
      'pulumi',
      [
        'config',
        'get',
        POSTGRES_PASSWORD_CONFIG_KEY,
        '--stack',
        fullStackRef('platform-deploy', ctx),
      ],
      platformDir,
      env,
    ),
  );

  if (lookup.state === 'found') {
    return { ok: true, password: lookup.password, generated: false };
  }
  if (lookup.state === 'error') {
    return {
      ok: false,
      error:
        `Failed to read ${POSTGRES_PASSWORD_CONFIG_KEY} from stack config: ${lookup.detail}\n` +
        'Do not generate a new password when the existing one cannot be read — doing so ' +
        'would lock Postgres out of the initialized volume.',
    };
  }

  // Config không có mật khẩu — volume quyết định có được sinh mới không.
  const volumeName = dockerResourceName(ctx.namespace, 'postgres-volume');
  const volume = probePostgresVolume(volumeName, env);
  if (volume.state === 'present') {
    return {
      ok: false,
      error:
        `PostgreSQL volume ${volumeName} already exists but stack config has no ` +
        `${POSTGRES_PASSWORD_CONFIG_KEY}. The volume was initialized with a password that is ` +
        'no longer in config (usually because `pulumi stack rm` removed the config while the ' +
        '`retainOnDelete` volume remained). Generating a new password will NOT match this ' +
        'volume and every connection will get ' +
        '`password authentication failed`.\n' +
        'Remediation: restore the old password into stack config, or delete the volume to ' +
        'start over from empty data:\n' +
        '  nx run platform-deploy:local-down   # DELETES data permanently — think twice\n' +
        '  then run the local-up lane again',
    };
  }
  if (volume.state === 'unknown') {
    return {
      ok: false,
      error:
        `Cannot probe PostgreSQL volume ${volumeName}: ${volume.detail}\n` +
        'Do not generate a new password before confirming whether the volume exists — ' +
        'a generated password may not match the initialized volume.',
    };
  }

  const password = randomBytes(24).toString('base64url');
  // Giá trị đi qua STDIN, không qua argv: argv của process khác đọc được qua
  // `/proc/<pid>/cmdline` (cùng user) và qua `ps` — mật khẩu local không cần
  // rò ra tới đó. `pulumi config set` đọc giá trị từ stdin khi không có
  // argument value (đo thật trên CLI 3.270), và `--raw` giữ nguyên giá trị
  // (không trim newline).
  //
  // `--plaintext` BẮT BUỘC: CLI 3.270 tự chặn giá trị "trông như secret"
  // (key `postgres:password` + giá trị ngẫu nhiên) với lỗi "looks like a
  // secret; rerun with --secret ... or --plaintext" và exit 1 — đo thật. Không
  // có cờ nào, `config set` fail và mật khẩu KHÔNG được lưu.
  const set = exec(
    'pulumi',
    [
      'config',
      'set',
      POSTGRES_PASSWORD_CONFIG_KEY,
      '--plaintext',
      '--raw',
      '--stack',
      fullStackRef('platform-deploy', ctx),
    ],
    platformDir,
    env,
    { input: password },
  );
  if (set.status !== 0) {
    return {
      ok: false,
      error: `pulumi config set ${POSTGRES_PASSWORD_CONFIG_KEY} failed:\n${set.stderr}`,
    };
  }
  return { ok: true, password, generated: true };
}

/**
 * Chuẩn bị secret key S3 của remote cache cho stack local — entry up của
 * platform gọi (issue #19), MIRROR `resolvePostgresPassword` ở trên nhưng
 * KHÔNG có bước probe volume.
 *
 * Vì sao không probe volume nào: giá trị này không bị "khóa tuổi" với dữ liệu
 * đã init — file `s3.json` được config-init của platform viết LẠI từ chính
 * stack config ở lần up hiện tại, không có cơ chế `initdb`-style giữ giá trị
 * cũ trong volume. Config mất (stack mới) → sinh mới là an toàn tuyệt đối;
 * config còn → dùng lại nguyên giá trị. Volume chỉ die cùng destroy và được
 * tái tạo từ config — hai nguồn không bao giờ lệch nhau.
 *
 * Hai nhánh:
 *
 * 1. **Đã có trong config** (hoặc đọc được, non-empty) → dùng lại nguyên giá trị.
 * 2. **"Chưa có key"** (`isConfigKeyMissing`) → sinh ngẫu nhiên và ghi vào config.
 *
 * **Lỗi thật khi đọc config** (sai passphrase, backend hỏng) → fail KHÔNG sinh
 * mới: lỗi đó không phải bằng chứng "chưa có secret"; sinh mới đè giá trị đang
 * dùng bởi object store đang chạy. Raw stdout/stderr KHÔNG được nhúng vào
 * error — stdout của `config get` khi exit 0 chính là secret, và khi exit != 0
 * không ai bảo đảm CLI không in giá trị; error đi vào console.error nên chỉ
 * in thông điệp cố định + hướng dẫn tự chạy lệnh.
 */
export function resolveObjectStorageSecretKey(
  ctx: LocalDeployContext,
  env: NodeJS.ProcessEnv,
): { ok: true; secretKey: string; generated: boolean } | { ok: false; error: string } {
  const platformDir = join(WORKSPACE_ROOT, 'deploys', 'platform-deploy');
  const result = exec(
    'pulumi',
    [
      'config',
      'get',
      OBJECT_STORAGE_SECRET_KEY_CONFIG_KEY,
      '--stack',
      fullStackRef('platform-deploy', ctx),
    ],
    platformDir,
    env,
  );

  if (result.status === 0) {
    const secretKey = result.stdout.trim();
    if (secretKey.length > 0) return { ok: true, secretKey, generated: false };
    // Exit 0 với stdout rỗng: không xảy ra trên CLI 3.270 (`config get` thiếu
    // key thì exit != 0) — fail-closed coi như "chưa có" và đi xuống nhánh sinh
    // mới thay vì truyền chuỗi rỗng vào file config của weed.
  } else if (!isConfigKeyMissing(result)) {
    return {
      ok: false,
      error:
        `Failed to read ${OBJECT_STORAGE_SECRET_KEY_CONFIG_KEY} from stack config (exit ` +
        `${String(result.status)}). Run \`pulumi config get ${OBJECT_STORAGE_SECRET_KEY_CONFIG_KEY} ` +
        "--stack <stack-ref>' manually in deploys/platform-deploy to see the original stderr — " +
        'the output of this command is not logged because it may contain the secret key. Do not ' +
        'generate a new secret before confirming the old one is unrecoverable.',
    };
  }

  // Sinh secret theo hình credential: `generatePostgresPassword` là generator
  // chung của repo cho credential 24-byte base64url (chỉ `A-Za-z0-9-_`) — an
  // toàn qua stdin của `config set`, qua stdin của config-init (không argv) và
  // file JSON không cần quote. Dùng lại thay vì sinh ra generator thứ hai có
  // cùng hình — tên hàm là tên gốc, ý nghĩa ở đây là "credential-shaped secret".
  const secretKey = generatePostgresPassword();
  // Giá trị đi qua STDIN, không qua argv — cùng lý do `resolvePostgresPassword`
  // (`/proc/<pid>/cmdline` + `ps` đọc được argv của process cùng user).
  // `--plaintext` BẮT BUỘC: CLI 3.270 tự chặn giá trị "trông như secret" nếu
  // thiếu cờ; `--raw` giữ nguyên giá trị (không trim newline).
  const set = exec(
    'pulumi',
    [
      'config',
      'set',
      OBJECT_STORAGE_SECRET_KEY_CONFIG_KEY,
      '--plaintext',
      '--raw',
      '--stack',
      fullStackRef('platform-deploy', ctx),
    ],
    platformDir,
    env,
    { input: secretKey },
  );
  if (set.status !== 0) {
    return {
      ok: false,
      error: `pulumi config set ${OBJECT_STORAGE_SECRET_KEY_CONFIG_KEY} failed:\n${set.stderr}`,
    };
  }
  return { ok: true, secretKey, generated: true };
}

/**
 * Ghi các key mà lane platform sở hữu vào `.env` của worktree mà KHÔNG đụng
 * key khác.
 *
 * `.env` là artifact: nếu file không có thì tạo mới với đúng các key được ghi;
 * nếu có rồi thì chỉ thay dòng `KEY=...` của các key thuộc `LOCAL_ENV_OWNED_KEYS`,
 * mọi dòng khác giữ nguyên byte-for-byte.
 *
 * Chỉ key sở hữu được ghi — đây là ranh giới contract, không phải chi tiết
 * cài đặt: `values` do caller dựng và có thể vô tình mang key lạ, mà ghi đè một
 * key người dùng tự quản lý là mất dữ liệu không khôi phục được.
 */
export function upsertLocalEnv(
  worktreeRoot: string,
  values: Readonly<Record<string, string>>,
): { envPath: string } {
  const envPath = join(worktreeRoot, '.env');
  const owned = new Set<string>(LOCAL_ENV_OWNED_KEYS);
  const entries = Object.entries(values).filter(([key]) => owned.has(key));
  // Guard injection: giá trị chứa newline sẽ phá cấu trúc dòng của file khi ghi
  // (một giá trị nhiều dòng sinh ra các dòng env rác). `values` đến từ outputs
  // Pulumi được kiểm soát nên đây là fail-loud với input dị hình, không phải
  // đường xử lý bình thường.
  for (const [, value] of entries) {
    if (value.includes('\n') || value.includes('\r')) {
      throw new Error(
        'upsertLocalEnv: an owned key value contains a newline character (\\n/\\r) — ' +
          'refusing to write so the .env file structure is not corrupted.',
      );
    }
  }
  if (!existsSync(envPath)) {
    if (entries.length > 0) {
      writeFileSync(envPath, `${entries.map(([key, value]) => `${key}=${value}`).join('\n')}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    } else {
      writeFileSync(envPath, '', { encoding: 'utf8', mode: 0o600 });
    }
    chmodFilePrivate(envPath, 0o600);
    return { envPath };
  }
  const content = readFileSync(envPath, 'utf8');
  // Bỏ phần tử rỗng CUỐI do file kết thúc bằng `\n`: giữ nó thì key được thêm
  // cuối sinh ra một dòng trống misplaced (`OTHER=keep\n\nROOT_HOST=…`) — các
  // phần tử rỗng Ở GIỮA dòng khác vẫn giữ nguyên vị trí như cũ.
  const linesFile = content.split('\n');
  const trailingEmpty = linesFile.length > 1 && linesFile[linesFile.length - 1] === '';
  const lines = trailingEmpty ? linesFile.slice(0, -1) : linesFile;
  // Merge theo vị trí: MỌI dòng `KEY=...` của một key sở hữu đều được cập nhật
  // (không chỉ dòng đầu) — nếu file lỡ có dòng trùng và dotenv parse last-wins
  // thì chỉ thay dòng đầu sẽ để lại giá trị cũ ở dòng sau. Không append thêm
  // dòng mới khi key đã xuất hiện (số lần nào cũng vậy). Dòng không thuộc key
  // sở hữu giữ nguyên byte-for-byte, TRỪ dòng của key retired (xem bộ lọc dưới).
  const valueByKey = new Map(entries);
  const seen = new Set<string>();
  // Key retired (`LOCAL_ENV_RETIRED_KEYS`) không còn consumer nào đọc: gỡ MỌI
  // dòng của nó khỏi file có sẵn tại lần up kế tiếp — migration một bước của
  // contract `.env` (#210). Lưu ý khác với key sở hữu: key retired không bao
  // giờ được ghi lại, chỉ được xoá.
  const next = lines
    .filter((entry) => !LOCAL_ENV_RETIRED_KEYS.some((key) => entry.startsWith(`${key}=`)))
    .map((entry) => {
      const ownedKey = LOCAL_ENV_OWNED_KEYS.find((key) => entry.startsWith(`${key}=`));
      if (ownedKey === undefined) return entry;
      seen.add(ownedKey);
      const value = valueByKey.get(ownedKey);
      return value === undefined ? entry : `${ownedKey}=${value}`;
    });
  // Key sở hữu có trong `values` nhưng chưa xuất hiện trong file → thêm cuối một lần.
  for (const [key, value] of valueByKey) {
    if (!seen.has(key)) {
      next.push(`${key}=${value}`);
    }
  }
  // Bộ lọc retired có thể rút cạn file (`.env` chỉ toàn key retired): ghi file
  // rỗng thay vì một dòng `\n` thừa.
  writeFileSync(envPath, next.length > 0 ? `${next.join('\n')}\n` : '', {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodFilePrivate(envPath, 0o600);
  return { envPath };
}

/**
 * Đọc outputs của platform stack sau khi `up` — fail-closed khi thiếu key.
 */
export function readPlatformOutputs(
  platformDir: string,
  ctx: LocalDeployContext,
  env: NodeJS.ProcessEnv,
): {
  traefikHostPort: number;
  rootHost: string;
} {
  const stdout = pulumiRun(
    platformDir,
    'platform-deploy',
    ['stack', 'output', '--json'],
    ctx,
    env,
    {
      prepareStack: false,
    },
  );
  // Không truyền `stream` nên trả về chuỗi — chỉ `up`/`preview` mới stream.
  let outputs: Record<string, unknown>;
  try {
    outputs = JSON.parse(stdout ?? '') as Record<string, unknown>;
  } catch {
    throw new Error(`Failed to parse platform stack outputs as JSON:\n${stdout}`);
  }
  const rawPort = outputs['traefikHostPort'];
  // Port đo được là số nguyên dương — một giá trị `undefined`/`0`/string lọt
  // qua đây sẽ sinh `fbi.com:NaN` ở smoke test, nên chặn tại nguồn.
  if (typeof rawPort !== 'number' || !Number.isInteger(rawPort) || rawPort <= 0) {
    throw new Error(
      `Invalid traefikHostPort output: ${JSON.stringify(rawPort)} — platform not fully up yet?`,
    );
  }
  return { traefikHostPort: rawPort, rootHost: buildRootHost(rawPort) };
}
