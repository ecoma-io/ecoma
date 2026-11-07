/**
 * Điểm chọn adapter duy nhất cho backoffice.
 *
 * Sau khi phân giải `backofficeDataMode` từ runtime config (fail-closed), module
 * này ánh xạ chế độ sang thực thi adapter. Chỉ có `adapter.ts` được phép:
 * - nạp `mock-adapter` (bằng **dynamic `import()`**) để chọn mock
 * - import `unavailable-adapter` để chọn trạng thái unavailable
 *
 * Ràng buộc: không sử dụng logic suy luận môi trường ở đây; không đọc request;
 * không có nhánh "fallback tự động" khác ngoài fail-closed.
 *
 * ⚠️ **Fixture không còn nằm trong bundle của mọi env.**
 *
 * Trước đây `mock-adapter` được import **tĩnh**, nên `prototype-fixture.ts`
 * (staff/roles/permissions mẫu) được nhúng thẳng vào client bundle của **mọi**
 * môi trường — kể cả production, nơi `backofficeDataMode` = `'disabled'` và
 * fixture không bao giờ được *dùng*. Gating ở đây chặn *dùng* fixture, không
 * chặn *phát bytes fixture tới browser*.
 *
 * Nay mock adapter được nạp bằng **dynamic `import()`** và chỉ trong nhánh
 * `'prototype'`: bundler tách nó thành chunk riêng nên entry bundle của app
 * không còn nhúng fixture, và chunk đó chỉ được yêu cầu khi có một lần đọc dữ
 * liệu thật — tức là **chỉ** ở lane `prototype`. Ở production mọi lần đọc rơi
 * vào adapter unavailable, nên chunk fixture không bao giờ được tải.
 */
import {
  BACKOFFICE_PREVIEW_DATA_MODE,
  BACKOFFICE_REALTIME_DATA_MODE,
  type BackofficeDataMode,
} from './data-mode';
import type {
  AuditEntry,
  BackofficeDataAdapter,
  Permission,
  StaffEntitlementSummary,
  StaffMember,
  SystemRole,
} from './types';
import { createUnavailableBackofficeAdapter } from './unavailable-adapter';
import { createRealBackofficeAdapter } from './real-adapter';

/** Factory adapter: nhận không tham số, trả về adapter đã dựng xong. */
type BackofficeAdapterFactory = () => BackofficeDataAdapter;

/**
 * Adapter của nhánh `'prototype'`.
 *
 * ⚠️ **Mock adapter được nạp bằng dynamic `import()`**, không import tĩnh. Đây
 * là điều kiện để `prototype-fixture.ts` không bị nhúng vào entry bundle của
 * mọi môi trường — xem ghi chú ở JSDoc của file này.
 *
 * `pending` giữ lại promise của lần nạp đầu: ba phương thức đọc dùng chung một
 * module, và nạp lại ở mỗi lần đọc sẽ tạo ra module instance mới (và adapter
 * mới) cho cùng một dữ liệu tất định. Biến này nằm trong **closure** của
 * adapter chứ không ở phạm vi module, nên nó không sống sót giữa các session
 * hay các instance adapter khác nhau.
 */
function createPrototypeBackofficeAdapter(): BackofficeDataAdapter {
  let pending: Promise<BackofficeDataAdapter> | undefined;

  const load = (): Promise<BackofficeDataAdapter> => {
    pending ??= import('./mock-adapter').then((mockModule) =>
      mockModule.createMockBackofficeAdapter(),
    );

    return pending;
  };

  return {
    isPreview: true,

    async listStaff(): Promise<readonly StaffMember[]> {
      return (await load()).listStaff();
    },

    async listRoles(): Promise<readonly SystemRole[]> {
      return (await load()).listRoles();
    },

    async listPermissions(): Promise<readonly Permission[]> {
      return (await load()).listPermissions();
    },

    async listEntitlements(staffId: string): Promise<readonly StaffEntitlementSummary[]> {
      return (await load()).listEntitlements(staffId);
    },

    async listAuditEntries(query: Record<string, string>): Promise<readonly AuditEntry[]> {
      return (await load()).listAuditEntries(query);
    },
  };
}

