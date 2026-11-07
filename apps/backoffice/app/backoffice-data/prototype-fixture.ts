/**
 * Fixture **prototype-only** của backoffice.
 *
 * Ba tính chất phải giữ, và chúng là lý do file này tồn tại:
 *
 * 1. **Không phải authoritative catalog.** Không bản nào của file này được
 *    sao chép sang tài liệu kiến trúc: `docs/domains/staff-access/*` là nơi giữ
 *    thiết kế, còn đây là dữ liệu để **nhìn**. Permission và role dưới đây được
 *    **minh hoạ**, không phải quyết định governance — `01-architecture.md` §4.3
 *    ghi rõ tài liệu "không phát minh permission cụ thể nào", và prototype này
 *    cũng không: nó chỉ dựng một tập nhỏ đủ để giao diện có gì đó để hiển thị.
 * 2. **Tất định, không thời gian thực.** Không có `Date.now()`, không có ngày
 *    sinh từ hệ thống. `StaffMember` cố ý **không** có timestamp nào để format:
 *    thêm `joinedAt` sau này là thêm một dạng dữ liệu cần format theo locale, và nó phải
 *    đi cùng phép kiểm SSR/client cùng chuỗi — một quyết định không thuộc phạm vi
 *    prototype này.
 * 3. **Không có bản dịch.** Role và permission chỉ mang **id**; nhãn hiển thị
 *    lấy từ catalog i18n theo id (`catalogs.spec.ts` (colocated cạnh file này) buộc đủ key cho mọi id
 *    ở đây). Giữ nhãn trong fixture là tạo nguồn sự thật thứ hai cho cùng một
 *    chuỗi, và hai nguồn sẽ trôi khỏi nhau.
 */
import type { BackofficePrototypeData, Permission, StaffMember, SystemRole } from './types';

/**
 * Account ID (`sub`) dạng ULID — **giả lập**, nhưng có đúng hình dạng của một
 * định danh opaque: 26 ký tự Crockford base32 sau tiền tố, ký tự đầu trong
 * `[0-7]`. ⚠️ Crockford **loại** các chữ `I`, `L`, `O`, `U` khỏi alphabet, nên một
 * id chứa chúng không phải ULID — `prototype-fixture.spec.ts` (colocated cạnh fixture) kiểm đúng điều
 * đó bằng assertion, không phải bằng lời bình.
 *
 * ⚠️ Cố ý **không** phải email, **không** phải username, **không** phải thứ gì
 * người ta có thể gõ để tìm một người ở service khác. `01-architecture.md` §4.1:
 * Account ID là reference ổn định và email **không** phải primary identity key.
 * Một fixture dùng email làm cột định danh sẽ dạy người đọc đúng điều mà tài
 * liệu thiết kế cấm, và không test nào bắt được điều đó sau khi nó đã vào UI.
 */
const ACCOUNT_IDS = {
  linh: 'acct_7PZNH32PY20PD8Y10EF9CQXJ18',
  minh: 'acct_4TPCKEP6AW4YNNQJMXEE37E1FS',
  an: 'acct_2PKJGMDSQTG64PY4DMHBX6TNC0',
  quang: 'acct_6Z7N9NWQ0SCWKK02XYWZPD6WMH',
  thu: 'acct_0DKKG1D0ZQ1KMN3PYT8RQ9W9G4',
} as const;

/**
 * Permission mẫu — **minh hoạ, không phải catalog**.
 *
 * Mỗi entry có dạng `<domain>.<action>` đúng định nghĩa của
 * `01-architecture.md` §4.3 ("định danh một hành động trên một resource
 * domain"), và `domain`/`action` là **hai phần tách**, không phải một label dán
 * vào. `delivery.redrive` giữ nguyên dạng mà tài liệu đã dùng làm ví dụ.
 *
 * ⚠️ **Không** có permission nào hàm ý "mọi thứ". Không có `*`, không có
 * `admin.all`, không có wildcard: `01-architecture.md` §4.4 cấm một bypass role
 * unrestricted, và một permission bao trùm trong catalog là đường tắt đúng thứ
 * đó.
 */
