import { describe, expect, it } from 'vitest';

import { runNoncePrune } from './mail-nonce-prune';
import type { DeleteExpiredMailNoncesInput } from './internal-nonce-store';

/**
 * Test của prune nonce với fake port.
 *
 * Module này rất ngắn và phần đáng kiểm không nằm ở thuật toán mà ở **hợp đồng biên**: một lô
 * trên mỗi lần gọi, và mốc `expires_at <= nowMs` được chuyển nguyên vẹn xuống port — vì
 * chuyển đổi sai một đơn vị ở đây là mở cửa sổ replay chứ không phải một bug trình bày.
 */

const NOW = 1_800_000_000_000;

function makeHarness(deleted: number): {
  readonly deps: {
    readonly nonces: {
      readonly deleteExpiredNonces: (i: DeleteExpiredMailNoncesInput) => Promise<number>;
    };
  };
  readonly calls: DeleteExpiredMailNoncesInput[];
} {
  const calls: DeleteExpiredMailNoncesInput[] = [];
  return {
    deps: {
      nonces: {
        deleteExpiredNonces: (input: DeleteExpiredMailNoncesInput) => {
          calls.push(input);
          return Promise.resolve(deleted);
        },
      },
    },
    calls,
  };
}

describe('runNoncePrune', () => {
  it('prunes exactly one bounded batch per call and reports what the port deleted', async () => {
    const harness = makeHarness(7);

    const result = await runNoncePrune(harness.deps, { batchLimit: 100, nowMs: NOW });

    expect(result).toEqual({ deleted: 7 });
    expect(harness.calls).toEqual([{ nowMs: NOW, limit: 100 }]);
  });

  it('keeps the epoch-millisecond boundary the protocol computed', async () => {
    // Port này **không** nhận epoch giây (khác với `claimNonce`): biên prune phải là cùng
    // đơn vị với `expires_at`, và việc đổi đơn vị ở đây là xoá sớm hoặc xoá muộn so với mốc
    // mà giao thức đã tính. Xoá sớm là mở cửa sổ replay.
    const harness = makeHarness(0);

    await runNoncePrune(harness.deps, { batchLimit: 10, nowMs: NOW });

    expect(harness.calls[0]?.nowMs).toBe(NOW);
    expect(Number.isInteger(harness.calls[0]?.nowMs)).toBe(true);
  });

  it('is a no-op when the port deletes nothing', async () => {
    const harness = makeHarness(0);

    const result = await runNoncePrune(harness.deps, { batchLimit: 10, nowMs: NOW });

    // Tiến độ là **số hàng đã xoá**, không phải một job "đã xong": `deleted = 0` là một kết
    // quả hợp lệ (không có gì hết hạn), không phải lỗi.
    expect(result).toEqual({ deleted: 0 });
    expect(harness.calls).toHaveLength(1);
  });

  it('leaves the batch unbounded-ness to the port instead of looping here', async () => {
    const harness = makeHarness(3);

    await runNoncePrune(harness.deps, { batchLimit: 25, nowMs: NOW });

    // Một lô một lần gọi: caller (cron) lặp bao nhiêu lần thì bấy nhiêu lô. Vòng lặp ở đây sẽ
    // biến một lần chạy thành việc không có đường dừng trên Worker.
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.limit).toBe(25);
  });

  it('hands a non-positive limit to the port rather than short-circuiting', async () => {
    const harness = makeHarness(0);

    const result = await runNoncePrune(harness.deps, { batchLimit: 0, nowMs: NOW });

    // `limit <= 0` là một no-op hợp lệ và port tự trả `0` **không chạm database** — hành vi đó
    // được giữ ở port để mọi đường quét theo lô có cùng một ngữ nghĩa.
    expect(result).toEqual({ deleted: 0 });
    expect(harness.calls).toEqual([{ nowMs: NOW, limit: 0 }]);
  });
});
