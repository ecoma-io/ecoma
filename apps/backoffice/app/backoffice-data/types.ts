/**
 * Kiểu dữ liệu của lớp UI backoffice.
 *
 * Đây là **hợp đồng giữa UI và adapter**, không phải hợp đồng giữa `backoffice`
 * và service nào khác, và **không** phải schema. Không trường nào ở đây được
 * suy ra từ database: `01-architecture.md` §10 để ngỏ storage/schema cho
 * staff/RBAC, nên mọi hình dạng bảng ở đây đều là suy đoán bị cấm.
 *
 * Bốn nguyên tắc định hình toàn bộ file này, và chúng là ràng buộc của tài liệu
 * thiết kế chứ không phải khẩu hiệu:
 *
 * 1. **Account ID là định danh ổn định duy nhất.** Một staff member liên kết tới
 *    đúng một Account ID (`01-architecture.md` §4.1). Vì vậy `StaffMember` **không
 *    có** trường email — email không phải primary identity key, và một cột email
 *    trong UI là cách trực tiếp nhất để người đọc tin rằng nó là khoá.
 * 2. **Staff status là một trục khác account status** (§4.2). Hai khái niệm khác
 *    nhau, không suy ra nhau; `StaffStatus` ở đây là trạng thái **membership**,
 *    không phải trạng thái tài khoản ở `account`.
 * 3. **Không có unrestricted bypass role** (§4.4). Kiểu không cấm điều đó bằng
 *    cách nào đó kỳ diệu — nó cấm bằng cách **không có chỗ nào** cho một role
 *    "mặc định được mọi thứ": `SystemRole` chỉ có tập permission, và không có
 *    cờ `isAdmin` hay nhánh "toàn quyền" nào trong adapter hay template.
 * 4. **UI visibility ≠ authorization** (§5). Không có kiểu nào ở đây là quyền
 *    hạn: chúng là dữ liệu để **hiển thị**. Không có mutation trong adapter, nên
 *    không có đường nào làm một thao tác nhạy cảm "thành công" từ browser.
 */

import type { AuditEntry } from '@ecoma-io/staff-access-contracts';

/**
 * Trạng thái staff membership — riêng biệt với account status (§4.2).
 */
export type StaffStatus = 'active' | 'suspended' | 'terminated';

export type { AuditEntry };

/**
 * Tóm tắt entitlement của một staff đối với một sản phẩm nội bộ — chỉ mang
 * tính khả dụng sản phẩm (ADR-0009: entitlement ≠ authorization), không mang
 * verdict/permission/role.
 */
export type StaffEntitlementSummary = {
  /** Sản phẩm nội bộ (`backoffice`, `pact-broker`, `remote-cache`, ...). */
  readonly product: string;
  /** `entitled` = có sẵn dùng, `revoked` = đã thu hồi. */
  readonly status: 'entitled' | 'revoked';
};

/**
 * Một thành viên staff.
 *
 * ⚠️ **Không có `email`.** Đây không phải sự cố sót: Account ID là reference ổn
 * định, email thì không (đổi email không đổi người), và một cột email sẽ biến
 * UI thành một định danh thứ hai mà không ai tuyên bố. Xem `01-architecture.md`
 * §4.1.
 */
export type StaffMember = {
  /** Account ID (`sub`) — reference ổn định, không tái phát hành/không tái sử dụng. */
  readonly accountId: string;
  readonly displayName: string;
  readonly status: StaffStatus;
  /** Các role đã gán — tập rỗng là hợp lệ: một Account tồn tại không hàm ý là staff. */
  readonly roleIds: readonly string[];
  /**
   * Tóm tắt entitlement của staff đối với các sản phẩm nội bộ — tập rỗng là
   * hợp lệ khi adapter chưa đồng bộ hoặc staff không có entitlement nào.
   * Được populate riêng qua `listEntitlements`, không phải từ `listStaff`.
   */
  readonly entitlements: readonly StaffEntitlementSummary[];
};

