/**
 * `401` **trước mọi lookup**, đo bằng cách đếm lệnh D1 thật (`apps/push-notification/tests/integrations/d1-harness.ts`).
 *
 * ⚠️ **Vì sao file này gọi `main.ts` thật chứ không chỉ gọi `authenticateRuntimeCaller`.** Yêu cầu
 * của §8.1 là về **thứ tự**: xác thực phải xảy ra trước khi route chạm storage. Một test gọi
 * `authenticateRuntimeCaller` không đo được thứ tự đó — nó chỉ đo hàm xác thực, và một route
 * xác thực **sau** khi đã đọc D1 vẫn làm mọi test đó xanh. Chỉ một cách đo được: chạy route
 * thật với một D1 thật đã đếm lệnh, rồi khẳng định **số lệnh bằng 0**.
 *
 * ⚠️ **Số lệnh bằng 0 là khẳng định mạnh hơn `401` đúng.** Vì Cloudflare không phân biệt
 * Service Binding với Internet (`docs/architecture/04-platform-facts.md`), route `/internal/**`
 * reachable từ Internet; nếu route đọc D1 trước khi xác thực thì thời gian trả lời phụ thuộc
 * `delivery_id` có tồn tại hay không — đó là oracle đo một định danh có thật, và §8.1 cấm.
 *
 * ⚠️ **Cấu hình ở đây là bộ hoàn chỉnh, không rút gọn.** `pushConfig` fail-closed khi thiếu bất kỳ
 * biến bắt buộc nào, nên một env thiếu sẽ ra `503` chứ không ra `401` — và một `503` ở đây là
 * dấu hiệu fixture sai, không phải hành vi auth. Vì vậy sáu tham số SLA ở đây là **giá trị test
 * do harness chọn** (không phải giá trị SLA đã chốt — sáu tham số đó vẫn là launch gate ở
 * `03-operations.md` §11 và không có giá trị nào trong production cho tới khi service owner +
 * business owner chốt).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetConfigCacheForTest } from '../../src/config';

import { createTestDatabase, seedScope, type TestDatabase } from './d1-harness';
import { callRaw, callRoute, callRuntimeClaim } from './app-env';

/**
 * ⚠️ Env đầy đủ và `worker.fetch` nằm ở `app-env.ts` và **không** copy ở đây: sáu tham số SLA là
 * giá trị test do harness chọn và phải thỏa `assertConfigCoherence`, nên một bản copy thứ hai
 * là một cơ hội để hai test lệch nhau mà không ai thấy (và `inventory-routes.spec.ts` dùng chung
 * đúng bộ đó). `resetConfigCacheForTest` vẫn được gọi ở đây: `pushConfig` cache ở module scope
 * theo **isolate** (`config.ts`), và vitest chạy một file test trong một isolate — không xoá cache
 * thì test đổi env sẽ đọc config của test trước và **xanh sai**.
 */