/**
 * Bảng factory theo chế độ dữ liệu — seam cho workstream B: khi backend thật có
 * mặt, một mode mới (ví dụ `'realtime'`) sẽ vào đây dưới dạng một entry mới trỏ
 * vào factory thật thay vì để mode đó rơi về unavailable.
 *
 * ⚠️ **Bảng này được compiler kiểm tra, không phải `as unknown as`.**
 *
 * `satisfies Readonly<Record<BackofficeDataMode, ...>>` bắt buộc literal khớp
 * *đúng* tập khoá của `BackofficeDataMode`: thêm một mode mới vào
 * `data-mode.ts` mà quên khai factory cho nó là **lỗi compile** (thiếu khoá),
 * và khai thừa một khoá ngoài union cũng là **lỗi compile** (khoá lạ). Cách
 * cũ (`as unknown as Readonly<Record<...>>`) tắt đúng cái kiểm tra đó: mode
 * mới rơi xuống unavailable mà **không có tín hiệu nào** ở compile time.
 *
 * ⚠️ **Hai khai báo cùng một bảng, và sự bất đối xứng giữa chúng là có chủ đích.**
 *
 * - `satisfies` là **bằng chứng compile-time** rằng bảng phủ đủ mọi mode.
 * - Chú thích kiểu `Partial<...>` là **hình dạng runtime** của phép tra cứu:
 *   `createBackofficeAdapter` là API công khai của barrel, nên một mode nằm
 *   ngoài union (gọi sai từ JavaScript, hoặc union ở `data-mode.ts` vừa được
 *   mở rộng) phải rơi về unavailable chứ không được ném `TypeError`. Fail-closed
 *   là **hành vi**, không chỉ là kiểu — nên phép tra cứu phải chịu được giá trị
 *   lạ, còn tính đầy đủ của bảng thì do `satisfies` canh.
 *
 * ⚠️ Ngữ nghĩa fail-closed KHÔNG đổi: **chỉ `'prototype'` mở mock**, mọi mode
 * khác — kể cả `'unavailable'` — đều trả adapter không phục vụ dữ liệu.
 *
 * ⚠️ **Khoá `'prototype'` dùng hằng `BACKOFFICE_PREVIEW_DATA_MODE`, còn khoá
 * `'unavailable'` dùng literal** — và sự bất đối xứng đó là cố ý: `data-mode.ts`
 * khai `BACKOFFICE_PREVIEW_DATA_MODE` là hằng có tên, còn `'unavailable'` được
 * khai là **literal trong chính union kiểu** (`typeof BACKOFFICE_PREVIEW_DATA_MODE
 * | 'unavailable'`) vì nó là *trạng thái* fail-closed chứ không phải giá trị cấu
 * hình. Không có hằng nào để tham chiếu. Đổi giá trị hằng `'prototype'` ở
 * `data-mode.ts` vẫn là lỗi type ở đây (union đổi theo, `satisfies` bắt);
 * đổi `'unavailable'` cũng vậy — union đổi thì bảng phải khai lại.
 */
const ADAPTER_FACTORIES: Readonly<Partial<Record<BackofficeDataMode, BackofficeAdapterFactory>>> = {
  [BACKOFFICE_PREVIEW_DATA_MODE]: createPrototypeBackofficeAdapter,
  [BACKOFFICE_REALTIME_DATA_MODE]: createRealBackofficeAdapter,
  unavailable: createUnavailableBackofficeAdapter,
} satisfies Readonly<Record<BackofficeDataMode, BackofficeAdapterFactory>>;

/**
 * Dựng adapter theo chế độ đã phân giải.
 *
 * @param mode Chế độ do `resolveBackofficeDataMode` trả về (fail-closed).
 * @returns Adapter phục vụ dữ liệu chỉ khi `mode` là `'prototype'`; mọi chế độ
 *          khác — và mọi giá trị ngoài tập mode hợp lệ — trả adapter
 *          unavailable, tức mọi lần đọc bị reject với mã lỗi ổn định.
 */
export function createBackofficeAdapter(mode: BackofficeDataMode): BackofficeDataAdapter {
  // Tra cứu trong bảng, thiếu thì fallback, rồi **gọi factory một lần** —
  // một biến trung gian cho phép gán `createUnavailableBackofficeAdapter` (không
  // gọi sẵn) làm fallback, nhờ đó không có ngoặc nào nhầm cặp thứ tự gọi.
  const factory = ADAPTER_FACTORIES[mode] ?? createUnavailableBackofficeAdapter;

  return factory();
}