/**
 * Một system-defined role.
 *
 * ⚠️ **Không có `name` hay `description`.** Chúng là chuỗi hiển thị và phải đi qua
 * catalog i18n theo `id` — giữ bản dịch trong fixture là tạo ra **hai** nguồn
 * sự thật cho cùng một nhãn, và nguồn thứ hai sẽ trôi khỏi catalog khi một
 * translator sửa chỗ kia.
 *
 * ⚠️ **Không có trường phân cấp.** Role hierarchy là `deferred` và không bật mặc
 * định (`01-architecture.md` §4.7); một field `parentRoleId` ở đây sẽ là một
 * quyết định kiến trúc được lặng lẽ đưa vào một prototype.
 */
export type SystemRole = {
  readonly id: string;
  readonly permissionIds: readonly string[];
};

/**
 * Một permission trong catalog.
 *
 * `id` là định danh ổn định; `domain` + `action` là hai thành phần mà
 * `01-architecture.md` §4.3 định nghĩa permission là **"một định danh một hành
 * động trên một resource domain"**. Cả ba đều là **giá trị domain, không dịch**:
 * dịch `delivery.redrive` thành một câu tiếng Việt là biến một định danh mà
 * backend enforce thành một nhãn mà không backend nào khớp được.
 */
export type Permission = {
  readonly id: string;
  /** Resource domain — ví dụ `delivery`. */
  readonly domain: string;
  /** Hành động trên domain đó — ví dụ `redrive`. */
  readonly action: string;
};

/** Một tập dữ liệu prototype, đã tách khỏi mọi thứ mà UI quyết định về nó. */
export type BackofficePrototypeData = {
  readonly staff: readonly StaffMember[];
  readonly roles: readonly SystemRole[];
  readonly permissions: readonly Permission[];
};

/**
 * Adapter dữ liệu backoffice — ranh giới duy nhất giữa UI và dữ liệu.
 *
 * Mọi phương thức **đọc** trả `Promise` dù hôm nay dữ liệu đến từ một fixture
 * cục bộ: đó là hình dạng mà một adapter thật sẽ có, và giữ nó từ đầu nghĩa là
 * đổi sang API thật là **thay thân một file**, không phải viết lại bốn trang.
 *
 * ⚠️ **Không có phương thức ghi nào**, và đó là thiết kế có chủ đích, không phải
 * phần chưa làm xong. Một thao tác ghi vào staff directory / role assignment /
 * catalog là **privileged operation** phải được enforce server-side
 * (`01-architecture.md` §7 cấm cả self-assignment lẫn self-elevation), và chưa có
 * server nào tồn tại. Thêm `assignRole()` vào đây hôm nay sẽ tạo đúng thứ mà
 * task cấm: một nút bấm làm state trong bộ nhớ đổi màu và người dùng tin rằng
 * quyền đã được cấp. Việc thêm nó sau này đi kèm contract + enforcement, không
 * đi trước.
 *
 * ⚠️ `isPreview` là **cờ bắt buộc**, không phải gợi ý: UI bắt buộc phải hiển thị
 * banner "dữ liệu mẫu" chừng nào cờ này còn `true`, và một adapter thật phải trả
 * `false`.
 */
export type BackofficeDataAdapter = {
  /** `true` khi dữ liệu đến từ fixture — UI hiển thị banner "dữ liệu mẫu". */
  readonly isPreview: boolean;

  listStaff(): Promise<readonly StaffMember[]>;
  listRoles(): Promise<readonly SystemRole[]>;
  listPermissions(): Promise<readonly Permission[]>;
  /**
   * Tóm tắt entitlement của một staff đối với các sản phẩm nội bộ (ví dụ
   * `backoffice`, `pact-broker`, `remote-cache`). Mỗi entry chỉ mang tính khả
   * dụng sản phẩm (ADR-0009 — entitlement ≠ authorization), không mang
   * verdict/permission/role.
   */
  listEntitlements(staffId: string): Promise<readonly StaffEntitlementSummary[]>;
  /**
   * Bản ghi authorization audit theo bộ lọc (actor, target, action, khung
   * thời gian, correlation_id...). Chỉ đọc, append-only phía server.
   */
  listAuditEntries(query: Record<string, string>): Promise<readonly AuditEntry[]>;
};
