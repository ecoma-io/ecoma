import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { readRootHostPort } from './local-origin';

/**
 * Fixture layer của suite — NỘI BỘ local stack, truy cập QUA Docker CLI.
 *
 * Suite là black-box HTTP với app (mọi assertion flow đi qua Traefik — issue
 * #185: "không đụng nội bộ container" từ phía HTTP), NHƯNG luồng login cần
 * hai cốc phân lập mà giao thức public không cung cấp:
 *
 * 1. **Seed user**: KHÔNG có signup API (anti-enumeration — #185 "fixturization
 *    qua dữ liệu, không qua code path sản xuất"). User test được seed TRỰC
 *    TIẾP vào Postgres của stack: `INSERT account.users` + `account.email_addresses`
 *    (status `verified`, `is_sign_in`) — cùng hình thức seed của
 *    `apps/account/tests/integrations/otp-flow-e2e.spec.ts::seedVerifiedEmail`.
 *    Địa chỉ đã normalize ⇒ `address_hash` = SHA-256 hex của normalized email
 *    (`normalizeAndHashEmail` trong `apps/account/server/lib/otp.ts`) — hash
 *    là SHA-256 THUẦN, KHÔNG có secret, nên suite tự tính được mà không cần
 *    đọc env của container (khác với digest của OTP code — cái đó có HMAC key,
 *    nhưng suite cũng không cần nó: mã đọc từ mail sink).
 * 2. **Mail sink**: OTP đi qua transactional-mail với provider `fake`; nội
 *    dung render (`subject_rendered`, `body_rendered`) persist trong D1 sqlite
 *    trên volume `/state` của WIC mail NGAY LẬP TỨC khi control plane chấp
 *    nhận POST `/v1/messages` (status `accepted` — render xong lúc create).
 *    Suite trigger cron của cả hai worker (`POST /cdn-cgi/local/scheduled` —
 *    đường chính thức của wrangler dev, cùng đường
 *    `tools/dx/scripts/mail-worker-runtime-e2e.mjs::triggerCron`) trong vòng
 *    poll để pipeline tiem tới `sent`, nhưng việc ĐỌC mã không phụ thuộc
 *    delivery: mã đã nằm trong body render từ lúc accepted.
 *    sqlite đọc bằng `node:sqlite` **bên trong container** (image Node 24 có
 *    sẵn module này; binary sqlite3 KHÔNG có trên image slim).
 *
 * ## Mỗi file spec một danh tính riêng
 *
 * `workers: 2` nghĩa là HAI file spec chạy SONG SONG trên hai worker. Nếu
 * chung một địa chỉ fixture, worker này có thể đọc nhầm mã của worker kia
 * (mã mới nhất trong sink) và verify trước — mã single-use của worker kia
 * chết vì replay. Nên mọi hàm fixture nhận danh tính `{ sub, email }` của
 * RIÊNG file (mỗi file một cặp hằng), và mọi truy vấn sink lọc theo
 * `recipient` — hai file không bao giờ nhìn thấy hàng của nhau.
 *
 * ## Tìm container của đúng stack đang chạy
 *
 * Một máy có thể có NHIỀU stack (mỗi worktree một namespace —
 * `tools/dx/src/local-runtime/deploy-namespace.ts`). Suite KHÔNG tự derive
 * namespace từ path (suite thường chạy ở worktree khác worktree chạy stack);
 * nguồn sự thật là `ROOT_DOMAIN`/`ROOT_HOST` (host:port Traefik publish ra
 * loopback): map port → container `ecoma-*-traefik` publish đúng port đó →
 * đọc label `io.ecoma.worktree-id` → đó là namespace. Label do CLI ghi và
 * được `deploy-labels.ts` validate chéo worktree-path, đáng tin hơn suy luận
 * lại từ path. Không tìm thấy ĐÚNG MỘT container khớp → fail với danh sách
 * candidate thay vì đoán (single-stack-per-machine là norm, không phải
 * contract).
 *
 * ## An toàn dữ liệu
 *
 * - Seed `ON CONFLICT DO NOTHING` / `WHERE NOT EXISTS` — idempotent giữa các
 *   lần chạy; mọi DELETE chỉ theo định danh của suite (sub, hash của địa chỉ
 *   fixture, recipient trong sink), không đụng hàng nào khác của stack.
 * - Không secret nào đi qua argv lẫn output: `execFileSync` argv-mảng (không
 *   shell string), output psql của các lệnh dọn không in giá trị cột nhạy cảm
 *   (bảng `otp_challenges` chỉ có digest, không có mã trần).
 */

