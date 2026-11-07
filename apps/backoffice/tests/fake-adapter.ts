/**
 * Adapter fake cho test lớp async data-state: mỗi lần gọi trả một `Promise` mà
 * **test** quyết định lúc nào settle, chứ không phải thời gian hay mạng.
 *
 * ⚠️ Vì sao không dùng `setTimeout`/`await sleep()` để mô phỏng "adapter chậm":
 * một `sleep` chỉ làm test chậm và vẫn phụ thuộc scheduler của máy chạy. Deferred cho
 * phép test **quan sát trạng thái `loading` trước khi request xong** một cách xác
 * định — điều mà một mock resolve ngay không thể hiện được, và cũng là điều kiện để
 * khẳng định "loading không bị render như kết quả hoàn tất".
 *
 * ⚠️ Vì sao không thêm option `failure`/`latency` vào `createMockBackofficeAdapter`:
 * adapter mock là **dữ liệu prototype**, không phải test double. Nhồi hook lỗi vào nó
 * là để test điều khiển implementation của production.
 *
 * Dữ liệu mặc định lấy từ `PROTOTYPE_DATA` để test nào không quan tâm nội dung vẫn
 * chạy trên fixture thật; test nào cần tập rỗng hoặc giá trị riêng thì truyền vào.
 */
import type {
  AuditEntry,
  BackofficeDataAdapter,
  Permission,
  StaffEntitlementSummary,
  StaffMember,
  SystemRole,
} from '../app/backoffice-data/types';
import { PROTOTYPE_DATA } from '../app/backoffice-data/prototype-fixture';

/** Một lần gọi adapter, chưa settle cho tới khi test gọi `resolve`/`reject`. */
export type FakeCall<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
};

export type FakeBackofficeAdapter = {
  readonly adapter: BackofficeDataAdapter;
  /**
   * Các lần gọi theo thứ tự — `staffCalls[0]` là lần gọi `listStaff()` đầu tiên.
   *
   * ⚠️ Mảng **mutable** và test sở hữu nó: nó là sổ ghi của một test duy nhất, không
   * phải state chia sẻ. `readonly` ở đây chỉ làm mọi assertion phải đi qua một bản
   * sao.
   */
  readonly staffCalls: FakeCall<readonly StaffMember[]>[];
  readonly rolesCalls: FakeCall<readonly SystemRole[]>[];
  readonly permissionsCalls: FakeCall<readonly Permission[]>[];
  readonly entitlementsCalls: FakeCall<readonly StaffEntitlementSummary[]>[];
  readonly auditEntriesCalls: FakeCall<readonly AuditEntry[]>[];
  /** Resolve mọi lần gọi (kể cả đã settle, vì `resolve` lần hai là no-op) bằng dữ liệu đã cấu hình. */
  readonly settleAll: () => Promise<void>;
  /** Reject mọi lần gọi chưa settle bằng `error`. */
  readonly failAll: (error: unknown) => Promise<void>;
};

export type FakeAdapterData = {
  readonly isPreview?: boolean;
  readonly staff?: readonly StaffMember[];
  readonly roles?: readonly SystemRole[];
  readonly permissions?: readonly Permission[];
};

function makeCall<T>(queue: FakeCall<T>[]): FakeCall<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const call: FakeCall<T> = { promise, resolve, reject };
  queue.push(call);
  return call;
}

/**
 * Hàng đợi ba phương thức trộn vào nhau vẫn gán được vào tham số này: chỉ cần trường
 * `promise`, mà `Promise<T>` lại hiệp biến theo `T`. Nếu khai thẳng `FakeCall<unknown>`,
 * `resolve` — vốn phản biến — làm cả mảng không gán được.
 */
type PromiseCarrier = { readonly promise: Promise<unknown> };

function allPendingSettled(
  calls: readonly PromiseCarrier[],
): Promise<PromiseSettledResult<unknown>[]> {
  const pending: Promise<unknown>[] = [];
  for (const call of calls) {
    pending.push(call.promise);
  }
  return Promise.allSettled(pending);
}

/**
 * Adapter fake trên nền dữ liệu cấu hình được.
 *
 * Ba phương thức của `BackofficeDataAdapter` đều trả `Promise` **chưa settle**; gọi
 * `settleAll()`/`failAll()` để kết thúc chúng. Không có phương thức ghi nào, đúng hợp
 * đồng read-only của adapter thật.
 */
export function createFakeBackofficeAdapter(data: FakeAdapterData = {}): FakeBackofficeAdapter {
  const staff = data.staff ?? PROTOTYPE_DATA.staff;
  const roles = data.roles ?? PROTOTYPE_DATA.roles;
  const permissions = data.permissions ?? PROTOTYPE_DATA.permissions;

  const staffCalls: FakeCall<readonly StaffMember[]>[] = [];
  const rolesCalls: FakeCall<readonly SystemRole[]>[] = [];
  const permissionsCalls: FakeCall<readonly Permission[]>[] = [];
  const entitlementsCalls: FakeCall<readonly StaffEntitlementSummary[]>[] = [];
  const auditEntriesCalls: FakeCall<readonly AuditEntry[]>[] = [];

  const adapter: BackofficeDataAdapter = {
    isPreview: data.isPreview ?? true,
    listStaff: () => makeCall(staffCalls).promise,
    listRoles: () => makeCall(rolesCalls).promise,
    listPermissions: () => makeCall(permissionsCalls).promise,
    listEntitlements: () => makeCall(entitlementsCalls).promise,
    listAuditEntries: () => makeCall(auditEntriesCalls).promise,
  };

  return {
    adapter,
    staffCalls,
    rolesCalls,
    permissionsCalls,
    entitlementsCalls,
    auditEntriesCalls,
    settleAll: async () => {
      for (const call of staffCalls) {
        call.resolve(staff);
      }
      for (const call of rolesCalls) {
        call.resolve(roles);
      }
      for (const call of permissionsCalls) {
        call.resolve(permissions);
      }
      for (const call of entitlementsCalls) {
        call.resolve([]);
      }
      for (const call of auditEntriesCalls) {
        call.resolve([]);
      }
      // ⚠️ `allSettled`, không phải `all`: test có thể đã reject một lần gọi trước đó
      // trong cùng hàng đợi — việc đó đã được composable xử lý và không được làm
      // `settleAll()` ném lỗi.
      await allPendingSettled([
        ...staffCalls,
        ...rolesCalls,
        ...permissionsCalls,
        ...entitlementsCalls,
        ...auditEntriesCalls,
      ]);
    },
    failAll: async (error) => {
      for (const call of staffCalls) {
        call.reject(error);
      }
      for (const call of rolesCalls) {
        call.reject(error);
      }
      for (const call of permissionsCalls) {
        call.reject(error);
      }
      for (const call of entitlementsCalls) {
        call.reject(error);
      }
      for (const call of auditEntriesCalls) {
        call.reject(error);
      }
      // Promise đã reject phải có người bắt, nếu không vitest báo unhandled rejection
      // ở một test khác. `run()` của `useAsyncState` là người bắt đầu tiên; đây là lưới
      // an toàn cho trường hợp test reject một lần gọi mà chưa có ai await nó.
      await allPendingSettled([
        ...staffCalls,
        ...rolesCalls,
        ...permissionsCalls,
        ...entitlementsCalls,
        ...auditEntriesCalls,
      ]);
    },
  };
}