describe('401 before the lookup — private delivery runtime API', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    resetConfigCacheForTest();
    db = await createTestDatabase();
    await seedScope(db);
    db.probe.reset();
  });

  afterEach(async () => {
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
    // ⚠️ `pushConfig` cache ở module scope theo **isolate** (`config.ts`), và vitest chạy một
    // file test trong một isolate. Không xoá cache thì test đổi env sẽ đọc config của test trước
    // — và sẽ xanh sai.
    resetConfigCacheForTest();
  });

  it('does not touch D1 for a claim with no auth headers at all', async () => {
    const response = await callRuntimeClaim(db, 'deliv', {});

    expect(response.status).toBe(401);
    // ⚠️ Khẳng định cốt lõi: **không một** lệnh D1 nào. `db.probe.executed()` tính cả `exec`,
    // `run`, `all`, `first`; `prepared()` tính cả `prepare` chưa chạy.
    expect(db.probe.executed()).toBe(0);
    expect(db.probe.prepared()).toBe(0);
    expect(db.probe.batches()).toBe(0);
  });

  it.each([
    [
      'a wrong shared secret',
      { authorization: 'wrong', 'x-ecoma-principal': 'svc.web-push-notification-job' },
    ],
    ['a wrong principal', { authorization: 'runtime-secret', 'x-ecoma-principal': 'attacker' }],
    [
      'a correct secret with the principal of a different service',
      { authorization: 'runtime-secret', 'x-ecoma-principal': 'backoffice' },
    ],
    ['only the shared secret', { authorization: 'runtime-secret' }],
    ['only the principal', { 'x-ecoma-principal': 'svc.web-push-notification-job' }],
    // ⚠️ **Hai case dưới đây là bằng chứng rằng runtime boundary đọc secret NGUYÊN VĂN.** Cả ba
    // boundary đều nhận `authorization`, nên chỉ so sánh *header nào* sẽ không phân biệt được
    // chúng — điều phân biệt là **cách đọc giá trị**: Admin/Application API bóc `Bearer `, còn
    // runtime API so sánh thẳng (§8.1). Nếu `requireRuntime` vô tình dùng `authenticateBearer`
    // thì hai case này **thành công** và chỉ đỏ khi test bị xoá. Vì vậy tên case nêu rõ điều
    // kiện thay vì nói chung chung "bearer token".
    [
      'the Admin bearer token, which shares the Authorization header but not its semantics',
      { authorization: 'Bearer admin-token', 'x-ecoma-principal': 'svc.web-push-notification-job' },
    ],
    [
      'a Bearer-prefixed secret, rejected because the runtime secret is raw',
      {
        authorization: 'Bearer runtime-secret',
        'x-ecoma-principal': 'svc.web-push-notification-job',
      },
    ],
  ])('does not touch D1 for %s', async (_label, headers) => {
    const response = await callRuntimeClaim(db, 'deliv', headers);

    expect(response.status).toBe(401);
    expect(db.probe.executed()).toBe(0);
    expect(db.probe.prepared()).toBe(0);
  });

  it('returns the same 401 body regardless of how the caller failed', async () => {
    // ⚠️ Một response phân biệt "thiếu header" với "sai secret" là một oracle đo lời gọi đó đã
    // thử gì. Ba request dưới đây thất bại theo ba cách khác nhau và phải cho **cùng** một body.
    const bodies = await Promise.all([
      callRuntimeClaim(db, 'deliv', {}).then((r) => r.text()),
      callRuntimeClaim(db, 'deliv', { authorization: 'wrong' }).then((r) => r.text()),
      callRuntimeClaim(db, 'deliv', {
        authorization: 'runtime-secret',
        'x-ecoma-principal': 'nope',
      }).then((r) => r.text()),
    ]);

    expect(new Set(bodies).size).toBe(1);
    // Body không nêu boundary nào (`/internal/**` có tồn tại phải là thông tin mà một caller
    // không hợp lệ không dò được từ thông điệp lỗi).
    expect(bodies[0]).not.toContain('internal');
    expect(bodies[0]).not.toContain('runtime');
    expect(JSON.parse(bodies[0])).toEqual({
      error: 'unauthorized',
      detail: 'Thiếu hoặc sai thông tin xác thực.',
    });
  });

  it('touches D1 once the caller is authenticated — proving the probe can see a lookup', async () => {
    // ⚠️ **Phần quan trọng nhất của file.** Nếu không có test này thì các test "0 lệnh" ở trên
    // cũng xanh với một probe hỏng — một probe không đếm gì sẽ cho `0` cho **mọi** request.
    // Test này chứng minh probe nhìn thấy một lần chạm D1 thật, nên `0` ở trên là một khẳng
    // định có ý nghĩa chứ không phải một con số tình cờ.
    const response = await callRuntimeClaim(db, 'deliv', {
      authorization: 'runtime-secret',
      'x-ecoma-principal': 'svc.web-push-notification-job',
    });

    // Delivery seeded ở `pending`, còn claim predicate chỉ nhận `queued`, nên use case trả `409`.
    // Điều cần khẳng định ở đây là nó **đã** đọc D1 — status cụ thể không quan trọng.
    expect(response.status).not.toBe(401);
    expect(db.probe.executed()).toBeGreaterThan(0);
  });

  it('answers 401 for a nonexistent delivery with a bad secret, identically to a real one', async () => {
    // ⚠️ Đây là oracle của §8.1: nếu `deliv` (có thật) và `deliv-does-not-exist` (không có) cho
    // hai status khác nhau khi secret sai, thì endpoint đang đo sự tồn tại của `delivery_id`.
    const badSecret = {
      authorization: 'wrong',
      'x-ecoma-principal': 'svc.web-push-notification-job',
    };
    const existing = await callRuntimeClaim(db, 'deliv', badSecret);
    const missing = await callRuntimeClaim(db, 'deliv-does-not-exist', badSecret);

    expect(existing.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(await existing.text()).toBe(await missing.text());
  });
});