/** Timeout mỗi lệnh docker — treo là lỗi, không chờ vô hạn. */
const DOCKER_TIMEOUT_MS = 30_000;

/** TTL poll mail sink (ms) — pipeline qua hai cron nhịp, budget phải rộng. */
export const MAIL_SINK_POLL_BUDGET_MS = 60_000;
/** Nhịp poll mail sink. */
export const MAIL_SINK_POLL_INTERVAL_MS = 2_000;

/** Danh tính fixture của một file spec — cặp hằng, mỗi file một cặp. */
export interface FixtureIdentity {
  /** `sub` của `account.users` — hằng của file, để cleanup dọn đúng hàng. */
  readonly sub: string;
  /** Địa chỉ email (đã normalized: lowercase, không khoảng trắng). */
  readonly email: string;
}

/** SHA-256 hex của địa chỉ đã normalize — cùng phép tính `normalizeAndHashEmail` (otp.ts): trim + lowercase TRƯỚC khi băm, không thì hash của suite lệch hash server tra cứu. */
export function fixtureEmailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/**
 * Namespace của stack mà `ROOT_DOMAIN`/`ROOT_HOST` đang trỏ tới — suy từ
 * container Traefik publish đúng port đó (khối "Tìm container" ở đầu file).
 * Cache một lần: container không đổi giữa chừng một lần chạy suite.
 */
let cachedNamespace: string | undefined;

