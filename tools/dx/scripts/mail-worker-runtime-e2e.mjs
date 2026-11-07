#!/usr/bin/env node
/**
 * E2E local Worker runtime của bounded context transactional-mail — lặp lại
 * được, trong repo, KHÔNG dùng Cloudflare thật và KHÔNG gửi email thật.
 *
 * Nguồn quy trình: docs/architecture/local-development/evidence/worker-runtime-e2e.md
 * (bằng chứng PR5 bằng script dùng-một-lần ngoài repo; script này là phiên
 * bản in-repo của cùng luồng, cộng lifecycle-event path của PR2).
 *
 * Luồng kiểm chứng:
 *
 *  1. Ghi `.dev.vars` hai app (fake provider, secrets local-only) rồi
 *     `local-worker-down` idempotent.
 *  2. `pnpm dx local-worker-up` — boot control plane trước, consumer sau
 *     (thứ tự topo theo service + queue dependency); migrations D1 + template
 *     seed tự áp qua migrations dir của từng app.
 *  3. `POST /v1/messages` với envelope HMAC `ecoma-internal-v1`: ký bằng
 *     secret mailer-job → 403 (principal không có `message.create`); ký bằng
 *     `svc.account` (template `account.login-otp` đúng allowlist) → 201.
 *  4. Trigger cron control plane → publish outbox → Queue `ecoma-mail-delivery`
 *     (producer control plane, consumer mailer-job — giao chéo process qua dev
 *     registry) → trigger cron consumer → assert D1 `mail_jobs.status='sent'`,
 *     `provider_message_id` của fake provider, rồi cron control plane lần nữa
 *     → `mail_messages.status='sent'`.
 *  5. Lifecycle events: fixture producer worker (config sinh TẠM trong
 *     stateDir, KHÔNG vào repo) publish 3 message vào
 *     `ecoma-mail-lifecycle-events` qua producer binding — session fixture
 *     không có consumer nên broker forward qua dev-registry
 *     `ExternalQueueProxy` sang session mailer-job (cùng cơ chế bước 4):
 *       a. `delivered` khớp `provider_message_id` thật → 1 row
 *          `mail_lifecycle_events`, `delivery_id` correlate.
 *       b. Cùng event giao hai lần (`event_id` trùng) → vẫn 1 row (dedupe).
 *       c. Payload JSON cắt cụt → row `quarantine` reason
 *          `lifecycle-event-invalid`.
 *  6. Teardown: tắt fixture + `local-worker-down` + assert không còn process
 *     wrangler/workerd của worktree và metadata đã dọn.
 *
 * Chạy: `node tools/dx/scripts/mail-worker-runtime-e2e.mjs`
 * (yêu cầu đã build hai app mail — generated config trỏ `dist/main.js`.
 * Boot CHỈ hai entry mail qua `local-worker-up --entry`, sub Directed Boot —
 * không phụ thuộc build/boot các app khác của repo).
 *
 * Exit 0 = mọi bước đạt; exit 1 = fail-closed tại bước đầu thất bại. Script
 * tự teardown trong mọi nhánh (kể cả fail) — không để lại runtime sống sau
 * một lần chạy hỏng.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// script nằm ở tools/dx/scripts/ → repo root là 3 cấp trên.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT_TAG = '[mail-e2e]';
const STATE_DIR = join(REPO_ROOT, '.worker-local-state');
const PERSIST_TO = STATE_DIR;
const MAIL_APP_DIR = join(REPO_ROOT, 'apps', 'transactional-mail');
const JOB_APP_DIR = join(REPO_ROOT, 'apps', 'transactional-mailer-job');
const MAIL_GENERATED_CONFIG = join(
  STATE_DIR,
  'generated',
  'ecoma-transactional-mail.wrangler.jsonc',
);
const JOB_GENERATED_CONFIG = join(
  STATE_DIR,
  'generated',
  'ecoma-transactional-mailer-job.wrangler.jsonc',
);
const CRON = '*/5 * * * *';
// `fake-mail-provider.ts` trả message id này cho mọi send() thành công —
// lifecycle `delivered` phải correlate về delivery qua id đó.
const FAKE_PROVIDER_MESSAGE_ID = 'fake-provider-message-id';