const PERMISSIONS: readonly Permission[] = [
  { id: 'delivery.redrive', domain: 'delivery', action: 'redrive' },
  { id: 'mail.read', domain: 'mail', action: 'read' },
  { id: 'mail.send', domain: 'mail', action: 'send' },
  { id: 'staff.read', domain: 'staff', action: 'read' },
  { id: 'role.assign', domain: 'role', action: 'assign' },
  { id: 'audit.read', domain: 'audit', action: 'read' },
];

/**
 * System-defined role mẫu — **minh hoạ, không phải catalog**.
 *
 * Không role nào chứa toàn bộ permission: `auditor` gần nhất cũng chỉ có hai
 * cái. Đây là minh hoạ sống động nhất của `01-architecture.md` §4.4 ("mọi role
 * đều là tập permission hữu hạn"), và `prototype-fixture.spec.ts` (colocated cạnh fixture) ghim điều
 * đó bằng assertion — không phải bằng lời bình.
 *
 * ⚠️ **Không** có role `admin`, `superadmin` hay `owner`. Bootstrap
 * first-administrator là quyết định **chưa chốt** (§10) và phải đi kèm đường
 * documented + audited; một role tên `admin` trong fixture là cách dễ nhất để
 * prototype trông như đã có câu trả lời cho câu hỏi đó.
 */
const ROLES: readonly SystemRole[] = [
  {
    id: 'operator',
    permissionIds: ['delivery.redrive', 'mail.read', 'mail.send', 'staff.read'],
  },
  {
    id: 'support',
    permissionIds: ['mail.read', 'staff.read'],
  },
  {
    id: 'auditor',
    permissionIds: ['audit.read', 'staff.read'],
  },
];

/**
 * Staff mẫu.
 *
 * `role.assign` cố ý **không** xuất hiện trong bất kỳ role nào: đó là privileged operation
 * (`01-architecture.md` §7 — cấm cả self-assignment lẫn self-elevation), và một
 * fixture gán nó cho một role sẽ minh hoạ đúng một mô hình mà tài liệu cấm.
 */
const STAFF: readonly StaffMember[] = [
  {
    accountId: ACCOUNT_IDS.linh,
    displayName: 'Linh Trần',
    status: 'active',
    roleIds: ['operator'],
    entitlements: [{ product: 'backoffice', status: 'entitled' }],
  },
  {
    accountId: ACCOUNT_IDS.minh,
    displayName: 'Minh Nguyễn',
    status: 'active',
    roleIds: ['support'],
    entitlements: [{ product: 'backoffice', status: 'entitled' }],
  },
  {
    accountId: ACCOUNT_IDS.an,
    displayName: 'An Lê',
    status: 'suspended',
    roleIds: ['operator', 'support'],
    entitlements: [{ product: 'backoffice', status: 'entitled' }],
  },
  {
    accountId: ACCOUNT_IDS.quang,
    displayName: 'Quang Phạm',
    status: 'terminated',
    roleIds: ['auditor'],
    entitlements: [{ product: 'backoffice', status: 'revoked' }],
  },
  {
    // Staff **không** có role nào: tập role rỗng là trạng thái hợp lệ, và một
    // fixture nơi mọi người đều có role sẽ che mất nhánh "chưa gán gì" của UI.
    accountId: ACCOUNT_IDS.thu,
    displayName: 'Thu Vũ',
    status: 'active',
    roleIds: [],
    entitlements: [],
  },
];

/** Toàn bộ dữ liệu mẫu, frozen ở cả object lẫn từng mảng. */
export const PROTOTYPE_DATA: BackofficePrototypeData = Object.freeze({
  staff: Object.freeze([...STAFF]),
  roles: Object.freeze([...ROLES]),
  permissions: Object.freeze([...PERMISSIONS]),
});
