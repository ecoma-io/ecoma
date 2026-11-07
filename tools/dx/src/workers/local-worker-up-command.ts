import { defineCommand } from 'citty';

import {
  requireDirectoryRoot,
  runLocalCommandAsync,
  workerWorktreeRootArg,
} from './../local-runtime/local-commands.js';
import { startWorkerRuntime, statusWorkerRuntime } from './worker-orchestration.js';

/**
 * Chuẩn hoá giá trị `--entry` về mảng hoặc undefined để truyền thẳng
 * `entryFilter` (undefined = boot toàn bộ runtime).
 *
 * Citty parse qua `node:util.parseArgs` (strict:false) — flag string LẶP LẠI
 * bị COLLAPSE, giá trị cuối thắng (`--entry a --entry b` → `'b'`, không
 * bao giờ là array). Vì vậy list nhiều entry phải viết comma-separated:
 * `--entry transactional-mail,transactional-mailer-job`. Đã đo được hiện
 * tượng collapse này trên wrangler/citty của repo (node 24.20.0).
 */
function readEntryFilterArg(entry: string | string[] | undefined): string[] | undefined {
  if (entry === undefined) return undefined;
  const raw = Array.isArray(entry) ? entry : [entry];
  const names = raw.flatMap((value) => value.split(',')).map((value) => value.trim());
  const filtered = names.filter((value) => value.length > 0);
  return filtered.length > 0 ? filtered : undefined;
}

/**
 * Entry `pnpm dx local-worker-up`.
 *
 * Bring up WORKER runtime của worktree — mọi app ecoma OPT-IN qua marker
 * `apps/<dir>/local-worker.jsonc` (PR6 discovery): scan các app có marker,
 * đọc ready tường minh trong marker, suy topology (service binding + queue
 * producer/consumer), rồi từng process `wrangler dev` boot theo thứ tự
 * topological. Runtime chia sẻ `--persist-to` theo worktree; migration D1
 * local chạy trước khi spawn.
 *
 * Hành vi process-quan-trọng: `startWorkerProcess` spawn worker DETACHED
 * (process group riêng) — sau khi lệnh này exit 0, process tree (`wrangler
 * dev` + `workerd`) TIẾP TỤC SỐNG và dịch HTTP trên các port đã in. Lệnh
 * `local-worker-down` tắt chúng. Đây là thiết kế có chủ ý: CLI chỉ là điểm
 * điều khiển, không phải process manager giữ process con bằng Lifecycle.
 *
 * Readiness trước khi in "ready" — KHAI TRONG MARKER, không suy từ config
 * wrangler (OCR bug-critical trên PR #69: inference `workers_dev`/`queues`
 * làm queue-only worker không khai `workers_dev` bị poll `/health` 60s
 * timeout): `readiness: 'http-health'` → poll `GET /health` 2xx (poll
 * ≤250ms, timeout 60s); `readiness: 'log-banner'` → chờ boot banner wrangler
 * (`/Ready on http/`) ra stdout/stderr. Không đạt → error fail-closed,
 * exitCode 1; process vừa spawn được stop (metadata chỉ remove khi process
 * được chứng minh chết).
 *
 * Partial-runtime khi fail (OCR PR #36 medium): `startWorkerRuntime` chỉ
 * teardown entry vừa fail — entry đã boot thành công trước đó VẪN SỐNG.
 * Lệnh dò lại qua `statusWorkerRuntime` và in cảnh báo tường minh kèm
 * hướng dẫn `local-worker-down`, để caller không tưởng "không gì chạy" trong
 * khi process vẫn giữ port + persist dir.
 *
 * Runtime với 0 entry (OCR round-2 finding F6): warn trên stderr ("no worker
 * apps found" + điều kiện opt-in) và VẪN exit 0 — không có gì sống là một
 * trạng thái hợp lệ, không phải lỗi process; chỉ misconfig tiềm ẩn (marker
 * gõ sai tên, app dir rename) cần được nhìn thấy.
 */
