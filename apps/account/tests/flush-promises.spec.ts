/**
 * `flushPromises` của harness phải chờ cả **macrotask**, không chỉ microtask.
 *
 * Nhiều chuỗi async thật resolve qua timer (adapter gọi mạng, `await` nhiều tầng
 * có `setTimeout` xen giữa). Nếu flush chỉ chạy `nextTick` thì assertion chạy
 * trên trạng thái cũ — test xanh nhầm hoặc flaky tùy máy.
 *
 * ⚠️ Timer phải được đăng ký **trước** khi gọi `flushPromises`: cả hai cùng delay
 * 0 nên node chạy theo thứ tự đăng ký; đăng ký sau thì flush (đang chờ timer của
 * chính nó) có thể xong trước timer cần đo, và khẳng định sai về phía ngược lại.
 */
import { describe, expect, it } from 'vitest';

import { flushPromises } from './harness';

describe('flushPromises', () => {
  it('waits for work scheduled on a timer, not only microtasks', async () => {
    let settled = false;
    setTimeout(() => {
      settled = true;
    }, 0);

    await flushPromises();

    expect(settled).toBe(true);
  });

  it('waits through a promise chain that hops onto a timer', async () => {
    let stage = 0;
    void (async () => {
      await Promise.resolve();
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      stage = 1;
    })();
    // Để chuỗi chạy tới khi đăng ký timer của nó trước khi `flushPromises` đăng
    // ký timer của chính mình — hai timer cùng delay 0 chạy theo thứ tự đăng ký,
    // nên nếu flush đăng ký trước thì nó xong trước và khẳng định sai.
    await Promise.resolve();

    await flushPromises();

    expect(stage).toBe(1);
  });
});
