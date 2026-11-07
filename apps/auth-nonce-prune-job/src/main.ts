/**
 * Composition root của `auth-nonce-prune-job` — cron-trigger Worker dọn nonce hết hạn
 * cho HAI kho nonce của đường nội bộ (`db-auth` + `db-account`), thay GitHub Action
 * `.github/workflows/identity-nonce-prune.yaml` (issue #82).
 *
 * ⚠️ **Chỉ có MỘT entrypoint: `scheduled`.** KHÔNG có `fetch` export — worker này không
 * expose HTTP (wrangler.jsonc không có route, `workers_dev: false`): một HTTP surface là
 * một ranh giới mới cần auth, mà không endpoint nào của nó được định nghĩa trong tài liệu
 * (cùng lập luận với `apps/transactional-mailer-job/src/main.ts`).
 *
 * ⚠️ **KHÔNG `ctx.waitUntil` cho đường chính** — handler `await` trực tiếp: lỗi
 * của handler là status của cron invocation, hiển thị ở Cron dashboard → Past events
 * (docs `runtime-apis/handlers/scheduled/`: "the first waitUntil to fail is observed and
 * recorded"). `waitUntil` sẽ che một lỗi ra khỏi trạng thái invocation.
 *
 * ⚠️ **Hai kho chạy SONG SONG qua `Promise.all`, một kho hỏng KHÔNG cản kho kia**: dùng
 * `Promise.allSettled` để cả hai kết quả (kể cả kết quả thành công và kết quả throw của
 * bên hỏng) đều được khởi tạo trước khi quyết định throw — một bên hỏng không mất kết quả
 * bên kia, và **nếu bất kỳ bên nào throw** thì handler cuối cùng vẫn `throw` để cron đỏ,
 * đúng như hai job đối xứng của workflow cũ (mỗi service một failure unit độc lập, không
 * job gate gộp che được điều đó).
 *
 * ⚠️ Persistence: KHÔNG D1, KHÔNG state cục bộ — tiến độ = dữ liệu thật còn lại trên từng
 * database (cùng bất biến "tiến độ không thể hỏng" của workflow cũ). Một isolate không
 * mang giây nào sang lần chạy sau.
 */

import { Pool } from 'pg';

import {
  pruneTarget,
  type PruneTarget,
  type PruneTargetRun,
} from '@ecoma-io/auth-nonce-prune-job-application';

import { loadPruneJobConfig, PruneJobConfigError, type PruneJobEnv } from './config';

/** Log một dòng JSON (pattern `logAlert` của transactional-mailer-job) — một target/dòng. */
function writeLog(event: Record<string, unknown>): void {
  try {
    // oxlint-disable-next-line no-console
    console.log(JSON.stringify(event));
  } catch {
    // Cố tình im lặng — observability không được nằm trên serving path.
  }
}

/**
 * Adapter một dòng try-retry — hình dạng của `::warning::` trong script cũ, nhưng là JSON
 * một dòng kênh log của Worker (`event=nonce_prune_retry`).
 */
function retryLogger(service: string): (what: string, attempt: number) => void {
  return (what, attempt) => {
    writeLog({
      event: 'nonce_prune_retry',
      service,
      what,
      attempt,
    });
  };
}

/**
 * Pool `pg` của MỘT Hyperdrive binding — pattern `apps/account/server/utils/db.ts`
 * (buildPoolOptions + attachPoolErrorHandler + createPool), nhưng **không import code
 * của account**: job này là một deploy unit riêng, import app→app là vi phạm ranh giới
 * mà tag Nx cấm (`type:composition` chỉ depend lib, không depend app).
 *
 * Con số (i)-(iii) giữ nguyên mốc mà account đã ghim — cùng một Hyperdrive, cùng một
 * driver, không có ngờ nào để hai app chạy hai chế độ pooling khác nhau; nếu một mốc
 * trong ba số này cần đổi, đổi ở **cả hai** app (từ khóa để grep: `idleTimeoutMillis`).
 *
 * (i) `max: 4` — HD9: ~20 origin connection mỗi config (Free) / ~100 (Paid), soft limit;
 *     một isolate Worker mang pool riêng, job làm ít việc, `max: 4` cùng mốc với account.
 * (ii) `idleTimeoutMillis: 600_000` (HD10 — idle timeout Hyperdrive 10 phút) và
 *     `connectionTimeoutMillis: 15_000` (HD10 — initial connect 15s).
 * (iii) **không đặt `ssl`**: Hyperdrive đã TLS tới origin (HD2) và tự quản phần đó —
 * Pattern "sàn TLS ở DSN" của script cũ (`PGSSLMODE=require` được kiểm trên DSN) dời
 * thành **trách nhiệm của config Hyperdrive**: DSN sống ở `connectionString` của
 * binding trong Cloudflare account, provisioned đúng một lần per-env, không phải một
 * giá trị app có thể kiểm hay hạ. Lý do cho nằm ở `01-architecture.md` §6.
 */
function createPoolFor(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 4,
    idleTimeoutMillis: 600_000,
    connectionTimeoutMillis: 15_000,
  });
  // Listener `error` của pool bắt buộc: idle client bị Hyperdrive đóng (HD10) phát
  // `error` trên EventEmitter — không listener là crash isolate. Handler **log redacted
  // rồi nuốt**, không re-throw (cùng hình với `attachPoolErrorHandler` bên account).
  pool.on('error', () => {
    writeLog({ event: 'db_pool.idle_client_error', error_code: 'idle_client_error' });
  });
  return pool;
}