export default defineCommand({
  meta: {
    name: 'local-worker-up',
    description:
      'Bring up the local worker runtime for discovered apps (apps/*/local-worker.jsonc opt-in marker) of this worktree',
  },

  args: {
    'worktree-root': workerWorktreeRootArg,
    entry: {
      type: 'string',
      description:
        'Boot only these app dirs, comma-separated: --entry transactional-mail,transactional-mailer-job. ' +
        'Boot order stays topological within the selection; unknown name fails closed',
      required: false,
    },
  },

  run({ args }) {
    process.exitCode = 0;
    // Async boundary — orchestration là async; error policy `[local-<cmd>] ...`
    // + exit 1 nằm một nơi duy nhất (`runLocalCommandAsync`).
    void runLocalCommandAsync('worker-up', async () => {
      const worktreeRoot = requireDirectoryRoot(args['worktree-root']) ?? process.cwd();
      try {
        const entryFilter = readEntryFilterArg(args.entry);
        const runtime = await startWorkerRuntime({ worktreeRoot, entryFilter });
        // EXIT TƯỜNG MINH sau khi xong: CLI này spawn worker DETACHED (thiết kế
        // có chủ ý — CLI là điểm điều khiển, không phải process manager), và
        // orchestration release stdout/stderr của worker bằng destroy()
        // best-effort. destroy() thỉnh thoảng không đóng được hết handle read-end
        // (đo được 2026-10-24: CLI in đủ output "runtime up" rồi treo idle
        // epoll-vô-hạn vì còn handle ref — flake theo timing, không phải logic),
        // event loop không drain và process không bao giờ exit. `process.exit`
        // cắt đúng điểm này: mọi output đã flush qua console.log (write sync với
        // pipe), worker detached không bị ảnh hưởng. Không dùng cho status/down —
        // hai lệnh đó không giữ pipe của process con.
        process.stdout.write('', () => {
          process.exit(process.exitCode ?? 0);
        });
        if (runtime.workers.length === 0) {
          // 0 entry discovered (OCR round-2 finding F6): gần như luôn là
          // misconfig (marker gõ sai tên `local-worker.jsonc`, app dir bị
          // rename, `apps/` không quét được) — nếu im lặng thì developer thất
          // bại dạng "thành công âm thầm". Warn trên stderr để quan sát được,
          // vẫn exit 0: "không có gì sống" là trạng thái hợp lệ của runtime,
          // không phải lỗi process (JSDoc discovery cam kết hành vi này).
          console.warn(
            '[local-worker-up] no worker apps found — an app joins the local runtime only when it declares both ' +
              "'apps/<dir>/wrangler.jsonc' and the marker 'apps/<dir>/local-worker.jsonc'",
          );
        }
        for (const worker of runtime.workers) {
          console.log(
            `worker ${worker.entryName} ready at http://127.0.0.1:${worker.port}/ (pid ${worker.pid})`,
          );
        }
        console.log(
          `worker runtime up (namespace ${runtime.namespace}, persist ${runtime.persistTo})`,
        );
      } catch (error) {
        console.error(
          `[local-worker-up] ${error instanceof Error ? error.message : String(error)}`,
        );
        // Báo partial runtime: entry đã boot thành công trước điểm fail vẫn
        // sống — caller phải biết để down hoặc tránh UP lần nữa trôi port.
        const alive = statusWorkerRuntime({ worktreeRoot }).filter(
          (row) => row.state === 'alive' && row.standard,
        );
        if (alive.length > 0) {
          console.error(
            `[local-worker-up] partial runtime still up: ` +
              `${alive.map((row) => `${row.name} (pid ${row.pid})`).join(', ')} — ` +
              "run 'pnpm dx local-worker-down'",
          );
        }
        process.exitCode = 1;
      }
    });
  },
});