export function resolveStackNamespace(): string {
  if (cachedNamespace !== undefined) {
    return cachedNamespace;
  }
  // Cùng một cơ chế resolve runtime config với `local-origin.ts`: ENV trước,
  // fallback `.env` repo root TẠI THỜI ĐIỂM ĐỌC (Nx snapshot env của task suite
  // TRƯỚC khi platform-deploy kịp ghi `.env` trong đường một-invocation).
  const fromEnv = readRootHostPort();
  const port = fromEnv.includes(':') ? (fromEnv.split(':')[1] ?? '') : '443';
  const candidates = dockerLines(['ps', '--format', '{{.Names}}']).filter((name) =>
    /^ecoma-[a-z0-9]+-traefik$/u.test(name),
  );
  const matches: string[] = [];
  for (const name of candidates) {
    // `{{range}}` in MỌI host port của container lên MỘT dòng, phân cách bằng
    // khoảng trắng ("33118 80 ") — tách lại theo whitespace trước khi so, không
    // thì `includes` so nguyên chuỗi nhiều port và luôn false.
    const ports = dockerLines([
      'inspect',
      name,
      '--format',
      '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostPort}} {{end}}{{end}}',
    ])
      .join(' ')
      .split(/\s+/u)
      .filter((value) => value.length > 0);
    if (ports.includes(port)) {
      matches.push(name);
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ecoma Traefik container publishing loopback port ${port}, found ` +
        `${matches.length}: ${JSON.stringify(matches)}. ROOT_DOMAIN must point at the live ` +
        "stack's dynamic port — rerun the local lane in the owning checkout and use its ROOT_DOMAIN.",
    );
  }
  const namespace = dockerLines([
    'inspect',
    matches[0] ?? '',
    '--format',
    '{{index .Config.Labels "io.ecoma.worktree-id"}}',
  ])[0];
  if (namespace === undefined || !/^w[a-z0-9]{12}$/u.test(namespace)) {
    throw new Error(
      `Traefik container ${matches[0] ?? '(none)'} has no valid io.ecoma.worktree-id label — ` +
        'the stack was not deployed by the Nx local lane; cannot identify its containers safely.',
    );
  }
  cachedNamespace = namespace;
  return namespace;
}

/** Chạy docker với argv mảng (không shell string), trả stdout đã tách dòng. */
function dockerLines(args: readonly string[]): string[] {
  return dockerOut(args)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Chạy docker, trả stdout thô. Lệnh treo quá timeout là lỗi của execFileSync. */
function dockerOut(args: readonly string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: DOCKER_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function containerName(namespace: string, kind: 'postgres' | 'mail-wic'): string {
  return `ecoma-${namespace}-${kind}`;
}

/**
 * Seed user fixture vào Postgres của stack — idempotent: `ON CONFLICT DO
 * NOTHING` cho user; email_addresses dùng `WHERE NOT EXISTS` vì partial
 * UNIQUE index (`email_addresses_verified_hash_idx`) chặn trùng hash trong
 * số hàng verified — guard ứng dụng cho trường hợp lần chạy trước đã seed.
 *
 * SQL chạy qua `psql` trong container postgres với user `ecoma_local` (role
 * local của stack; quyền INSERT đã xác minh trên stack thật). Giá trị ghép
 * trực tiếp vào script là HẰNG SỐ của suite (danh tính fixture khai tường
 * minh trong từng spec file, không phải input người dùng) và không chứa ký
 * tự nào cần SQL escaping.
 */
export function seedFixtureUser(namespace: string, identity: FixtureIdentity): void {
  // Chuẩn hoá email theo đúng phép tính của server (`normalizeAndHashEmail`,
  // otp.ts): trim + lowercase trước khi lưu `address_normalized` và băm
  // `address_hash` — nếu không, hash của suite lệch hash server tra cứu và
  // `lookupVerifiedAddress` miss.
  const normalized = identity.email.trim().toLowerCase();
  const hash = fixtureEmailHash(normalized);
  const script =
    `INSERT INTO account.users (sub) VALUES ('${identity.sub}') ON CONFLICT DO NOTHING;\n` +
    `INSERT INTO account.email_addresses (user_sub, address_normalized, address_hash, status, is_sign_in, verified_at)\n` +
    `SELECT '${identity.sub}', '${normalized}', '${hash}', 'verified', true, now()\n` +
    `WHERE NOT EXISTS (\n` +
    `  SELECT 1 FROM account.email_addresses WHERE user_sub = '${identity.sub}' AND address_hash = '${hash}'\n` +
    `);`;
  dockerOut([
    'exec',
    containerName(namespace, 'postgres'),
    'psql',
    '-U',
    'ecoma_local',
    '-d',
    'db-account',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    script,
  ]);
}

/**
 * Xóa TOÀN BỘ dấu vết của danh tính fixture này trong Postgres: challenge của
 * địa chỉ (kể cả "challenge ma" của địa chỉ unknown cùng nhóm — rate-limit
 * cửa sổ trượt đếm từ bảng này, không dọn thì lần chạy SAU của suite có thể
 * va trần 3/15 phút của chính nó), session, email, user. Chạy trong
 * `afterAll`. Mọi DELETE theo định danh của suite.
 *
 * KHÔNG đụng mail sink ở đây: DB D1 là file sqlite CỦA MỘT WORKER wrangler
 * ĐANG CHẠY, và `afterAll` của một file chạy ĐỒNG THỜI với poll của file
 * song song — write lúc đó dính `SQLITE_BUSY` (đã gặp thật). Message cũ trong
 * sink vô hại: `beforeAll` của mỗi lần chạy dọn recipient của mình TRƯỚC khi
 * challenge, và `readMailSink` đọc newest-first nên mã cũ không nhầm được với
 * mã mới.
 */
export function cleanupFixtureData(
  namespace: string,
  identity: FixtureIdentity,
  extraEmails: readonly string[] = [],
): void {
  const hashes = [fixtureEmailHash(identity.email), ...extraEmails.map(fixtureEmailHash)];
  const hashList = hashes.map((hash) => `'${hash}'`).join(', ');
  const statements = [
    `DELETE FROM account.otp_challenges WHERE address_hash IN (${hashList});`,
    `DELETE FROM account.account_sessions WHERE user_sub = '${identity.sub}';`,
    `DELETE FROM account.email_addresses WHERE user_sub = '${identity.sub}';`,
    `DELETE FROM account.users WHERE sub = '${identity.sub}';`,
  ];
  dockerOut([
    'exec',
    containerName(namespace, 'postgres'),
    'psql',
    '-U',
    'ecoma_local',
    '-d',
    'db-account',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    statements.join('\n'),
  ]);
}

/**
 * Trigger MỘT nhịp cron của control plane VÀ consumer — đường chính thức của
 * wrangler dev (`POST /cdn-cgi/local/scheduled?format=json&cron=…`, cùng
 * đường `mail-worker-runtime-e2e.mjs::triggerCron`). Chạy BÊN TRONG container
 * WIC (worker chỉ nghe trong netns của container — `--ip 0.0.0.0` là cho
 * network nội bộ Docker, không publish ra host).
 *
 * Publish nhặt hàng `mail_outbox` mới → Queue; consumer nhặt job → gọi fake
 * provider → `mail_messages.status='sent'`. Delivery là async: caller poll
 * sink, helper này chỉ bắn một nhịp cặp mỗi lần gọi.
 */
export function triggerMailCron(namespace: string): void {
  const trigger = (port: number): void => {
    dockerOut([
      'exec',
      containerName(namespace, 'mail-wic'),
      'node',
      '-e',
      `fetch('http://127.0.0.1:${port}/cdn-cgi/local/scheduled?format=json&cron='` +
        `+encodeURIComponent('*/5 * * * *'),{method:'POST'})` +
        `.then(r=>{if(!r.ok)throw new Error('cron ${port} -> '+r.status);return r.text()})` +
        `.then(t=>console.log(t))` +
        `.catch(e=>{console.error(e.message);process.exit(1)})`,
    ]);
  };
  trigger(4206); // control plane (ecoma-transactional-mail) — publish outbox
  trigger(4207); // consumer (ecoma-transactional-mailer-job) — deliver
}

/** Chạy script node bên trong container WIC mail, trả stdout. */
function runNodeInMailWic(namespace: string, script: string): string {
  return dockerOut(['exec', containerName(namespace, 'mail-wic'), 'node', '-e', script]);
}

/**
 * Path file sqlite của D1 `mail` — nhận diện bằng SCHEMA (bảng
 * `mail_messages`), không phải tên file: miniflare đặt tên theo unique id nội
 * bộ không suy được từ ngoài, và persist dir chia bởi hai worker nên có ≥ 2
 * file `.sqlite` + `metadata.sqlite`. DB của mail-job không có bảng
 * `mail_messages`, nên schema là định danh unambiguous.
 */
function mailDbPath(namespace: string): string {
  const listing = dockerLines([
    'exec',
    containerName(namespace, 'mail-wic'),
    'find',
    '/state',
    '-name',
    '*.sqlite',
  ]);
  const path = runNodeInMailWic(
    namespace,
    `
const { DatabaseSync } = require('node:sqlite');
const candidates = ${JSON.stringify(listing)};
for (const p of candidates) {
  if (p.endsWith('metadata.sqlite')) continue;
  try {
    const db = new DatabaseSync(p, { readOnly: true });
    const row = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='mail_messages'").get();
    db.close();
    if (row && row.n > 0) { console.log(p); process.exit(0); }
  } catch {}
}
process.exit(1);
`,
  ).trim();
  if (!path.startsWith('/state/')) {
    throw new Error(
      'could not identify the mail D1 sqlite file inside the transactional-mail WIC — ' +
        'check the container state (docker logs ecoma-*-mail-wic).',
    );
  }
  return path;
}

/**
 * Xóa message của ĐÚNG các recipient cho trước trong sink (lúc cleanup) —
 * mỗi file chỉ dọn hàng của danh tính mình, không đụng message của worker
 * song song khác. Xóa outbox-TRƯỚC-message (`mail_outbox.delivery_id` tham
 * chiếu `mail_messages.delivery_id` với ON DELETE RESTRICT — đã kiểm tra
 * `PRAGMA foreign_key_list`); FK-off là lớp phòng thêm.
 *
 * DB là file sqlite CỦA MỘT WORKER wrangler ĐANG CHẠY — có thể bị khóa trong
 * chốc lát (`SQLITE_BUSY`): thử lại với backoff thay vì fail; cleanup là việc
 * nhà vệ sinh, không đáng để làm test đỏ.
 *
 * Giá trị recipient đi qua placeholder (`?`) — KHÔNG ghép chuỗi SQL, nên dấu
 * nháy đơn trong giá trị không phá được script (lỗi quote đã gặp thật với
 * bản ghép-chuỗi).
 */
export function clearMailSink(namespace: string, recipients: readonly string[]): void {
  if (recipients.length === 0) {
    return;
  }
  const path = mailDbPath(namespace);
  runNodeInMailWic(
    namespace,
    `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(${JSON.stringify(path)});
db.exec('PRAGMA foreign_keys=OFF');
db.exec('PRAGMA busy_timeout=5000');
const recipients = ${JSON.stringify(recipients)};
const placeholders = recipients.map(() => '?').join(', ');
const rows = db
  .prepare('SELECT id, delivery_id FROM mail_messages WHERE recipient IN (' + placeholders + ')')
  .all(...recipients);
for (const row of rows) {
  db.prepare('DELETE FROM mail_outbox WHERE delivery_id = ?').run(row.delivery_id);
  db.prepare('DELETE FROM mail_messages WHERE id = ?').run(row.id);
}
console.log('cleared ' + rows.length);
db.close();
`,
  );
}

export interface SinkMessage {
  readonly recipient: string;
  readonly subjectRendered: string;
  readonly bodyRendered: string;
}

/**
 * Đọc TẤT CẢ message trong sink cho MỘT recipient (mới nhất trước). Mảng
 * rỗng khi chưa có — caller poll. Lọc theo recipient là điều kiện KHÔNG ĐƯỢC
 * BỎ: worker song song dùng địa chỉ khác, đọc thiếu lọc là đọc chéo mã.
 */
export function readMailSink(namespace: string, recipient: string): SinkMessage[] {
  const path = mailDbPath(namespace);
  const out = runNodeInMailWic(
    namespace,
    `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(${JSON.stringify(path)}, { readOnly: true });
const rows = db
  .prepare('SELECT recipient, subject_rendered, body_rendered FROM mail_messages WHERE recipient = ? ORDER BY created_at DESC')
  .all(${JSON.stringify(recipient)});
console.log(JSON.stringify(rows));
db.close();
`,
  );
  const parsed: unknown = JSON.parse(out.trim());
  if (!Array.isArray(parsed)) {
    throw new Error(`unexpected mail sink payload: ${out.slice(0, 200)}`);
  }
  return parsed.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      recipient: String(record['recipient'] ?? ''),
      subjectRendered: String(record['subject_rendered'] ?? ''),
      bodyRendered: String(record['body_rendered'] ?? ''),
    };
  });
}

/**
 * Poll mail sink tới khi một message chứa mã 8 chữ số xuất hiện CHO ĐỊA CHỈ
 * truyền vào; giữa các nhịp bắn lại cặp cron (publish → queue → deliver).
 * Trả mã — chuỗi 8 digit ĐẦU TIÊN tìm thấy trong `body_rendered`.
 *
 * Regex trên body là bóc tách chính xác của biến `code`: template seed
 * `account.login-otp` (migration 0009) chỉ có placeholder `{{ code }}` duy
 * nhất (`<p>Your login code is {{ code }}</p>`), mã là 8 digit nên HTML-escape
 * không đổi gì — mã trong body đúng là mã mà `challenge` đã cấp. Mã xuất hiện
 * ở status `accepted` (control plane render lúc create) nên poll không phụ
 * thuộc delivery của consumer; cron trong vòng poll chỉ giúp pipeline drain.
 */
export async function pollOtpFromSink(namespace: string, recipient: string): Promise<string> {
  const startedAt = Date.now();
  let lastDetail = 'no message yet';
  for (;;) {
    triggerMailCron(namespace);
    await new Promise((resolve) => {
      setTimeout(resolve, MAIL_SINK_POLL_INTERVAL_MS);
    });
    const messages = readMailSink(namespace, recipient);
    for (const message of messages) {
      const match = /\d{8}/u.exec(message.bodyRendered);
      if (match !== null) {
        return match[0];
      }
      lastDetail = `message without an 8-digit code: ${message.subjectRendered}`;
    }
    if (messages.length > 0) {
      lastDetail = `${messages.length} message(s) seen, none carried a code`;
    }
    if (Date.now() - startedAt > MAIL_SINK_POLL_BUDGET_MS) {
      throw new Error(
        `OTP did not arrive in the mail sink within ${MAIL_SINK_POLL_BUDGET_MS}ms — last: ${lastDetail}. ` +
          'Check the transactional-mail WIC container of the stack (docker logs ecoma-*-mail-wic).',
      );
    }
  }
}
