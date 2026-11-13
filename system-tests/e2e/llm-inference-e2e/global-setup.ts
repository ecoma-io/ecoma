/**
 * Readiness gate fail-closed của suite E2E inference (06-testing.md §2): lane
 * CHƯA sẵn sàng là suite ĐỎ với evidence, KHÔNG BAO GIỜ skip.
 *
 * Gate probe TỪ TRONG platform network (PostgreSQL/worker/mock không publish
 * cổng ra host — invariant platform): container ephemeral probe /health →
 * /ready của worker. Retry budget dành cho "chưa xong nhưng sẽ xong" (worker
 * boot, /ready 503 lần đầu). Readiness của MOCK — vốn cần credential UPSTREAM
 * mà suite cố ý không giữ — đã được gate bởi `test-lane-up` (waiter trong
 * network, dependency target của `system-test`); kịch bản (f) chứng minh lại
 * `auth=ok` qua log mock trên đường serving thật.
 */

import { probeReadinessOnce } from './support/lane.mts';

/** Budget chờ lane sẵn sàng — dư cho /ready probe Hyperdrive lần đầu. */
const READY_BUDGET_MS = 180_000;
/** Nhịp poll giữa các lần probe — nhẹ hơn là spam docker run. */
const POLL_INTERVAL_MS = 2_000;

export default async function globalSetup(): Promise<void> {
  const deadline = Date.now() + READY_BUDGET_MS;
  while (Date.now() < deadline) {
    let verdict: 'ready' | 'not-ready';
    try {
      verdict = probeReadinessOnce();
    } catch (error) {
      // docker run không chạy được (daemon chết, network mất) — không phải
      // "chưa sẵn sàng": fail ngay, retry không cứu được.
      throw new Error(
        `readiness probe could not run: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (verdict === 'ready') {
      console.error(
        '[llm-inference-e2e] lane is serving: worker /health + /ready answer inside the network (mock readiness was gated by test-lane-up)',
      );
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, POLL_INTERVAL_MS);
    });
  }
  throw new Error(
    `lane did not become ready within ${String(READY_BUDGET_MS / 1000)}s (worker /health and /ready never answered together inside the network) — inspect docker logs of the worker before re-running`,
  );
}