// ---------------------------------------------------------------------------
// Local-only secrets — deterministic hex sinh từ namespace chuỗi cố định của
// script này. KHÔNG phải credential của môi trường nào: chỉ hợp lệ trong
// `.dev.vars` local (file `.dev.vars*` đã .gitignore). 64 hex = 32 byte.
// ---------------------------------------------------------------------------

const hex64 = (label) => createHash('sha256').update(`ecoma-mail-local-e2e/${label}`).digest('hex');

const MAILER_JOB_SECRET = hex64('svc-transactional-mailer-job');
const SVC_ACCOUNT_SECRET = hex64('svc-account');
const SVC_AUTH_SECRET = hex64('svc-auth');
const SVC_PAYMENT_SECRET = hex64('svc-payment');
const QUARANTINE_KEY_HEX = hex64('quarantine');
const FINGERPRINT_KEY_HEX = hex64('fingerprint-p1');

// ---------------------------------------------------------------------------
// Step runner — in tường minh, fail-closed tại bước đầu thất bại.
// ---------------------------------------------------------------------------

const STEP_RESULTS = [];

async function step(name, fn) {
  process.stdout.write(`${SCRIPT_TAG} STEP ${name} ... `);
  try {
    const detail = await fn();
    process.stdout.write(`ok${detail ? ` — ${detail}` : ''}\n`);
    STEP_RESULTS.push({ name, ok: true });
  } catch (error) {
    process.stdout.write('FAIL\n');
    STEP_RESULTS.push({ name, ok: false, detail: String(error?.message ?? error) });
    throw error;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Poll tới khi `fn()` trả true, hoặc fail với nguyên nhân cuối sau deadline. */
async function pollUntil(description, fn, { timeoutMs = 60_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      if (await fn()) return;
      lastError = 'condition returned false';
    } catch (error) {
      lastError = String(error?.message ?? error);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timeout ${timeoutMs}ms waiting for ${description} — last: ${lastError ?? 'never ran'}`,
      );
    }
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Shell + D1 helpers — execFileSync (không shell string). Mọi lệnh ở đây
// không nhận secret qua argv, output không in secret nào.
// ---------------------------------------------------------------------------

function run(cmd, args) {
  return execFileSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Timeout này biến mọi treo (không chỉ `up`) thành fail của script thay
    // vì treo E2E vĩnh viễn. Hang của `local-worker-up` đã root-cause và fix
    // ở CLI (Issue #214: leftover pipe handle giữ event loop — CLI giờ exit
    // tường minh); timeout giữ lại như defense-in-depth. 180s đủ dư cho boot
    // 2 entry + migrations (thường < 20s).
    timeout: 180_000,
  });
}

function runD1Sql(configPath, database, sql) {
  const out = run('npx', [
    'wrangler',
    'd1',
    'execute',
    database,
    '--local',
    '--persist-to',
    PERSIST_TO,
    '--config',
    configPath,
    '--command',
    sql,
    '--json',
  ]);
  const parsed = JSON.parse(out);
  const rows = parsed[0]?.results;
  assert(Array.isArray(rows), `wrangler d1 execute returned no results for: ${sql.slice(0, 80)}`);
  return rows;
}

// ---------------------------------------------------------------------------
// Envelope HMAC `ecoma-internal-v1` — bản dừng của canonical string trong
// libs/internal-auth-contracts (golden vector của lib chốt format này):
//   method \n proto \n len(path):path \n len(ts):ts \n len(nonce):nonce \n bodyHash
// method lowercase; length prefix là byte UTF-8; bodyHash là SHA-256 hex chữ
// thường của ĐÚNG byte body; signature gắn prefix `v1=`.
// ---------------------------------------------------------------------------

async function internalAuthHeaders({ method, path, bodyText, secret }) {
  const encoder = new TextEncoder();
  const bodyBytes = bodyText === undefined ? new Uint8Array(0) : encoder.encode(bodyText);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const bodyHash = createHash('sha256').update(bodyBytes).digest('hex');
  const canonical = [
    method.toLowerCase(),
    'ecoma-internal-v1',
    `${encoder.encode(path).length}:${path}`,
    `${encoder.encode(timestamp).length}:${timestamp}`,
    `${encoder.encode(nonce).length}:${nonce}`,
    bodyHash,
  ].join('\n');
  const signature = createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
  return {
    'x-ecoma-internal-timestamp': timestamp,
    'x-ecoma-internal-nonce': nonce,
    'x-ecoma-internal-signature': `v1=${signature}`,
  };
}

async function postMessages({ baseUrl, secret, body, idempotencyKey }) {
  const bodyText = JSON.stringify(body);
  const headers = await internalAuthHeaders({
    method: 'POST',
    path: '/v1/messages',
    bodyText,
    secret,
  });
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      ...headers,
    },
    body: bodyText,
  });
  return { status: response.status, json: (await response.json().catch(() => null)) ?? {} };
}

async function triggerCron(baseUrl, cron) {
  // wrangler dev 4.x: POST `/cdn-cgi/local/scheduled?format=json&cron=<encoded>`
  // — POST trần trả 500, query `cron` bắt buộc (05-worker-runtime-e2e.md §4).
  const response = await fetch(
    `${baseUrl}/cdn-cgi/local/scheduled?format=json&cron=${encodeURIComponent(cron)}`,
    { method: 'POST' },
  );
  assert(response.ok, `cron trigger on ${baseUrl} → HTTP ${response.status}`);
  await response.body?.cancel();
}

// ---------------------------------------------------------------------------
// Runtime endpoints — metadata `<entryName>.json` trong stateDir có `argv`
// (chứa `--config <generated>`); port đọc từ `dev.port` của generated config.
// ---------------------------------------------------------------------------

function readRuntimeEndpoints() {
  const endpoints = {};
  if (!existsSync(STATE_DIR)) return endpoints;
  for (const file of readdirSync(STATE_DIR)) {
    if (!file.endsWith('.json')) continue;
    let row;
    try {
      row = JSON.parse(readFileSync(join(STATE_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(row?.argv)) continue;
    const configPath = row.argv[row.argv.indexOf('--config') + 1];
    if (typeof configPath !== 'string' || !existsSync(configPath)) continue;
    let config;
    try {
      // Generated config là JSON.stringify output — parse thẳng được.
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      continue;
    }
    if (typeof config?.dev?.port === 'number' && typeof row.name === 'string') {
      endpoints[row.name] = `http://127.0.0.1:${config.dev.port}`;
    }
  }
  return endpoints;
}

// ---------------------------------------------------------------------------
// .dev.vars — giá trị local-only, file `.dev.vars*` đã .gitignore. Giá trị
// các key bắt buộc đối chiếu config loader của từng app (fail-closed khi
// thiếu): apps/transactional-mail{,-job}/src/config.ts.
// ---------------------------------------------------------------------------

function writeDevVars() {
  const jobVars = [
    'MAIL_PROVIDER_KIND=fake',
    'MAIL_PROVIDER_TIMEOUT_MS=10000',
    'MAIL_JOB_MAX_EXECUTION_ATTEMPTS=4',
    'MAIL_JOB_EXECUTION_LEASE_MS=30000',
    'MAIL_JOB_PROVIDER_CALL_SAFE_WINDOW_MS=3600000',
    'MAIL_JOB_REPORT_LEASE_MS=30000',
    'MAIL_JOB_MAX_REPORT_ATTEMPTS=3',
    'MAIL_JOB_SWEEP_BATCH_LIMIT=10',
    `MAIL_QUARANTINE_HMAC_KEY=${QUARANTINE_KEY_HEX}`,
    // Secret mailer-job dùng ký internal request phải TRÙNG slot
    // SVC_TRANSACTIONAL_MAILER_JOB của control plane — hai biến, một secret.
    `TRANSACTIONAL_MAIL_INTERNAL_AUTH_SECRET=${MAILER_JOB_SECRET}`,
    '',
  ].join('\n');
  const mailVars = [
    // `current` là `<profileTag>.<keyTag>` — use case tách keyTag khỏi profile tag
    // ở dấu `.`; viết `p1` không có keyTag là config sai dang, nổ 500 lúc create.
    `MAIL_FINGERPRINT_KEYRING=${JSON.stringify({ current: 'p1.k1', keys: { 'p1.k1': FINGERPRINT_KEY_HEX } })}`,
    `MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT=${SVC_ACCOUNT_SECRET}`,
    `MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH=${SVC_AUTH_SECRET}`,
    `MAIL_INTERNAL_AUTH_SECRET_SVC_PAYMENT=${SVC_PAYMENT_SECRET}`,
    `MAIL_INTERNAL_AUTH_SECRET_SVC_TRANSACTIONAL_MAILER_JOB=${MAILER_JOB_SECRET}`,
    'MAIL_INTERNAL_AUTH_SKEW_SECONDS=300',
    'MAIL_RATE_LIMIT_PRINCIPAL_LIMIT=100',
    'MAIL_RATE_LIMIT_PRINCIPAL_WINDOW_MS=60000',
    'MAIL_RATE_LIMIT_SYSTEM_LIMIT=1000',
    'MAIL_RATE_LIMIT_SYSTEM_WINDOW_MS=60000',
    'MAIL_RATE_LIMIT_KEY_LIMIT=100',
    'MAIL_RATE_LIMIT_KEY_WINDOW_MS=60000',
    'MAIL_RENDER_MAX_BYTES=65536',
    'MAIL_PUBLISH_LEASE_MS=30000',
    'MAIL_PUBLISH_BATCH_LIMIT=10',
    'MAIL_PUBLISH_MAX_ATTEMPTS=3',
    'MAIL_PUBLISH_BACKOFF_BASE_MS=1000',
    'MAIL_RECONCILER_MAX_AGE_MS=600000',
    'MAIL_RECONCILER_BATCH_LIMIT=10',
    'MAIL_RECOVERY_MAX_CYCLES=2',
    'MAIL_NONCE_PRUNE_BATCH_LIMIT=100',
    'MAIL_RETENTION_CONTENT_MS=2592000000',
    'MAIL_RETENTION_STALE_ALERT_MS=86400000',
    '',
  ].join('\n');
  writeFileSync(join(JOB_APP_DIR, '.dev.vars'), jobVars, 'utf8');
  writeFileSync(join(MAIL_APP_DIR, '.dev.vars'), mailVars, 'utf8');
}

// ---------------------------------------------------------------------------
// Fixture producer worker — config + entrypoint sinh TẠM trong stateDir
// (`<stateDir>/e2e-fixture/`), KHÔNG vào repo. Session fixture không có
// consumer nào cho `ecoma-mail-lifecycle-events`, nên broker của nó forward
// message qua dev-registry `ExternalQueueProxy` sang session mailer-job đang
// consume cùng queue — registry là per-worktree vì orchestration + script cô
// lập HOME/XDG_CONFIG_HOME vào cùng `<persistTo>/.wrangler-home`.
// ---------------------------------------------------------------------------

const FIXTURE_MAIN = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/lifecycle' || request.method !== 'POST') {
      return new Response('not found', { status: 404 });
    }
    const body = await request.json().catch(() => null);
    if (body === null || !Array.isArray(body.messages)) {
      return new Response('shape', { status: 400 });
    }
    for (const message of body.messages) {
      await env.LIFECYCLE.send(typeof message === 'string' ? message : JSON.stringify(message));
    }
    return Response.json({ sent: body.messages.length });
  },
};
`;

async function startFixtureProducer(port) {
  const fixtureDir = join(STATE_DIR, 'e2e-fixture');
  mkdirSync(fixtureDir, { recursive: true });
  const mainPath = join(fixtureDir, 'main.js');
  writeFileSync(mainPath, FIXTURE_MAIN, 'utf8');
  const configPath = join(fixtureDir, 'wrangler.jsonc');
  writeFileSync(
    configPath,
    JSON.stringify({
      name: 'ecoma-mail-e2e-lifecycle-producer',
      main: mainPath,
      compatibility_date: '2026-10-05',
      queues: { producers: [{ queue: 'ecoma-mail-lifecycle-events', binding: 'LIFECYCLE' }] },
      dev: { port },
    }),
    'utf8',
  );
  // Cùng cơ chế cô lập HOME với orchestration (sanitizedWranglerEnv): HOME trỏ
  // vào <persistTo>/.wrangler-home để session này dùng chung dev registry với
  // hai worker mail — đồng thời không thấy token cache wrangler của developer.
  const wranglerHome = join(PERSIST_TO, '.wrangler-home');
  mkdirSync(wranglerHome, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'dev',
      '--config',
      configPath,
      '--persist-to',
      PERSIST_TO,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: wranglerHome,
        USERPROFILE: wranglerHome,
        XDG_CONFIG_HOME: wranglerHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // `detached` cho fixture process group RIÊNG — teardown kill cả group
      // `-pid` (shim + cli.js con nó). Không detached thì group = group của
      // script và kill -pid giết cả script.
      detached: true,
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `fixture producer exited early (code ${child.exitCode}, signal ${child.signalCode}) — last output: ${output.slice(-800)}`,
      );
    }
    try {
      // Worker fixture trả 404 cho mọi route khác /lifecycle — nhận được BẤT
      // KỲ status HTTP nào (kể cả 404) nghĩa là server đã bind và serve.
      const probe = await fetch(`${baseUrl}/__probe`, { signal: AbortSignal.timeout(500) });
      if (probe.status === 404) break;
    } catch {
      // chưa ready — poll tiếp
    }
    if (Date.now() >= deadline) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // group đã chết
      }
      throw new Error(`fixture producer not ready within 60s — last output: ${output.slice(-800)}`);
    }
    await sleep(250);
  }
  return { child, baseUrl, outputText: () => output };
}

/**
 * Kill cả process group của fixture (shim `bin/wrangler.js` + `cli.js` con nó —
 * kill đúng shim chỉ để lộ cli.js thành orphan) rồi verify bằng /proc: chỉ tiêu
 * PID group không còn process nào mang `--persist-to <stateDir>`.
 */
function killFixtureGroup(fixture) {
  const pid = fixture.child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // group đã chết — ESRCH
  }
}

async function stopFixtureProducer(fixture) {
  killFixtureGroup(fixture);
  await pollUntil(
    'fixture producer group exit',
    () => {
      try {
        process.kill(-fixture.child.pid, 0);
        return false;
      } catch {
        return true; // ESRCH — cả group đã chết
      }
    },
    { timeoutMs: 5_000, intervalMs: 100 },
  );
}

/** Chọn một loopback port rảnh rồi trả lại ngay — fixture dùng port khác. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let stepFailed = false;
  let fixture = null;
  try {
    await step('write-dev-vars', () => {
      writeDevVars();
      // .dev.vars mới chỉ đọc lúc wrangler dev spawn (--env-file) — down trước
      // để `up` ở bước sau boot với env vừa ghi. Down idempotent (rows rỗng
      // OK); kept-evidence còn sót từ lần chạy trước thì exit 1 — chấp nhận,
      // `up` tự xử lý alive-guard/port theo metadata còn lại.
      let note;
      try {
        const out = run('pnpm', ['dx', 'local-worker-down']);
        note = out.trim().split('\n').pop();
      } catch (error) {
        note = `prior down kept evidence: ${String(error?.message ?? error).slice(0, 120)}`;
      }
      return note;
    });

    await step('local-worker-up', () => {
      // Sub Directed Boot: CHỈ hai entry mail — E2E của một bounded context
      // không được phụ thuộc build/boot các app khác của repo (account-bridge,
      // pact-broker, push-*): app chưa build làm `up` fail lẻ tẻ, và một app
      // lỗi sẵn của repo không được chắn đường kiểm mail. Thứ tự boot vẫn
      // topological trong tập chọn (control plane trước consumer). List viết
      // comma-separated: citty/node:util collapse flag lặp lại (giá trị cuối
      // thắng), `--entry` lặp hai lần sẽ mất entry đầu một cách âm thầm.
      const out = run('pnpm', [
        'dx',
        'local-worker-up',
        '--entry',
        'transactional-mail,transactional-mailer-job',
      ]);
      assert(
        out.includes('worker transactional-mail ready at') &&
          out.includes('worker transactional-mailer-job ready at'),
        `local-worker-up did not print both entries ready:\n${out}`,
      );
    });

    let endpoints;
    await step('read-endpoints-and-health', async () => {
      endpoints = readRuntimeEndpoints();
      const control = endpoints['transactional-mail'];
      assert(
        typeof control === 'string',
        `missing control plane endpoint: ${JSON.stringify(endpoints)}`,
      );
      assert(
        typeof endpoints['transactional-mailer-job'] === 'string',
        `missing mailer-job endpoint: ${JSON.stringify(endpoints)}`,
      );
      const health = await fetch(`${control}/health`);
      assert(health.ok, `/health control plane → HTTP ${health.status}`);
      await health.body?.cancel();
      return control;
    });

    let created;
    await step('post-messages-403-wrong-principal', async () => {
      const forbidden = await postMessages({
        baseUrl: endpoints['transactional-mail'],
        secret: MAILER_JOB_SECRET,
        body: {
          template: 'account.login-otp',
          recipient: 'user@example.com',
          locale: 'en',
          variables: { code: '12345678' },
        },
        idempotencyKey: `e2e-forbidden-${Date.now()}`,
      });
      assert(
        forbidden.status === 403,
        `signing with the mailer-job secret must be 403 (no message.create), got ${forbidden.status}: ${JSON.stringify(forbidden.json)}`,
      );
    });

    await step('post-messages-201', async () => {
      created = await postMessages({
        baseUrl: endpoints['transactional-mail'],
        secret: SVC_ACCOUNT_SECRET,
        body: {
          template: 'account.login-otp',
          recipient: 'user@example.com',
          locale: 'en',
          variables: { code: '12345678' },
          correlation_id: 'mail-worker-runtime-e2e',
        },
        idempotencyKey: `e2e-create-${Date.now()}`,
      });
      assert(
        created.status === 201,
        `POST /v1/messages (svc.account) → ${created.status}: ${JSON.stringify(created.json)}`,
      );
      assert(
        typeof created.json.delivery_id === 'string' && created.json.delivery_id.startsWith('dlv_'),
        `delivery_id missing or wrong prefix: ${JSON.stringify(created.json)}`,
      );
      return created.json.delivery_id;
    });

    let deliveryId;
    await step('publish-and-consume-sent', async () => {
      deliveryId = created.json.delivery_id;
      await triggerCron(endpoints['transactional-mail'], CRON);
      await pollUntil('mail_outbox published', () => {
        const rows = runD1Sql(
          MAIL_GENERATED_CONFIG,
          'mail',
          `SELECT status FROM mail_outbox WHERE delivery_id = '${deliveryId}'`,
        );
        return rows[0]?.status === 'published';
      });
      // Queue delivery chéo process: message đợi consumer batch — trigger cron
      // consumer tới khi job thể hiện kết quả cuối.
      await pollUntil('mail_jobs sent', async () => {
        await triggerCron(endpoints['transactional-mailer-job'], CRON);
        const rows = runD1Sql(
          JOB_GENERATED_CONFIG,
          'mail-job',
          `SELECT status FROM mail_jobs WHERE delivery_id = '${deliveryId}'`,
        );
        return rows[0]?.status === 'sent';
      });
      const jobRow = runD1Sql(
        JOB_GENERATED_CONFIG,
        'mail-job',
        `SELECT status, provider_message_id FROM mail_jobs WHERE delivery_id = '${deliveryId}'`,
      )[0];
      assert(
        jobRow?.provider_message_id === FAKE_PROVIDER_MESSAGE_ID,
        `provider_message_id must be ${FAKE_PROVIDER_MESSAGE_ID}, got ${JSON.stringify(jobRow)}`,
      );
      // Consumer báo outcome về control plane qua report sweep (cron consumer)
      // — control plane cập nhật `mail_messages.status` sau khi nhận outcome.
      await pollUntil('mail_messages sent', async () => {
        await triggerCron(endpoints['transactional-mailer-job'], CRON);
        const rows = runD1Sql(
          MAIL_GENERATED_CONFIG,
          'mail',
          `SELECT status FROM mail_messages WHERE delivery_id = '${deliveryId}'`,
        );
        return rows[0]?.status === 'sent';
      });
    });

    await step('lifecycle-ingest', async () => {
      fixture = await startFixtureProducer(await findFreePort());

      const eventId = randomUUID();
      const deliveredEvent = JSON.stringify({
        eventId,
        type: 'delivered',
        messageId: FAKE_PROVIDER_MESSAGE_ID,
        occurredAt: Date.now(),
        terminal: true,
      });
      // JSON cắt cụt — normalizer trả `unparseable`, ingest → quarantine.
      const brokenPayload = '{"eventId": "broken"';

      const send = await fetch(`${fixture.baseUrl}/lifecycle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Cùng event hai lần (dedupe) + một payload hỏng (quarantine).
        body: JSON.stringify({ messages: [deliveredEvent, deliveredEvent, brokenPayload] }),
      });
      assert(
        send.ok,
        `fixture publish → HTTP ${send.status}: ${await send.text().catch(() => '')}`,
      );

      await pollUntil('lifecycle rows settle', async () => {
        await triggerCron(endpoints['transactional-mailer-job'], CRON);
        const events = runD1Sql(
          JOB_GENERATED_CONFIG,
          'mail-job',
          `SELECT event_id FROM mail_lifecycle_events WHERE event_id = '${eventId}'`,
        );
        if (events.length !== 1) return false;
        const quarantined = runD1Sql(
          JOB_GENERATED_CONFIG,
          'mail-job',
          `SELECT quarantine_id FROM quarantine WHERE reason = 'lifecycle-event-invalid'`,
        );
        return quarantined.length >= 1;
      });

      const eventRow = runD1Sql(
        JOB_GENERATED_CONFIG,
        'mail-job',
        `SELECT event_type, delivery_id, terminal, reason_token FROM mail_lifecycle_events WHERE event_id = '${eventId}'`,
      )[0];
      assert(
        eventRow?.event_type === 'delivered',
        `event_type must be 'delivered': ${JSON.stringify(eventRow)}`,
      );
      assert(
        eventRow?.delivery_id === deliveryId,
        `delivery_id correlate must be '${deliveryId}', got ${JSON.stringify(eventRow?.delivery_id)}`,
      );
      assert(eventRow?.terminal === 1, `terminal must be 1: ${JSON.stringify(eventRow)}`);
      assert(
        eventRow?.reason_token === null,
        `delivered must not carry a reason token: ${JSON.stringify(eventRow)}`,
      );
      const dupCount = runD1Sql(
        JOB_GENERATED_CONFIG,
        'mail-job',
        `SELECT COUNT(*) AS n FROM mail_lifecycle_events WHERE event_id = '${eventId}'`,
      )[0]?.n;
      assert(dupCount === 1, `dedupe: exactly 1 row for the event_id, got ${dupCount}`);
      return `event ${eventId.slice(0, 8)}… correlated`;
    });

    await step('teardown', async () => {
      if (fixture) {
        await stopFixtureProducer(fixture);
        fixture = null;
      }
      rmSync(join(STATE_DIR, 'e2e-fixture'), { recursive: true, force: true });
      const out = run('pnpm', ['dx', 'local-worker-down']);
      assert(
        (out.match(/terminated/gu) ?? []).length >= 2,
        `down did not report terminated for both entries:\n${out}`,
      );
    });

    await step('no-orphan-processes', async () => {
      // Process của worktree này mang argv `--persist-to <stateDir>` — quét
      // /proc để bám đúng bằng chứng, không đụng worktree khác cùng máy.
      const orphans = [];
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/u.test(entry)) continue;
        try {
          const cmdline = readFileSync(join('/proc', entry, 'cmdline'), 'utf8');
          if (cmdline.includes(PERSIST_TO)) orphans.push(entry);
        } catch {
          // process vừa thoát — bỏ qua
        }
      }
      assert(
        orphans.length === 0,
        `${orphans.length} orphaned process(es) of the worktree remain: ${orphans.join(', ')}`,
      );
      assert(
        !existsSync(join(STATE_DIR, 'transactional-mail.json')) &&
          !existsSync(join(STATE_DIR, 'transactional-mailer-job.json')),
        'stateDir metadata not cleaned up after down',
      );
    });
  } catch (error) {
    stepFailed = true;
    process.stderr.write(
      `${SCRIPT_TAG} FAIL: ${error?.stack ?? String(error)}\n` +
        `${SCRIPT_TAG} steps: ${JSON.stringify(STEP_RESULTS)}\n` +
        (fixture !== null
          ? `${SCRIPT_TAG} fixture last output: ${fixture.outputText().slice(-800)}\n`
          : ''),
    );
  } finally {
    // Fail-closed teardown: mọi nhánh kết thúc đều dọn fixture + runtime để
    // không để lại process sống sau một lần chạy hỏng.
    if (fixture !== null) {
      try {
        killFixtureGroup(fixture);
      } catch {
        // đã chết
      }
    }
    if (stepFailed) {
      try {
        run('pnpm', ['dx', 'local-worker-down']);
      } catch (cleanupError) {
        process.stderr.write(`${SCRIPT_TAG} teardown after failure also failed: ${cleanupError}\n`);
      }
    }
  }

  if (stepFailed) process.exit(1);
  process.stdout.write(`${SCRIPT_TAG} E2E PASS — ${STEP_RESULTS.length} steps passed\n`);
  process.exit(0);
}

await main();