/**
 * Hai cấu hình kho cho một run — identity của mỗi bên là role pruner của chính service
 * (tạo bên migrations `0014` / `0007`), cùng hình dạng `EXPECTED_IDENTITY` mà workflow
 * cũ đã kiểm — giữ nguyên học thuyết bất biến (1) thay bằng đổi principal: sau điểm
 * này DSN dán nhầm service bị chặn ở `identity_mismatch` trước khi một DELETE nào chạy.
 */
function targets(
  dbAuthString: string,
  dbAccountString: string,
): readonly [PruneTarget, PruneTarget] {
  return [
    {
      service: 'auth',
      schema: 'auth',
      expectedIdentity: 'ecoma_auth_nonce_pruner|deletable',
      pool: createPoolFor(dbAuthString),
    },
    {
      service: 'account',
      schema: 'account',
      expectedIdentity: 'ecoma_account_nonce_pruner|deletable',
      pool: createPoolFor(dbAccountString),
    },
  ];
}

/** Kết quả `Promise.allSettled` của một bên — đủ dạng log một dòng JSON. */
function logTargetRun(result: PromiseSettledResult<PruneTargetRun>): void {
  if (result.status === 'fulfilled') {
    const run = result.value;
    writeLog({
      event: 'nonce_prune',
      service: run.service,
      outcome: run.outcome,
      pruned: run.pruned,
      batches: run.batches,
      duration_s: run.duration_s,
      retries: run.retries,
      ...(run.cap === undefined ? {} : { cap: run.cap }),
    });
  } else {
    // Lỗi throw của một kho: ghi một dòng JSON riêng — message của throw từ `pruneTarget`
    // đã mang `service=… outcome=… pruned=… batches=…` đúng shape của dòng lỗi script cũ,
    // nên log giữ nguyên text đó và composition root re-throw sau `allSettled` để cron đỏ
    // đúng người (đọc dòng này không phải nghe run succeeded của kho kia).
    const reason: unknown = result.reason;
    writeLog({
      event: 'nonce_prune_error',
      message: reason instanceof Error ? reason.message : String(reason),
    });
  }
}

/**
 * Handler thật của một run — được `scheduled` gọi, đúng một lần cho mỗi cron tick.
 *
 * ⚠️ Throw rời handler: **bất kỳ** lỗi nào trong hai kho (cap_hit / identity_mismatch /
 * statement_failed / db_unreachable / not_configured) đều phải đỏ run — một repository
 * của job này KHÔNG có "đỏ một nửa thành công".
 */
export async function runOnce(
  env: PruneJobEnv,
  startedAtMs: number,
  ctx?: { waitUntil(promise: Promise<unknown>): void },
): Promise<void> {
  const config = loadPruneJobConfig(env);
  const [authTarget, accountTarget] = targets(
    config.dbAuth.connectionString,
    config.dbAccount.connectionString,
  );
  void ctx;

  // `Promise.allSettled` — một kho throw không cản kho kia chạy, và cả hai kết quả đều
  // được log (kho đỏ cũng có dòng log riêng).
  const [authResult, accountResult] = await Promise.allSettled([
    pruneTarget(authTarget, {
      startedAtMs,
      logRetry: retryLogger('auth'),
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }),
    }),
    pruneTarget(accountTarget, {
      startedAtMs,
      logRetry: retryLogger('account'),
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }),
    }),
  ]);
  logTargetRun(authResult);
  logTargetRun(accountResult);

  // Ném lại lỗi của bất kỳ kho nào — theo thứ tự khai: một kho đỏ với đúng lỗi của kho
  // đó (message throw giữ nguyên shape có `service=…`). **Không** nuốt và **không** gộp
  // thành "outcome tổng" — Cron Past events đỏ với nguyên nhân thật, và hai kho của
  // workflow cũ cũng là hai failure unit độc lập, không job gate gộp nào che.
  for (const rejected of [authResult, accountResult]) {
    if (rejected.status === 'rejected') {
      throw rejected.reason;
    }
  }
}

/**
 * `scheduled()` của platform — adapter mỏng giữa Cron runtime và {@link runOnce}.
 *
 * ⚠️ Object thay vì `export default` một function — cùng lý do với
 * `apps/web-push-notification-job/src/main.ts`: thiếu một entrypoint là một `undefined`
 * ở đây thay vì một Worker deploy chạy nhưng không bao giờ nhận cron tick.
 *
 * ⚠️ KHÔNG `ctx.setAlarm` — cron runtime tự quản re-schedule của nhịp `17 3 * * *` mà
 * wrangler.jsonc khai; handler chỉ cần return/throw.
 */
export default {
  async scheduled(
    controller: { readonly cron: string },
    env: PruneJobEnv,
    ctx?: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void> {
    void controller.cron;
    try {
      await runOnce(env, Date.now(), ctx);
    } catch (error) {
      // Lỗi đã được log đủ ở `runOnce` (dòng JSON một dòng mỗi kho); re-throw để Cron
      // runtime ghi nó là error status của invocation — Past events đỏ theo đúng
      // docs `runtime-apis/handlers/scheduled/`.
      if (error instanceof PruneJobConfigError) {
        // Config thiếu binding: một dòng riêng có tên binding — đủ cho runbook, không
        // cần thêm context nào. `not_configured` không có counters gì để log thêm.
        writeLog({ event: 'nonce_prune_error', outcome: 'not_configured', message: error.message });
      }
      throw error;
    }
  },
};