describe('401 before the lookup — Admin API and Application API', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    resetConfigCacheForTest();
    db = await createTestDatabase();
    await seedScope(db);
    db.probe.reset();
  });

  afterEach(() => {
    resetConfigCacheForTest();
  });

  it.each([
    ['an Admin list with no Authorization header', '/admin/v1/providers', 'GET', {}],
    [
      'an Admin list with a wrong bearer token',
      '/admin/v1/providers',
      'GET',
      { authorization: 'Bearer nope' },
    ],
    [
      'an Admin list with the runtime shared secret as a bearer token',
      '/admin/v1/providers',
      'GET',
      { authorization: 'Bearer runtime-secret' },
    ],
    [
      'an Admin list with the Application token',
      '/admin/v1/providers',
      'GET',
      { authorization: 'Bearer application-token' },
    ],
    [
      'an Admin list with a Basic header',
      '/admin/v1/providers',
      'GET',
      { authorization: 'Basic YWRtaW46YWRtaW4=' },
    ],
  ])('does not touch D1 for %s', async (_label, path, method, headers) => {
    const response = await callRaw(db, path, method, headers);

    expect(response.status).toBe(401);
    expect(db.probe.executed()).toBe(0);
    expect(db.probe.prepared()).toBe(0);
  });

  it('does not touch D1 for an unauthenticated POST /v1/notifications', async () => {
    const response = await callRoute(
      db,
      '/v1/notifications',
      {},
      { method: 'POST', body: { app: 'ecoma-io' } },
    );

    expect(response.status).toBe(401);
    expect(db.probe.executed()).toBe(0);
    expect(db.probe.prepared()).toBe(0);
  });

  it('does not touch D1 for an unauthenticated subscription route', async () => {
    const response = await callRoute(
      db,
      '/v1/subscriptions',
      {},
      { method: 'POST', body: { app: 'ecoma-io' } },
    );

    expect(response.status).toBe(401);
    expect(db.probe.executed()).toBe(0);
  });

  // ⚠️ Sáu route inventory dùng CHUNG một `requireAuth` (`main.ts`), nên về nguyên tắc chỉ cần
  // một test trên một route để chứng minh callback đó xác thực trước mọi lookup. Nhưng test ở
  // đây đi trên **từng** route vì một lý do khác: một route quên gọi `requireAuth` sẽ trả `404`
  // (không có route) hoặc `400` (thiếu body), và `expect(401)` bắt được ngay. Đủ ba hình dạng
  // request — `POST` có body, `GET` không body, `DELETE`/`PATCH` có path param — để một route
  // quên auth không trượt khỏi bộ test.
  it.each([
    ['device registration', '/v1/devices', 'POST', { app: 'ecoma-io' }],
    ['device read', '/v1/devices/device-ecoma-io', 'GET', undefined],
    ['device revoke', '/v1/devices/device-ecoma-io', 'DELETE', undefined],
    ['subscription update', '/v1/subscriptions/sub-ecoma-io', 'PATCH', { status: 'disabled' }],
    ['subscription unregister', '/v1/subscriptions/sub-ecoma-io', 'DELETE', undefined],
  ])('does not touch D1 for an unauthenticated %s request', async (_label, path, method, body) => {
    const response = await callRoute(
      db,
      path,
      {},
      {
        method,
        ...(body === undefined ? {} : { body }),
      },
    );

    expect(response.status).toBe(401);
    expect(db.probe.executed()).toBe(0);
    expect(db.probe.prepared()).toBe(0);
  });

  it('answers 401 for an inventory route with the Admin token, before touching D1', async () => {
    // ⚠️ Admin token và Application token cùng đi trong `Authorization`; chỉ **cách đọc giá
    // trị** phân biệt chúng (`Bearer` + principal, §8.2). Nếu Application API chấp nhận admin
    // token thì Backoffice sẽ quản lý được namespace của một application — đúng loại vi phạm
    // mà ba boundary tách biệt ở §8.1 sinh ra để chặn.
    const response = await callRoute(
      db,
      '/v1/devices',
      { authorization: 'Bearer admin-token' },
      { method: 'POST', body: { device_id: 'd1', user_id: 'u1' } },
    );

    expect(response.status).toBe(401);
    expect(db.probe.executed()).toBe(0);
  });

  it('touches D1 for an authenticated device read — proving the inventory routes use the same boundary', async () => {
    // ⚠️ Positive control cho nhóm test 401 ở trên: nếu probe hỏng thì mọi `toBe(0)` ở đó vẫn
    // xanh, nên phải có ít nhất một request đã xác thực và **thật sự** đọc D1 trong cùng bộ
    // fixture. `GET` trên một `device_id` không tồn tại vẫn đọc D1 (tra cứu rồi mới kết luận
    // `404`), nên `404` cũng chứng minh được — nhưng assertion ở đây dùng `404` thay vì chấp
    // nhận mọi status ≠ 401 để không phụ thuộc vào seed.
    const response = await callRoute(db, '/v1/devices/device-does-not-exist', {
      authorization: 'Bearer application-token',
    });

    expect(response.status).toBe(404);
    expect(db.probe.executed()).toBeGreaterThan(0);
  });

  it('touches D1 for an authenticated Admin list — proving the probe sees that boundary too', async () => {
    // ⚠️ `?app=` là bắt buộc: route trả `400` nếu thiếu, và `400` đó **không** chứng minh
    // được gì. Assertion này vì vậy dùng một URL mà use case thật sự đọc D1.
    const response = await callRaw(db, '/admin/v1/providers?app=ecoma-io', 'GET', {
      authorization: 'Bearer admin-token',
    });

    expect(response.status).toBe(200);
    expect(db.probe.executed()).toBeGreaterThan(0);
  });

  it('rejects an Admin token on the Application API before reading the body', async () => {
    // ⚠️ `app` **derive từ principal đã xác thực** (§8.2), không lấy từ body. Nếu route đọc body
    // trước khi xác thực thì một caller không hợp lệ điều khiển được việc parse — và lỗi parse
    // (`400`) sẽ đến trước lỗi quyền (`401`), lộ ra rằng body đã được đọc.
    const response = await callRoute(
      db,
      '/v1/notifications',
      { authorization: 'Bearer admin-token' },
      {
        method: 'POST',
        body: { app: 'other-app', recipient: 'user', notification: { title: 't', body: 'b' } },
      },
    );

    expect(response.status).toBe(401);
    expect(db.probe.executed()).toBe(0);
  });
});
