/**
 * Bốn trạng thái dữ liệu ở **mức page thật** của ba trang dữ liệu prototype.
 *
 * `../composables/use-async-state.spec.ts` ghim hợp đồng của composable; file này ghim điều mà
 * người dùng thật nhìn thấy: mỗi page nối composable vào template đúng cách, và không
 * page nào tự xử lý lỗi theo cách riêng.
 *
 * Ba thứ được khẳng định ở **mọi** trạng thái, vì chúng là ranh giới giữa các trạng
 * thái chứ không phải chi tiết trình bày:
 *
 * 1. loading không bao giờ đi kèm bảng dữ liệu hay empty state;
 * 2. error không bao giờ bị biến thành empty state hay danh sách rỗng;
 * 3. `ready` mang đúng giá trị adapter trả về — dữ liệu test cố ý khác fixture để
 *    "hiện dữ liệu fixture" không thể xanh nhầm thành "hiện dữ liệu adapter".
 *
 * ⚠️ Mọi `Promise` do `tests/fake-adapter.ts` trả về đều do test settle.
 */
import { describe, expect, it } from 'vitest';
import type { Component } from 'vue';

import PermissionsPage from './permissions.vue';
import RolesPage from './roles.vue';
import StaffPage from './staff.vue';
import { PROTOTYPE_DATA } from '../backoffice-data/prototype-fixture';
import type { Permission, StaffMember, SystemRole } from '../backoffice-data/types';
import en from '../i18n/locales/en';
import type { FakeAdapterData, FakeBackofficeAdapter } from '../../tests/fake-adapter';
import { createFakeBackofficeAdapter } from '../../tests/fake-adapter';
import { at, mountBackofficePage } from '../../tests/harness';

const LOADING = '[data-testid="backoffice-loading"]';
const ERROR = '[data-testid="backoffice-error"]';
const ERROR_DETAIL = '[data-testid="backoffice-error-detail"]';
const ERROR_RETRY = '[data-testid="backoffice-error-retry"]';
const SAMPLE_NOTICE = '[data-testid="backoffice-sample-notice"]';

/** Dữ liệu cố ý khác fixture: xem ghi chú (3) ở đầu file. */
const STAFF: readonly [StaffMember] = [
  {
    accountId: 'acct_5T3STX00000000000000000AHJ',
    displayName: 'Nhân Viên Kiểm Thử',
    status: 'active',
    roleIds: ['operator'],
    entitlements: [],
  },
];

const ROLES: readonly [SystemRole] = [{ id: 'test-operator', permissionIds: ['mail.read'] }];

const PERMISSIONS: readonly [Permission] = [{ id: 'test.read', domain: 'test', action: 'read' }];

type PageCase = {
  readonly name: string;
  readonly component: Component;
  readonly staff: readonly StaffMember[];
  readonly roles: readonly SystemRole[];
  readonly permissions: readonly Permission[];
  /** Bảng dữ liệu — dấu hiệu duy nhất của trạng thái `ready` có nội dung. */
  readonly table: string;
  /** Empty state của tập dữ liệu — khác hẳn error state. */
  readonly empty: string;
  readonly noResults: string;
  readonly emptyMessage: string;
  /** Giá trị phải có mặt khi `ready`. */
  readonly cells: readonly string[];
  readonly rows: number;
  /** Số lần page gọi adapter. */
  readonly calls: (fake: FakeBackofficeAdapter) => number;
  /** Lần gọi đầu tiên — lần mà test quyết định kết cục. */
  readonly firstCall: (fake: FakeBackofficeAdapter) => {
    readonly reject: (reason: unknown) => void;
  };
  /**
   * Chuỗi **chỉ** có trong `PROTOTYPE_DATA` — dùng để chứng minh dữ liệu fixture không
   * xuất hiện thay cho dữ liệu của adapter được inject.
   */
  readonly fixtureMarker: string;
};

const PAGES: readonly PageCase[] = [
  {
    name: 'staff',
    component: StaffPage,
    staff: STAFF,
    roles: [],
    permissions: [],
    table: '[data-testid="staff-table"]',
    empty: '[data-testid="staff-empty"]',
    noResults: '[data-testid="staff-no-results"]',
    emptyMessage: en.staff.empty,
    cells: [at(STAFF).displayName, at(STAFF).accountId],
    rows: 1,
    calls: (fake) => fake.staffCalls.length,
    firstCall: (fake) => at(fake.staffCalls),
    fixtureMarker: at(PROTOTYPE_DATA.staff).accountId,
  },
  {
    name: 'roles',
    component: RolesPage,
    staff: [],
    roles: ROLES,
    permissions: [],
    table: '[data-testid="roles-table"]',
    empty: '[data-testid="roles-empty"]',
    noResults: '[data-testid="roles-no-results"]',
    emptyMessage: en.roles.empty,
    cells: [at(ROLES).id, at(at(ROLES).permissionIds)],
    rows: 1,
    calls: (fake) => fake.rolesCalls.length,
    firstCall: (fake) => at(fake.rolesCalls),
    fixtureMarker: at(PROTOTYPE_DATA.roles).id,
  },
  {
    name: 'permissions',
    component: PermissionsPage,
    staff: [],
    roles: [],
    permissions: PERMISSIONS,
    table: '[data-testid="permissions-table"]',
    empty: '[data-testid="permissions-empty"]',
    noResults: '[data-testid="permissions-no-results"]',
    emptyMessage: en.permissions.empty,
    cells: [at(PERMISSIONS).id, at(PERMISSIONS).domain],
    rows: 1,
    calls: (fake) => fake.permissionsCalls.length,
    firstCall: (fake) => at(fake.permissionsCalls),
    fixtureMarker: at(PROTOTYPE_DATA.permissions).id,
  },
];

describe.each(PAGES)('data page $name', (page) => {
  const adapterFor = (overrides: FakeAdapterData = {}) =>
    createFakeBackofficeAdapter({
      staff: page.staff,
      roles: page.roles,
      permissions: page.permissions,
      ...overrides,
    });

  it('shows loading before the adapter settles, not empty and not error', async () => {
    const fake = adapterFor();
    const { wrapper } = await mountBackofficePage(page.component, { adapter: fake.adapter });

    // `onMounted` đã chạy: adapter đã được gọi, và câu trả lời chưa tới.
    expect(page.calls(fake)).toBe(1);
    expect(wrapper.find(LOADING).exists()).toBe(true);
    expect(wrapper.find(LOADING).attributes('aria-busy')).toBe('true');

    // Ba thứ này là bằng chứng loading **không** bị trình bày như kết quả hoàn tất.
    expect(wrapper.find(page.table).exists()).toBe(false);
    expect(wrapper.find(page.empty).exists()).toBe(false);
    expect(wrapper.find(ERROR).exists()).toBe(false);
    // Và không phải "kết quả lọc rỗng" thay cho "chưa có gì".
    expect(wrapper.find(page.noResults).exists()).toBe(false);
  });

  it('shows the exact adapter values when ready', async () => {
    const fake = adapterFor();
    const { wrapper, flush } = await mountBackofficePage(page.component, { adapter: fake.adapter });

    await fake.settleAll();
    await flush();

    expect(wrapper.find(LOADING).exists()).toBe(false);
    expect(wrapper.find(ERROR).exists()).toBe(false);
    expect(wrapper.find(page.empty).exists()).toBe(false);

    const table = wrapper.get(page.table);
    expect(table.findAll('tbody tr')).toHaveLength(page.rows);
    for (const cell of page.cells) {
      expect(table.text()).toContain(cell);
    }
  });

  it('an empty result set → a deliberate empty state, not an error', async () => {
    const fake = createFakeBackofficeAdapter({ staff: [], roles: [], permissions: [] });
    const { wrapper, flush } = await mountBackofficePage(page.component, { adapter: fake.adapter });

    await fake.settleAll();
    await flush();

    const empty = wrapper.get(page.empty);
    expect(empty.text()).toBe(page.emptyMessage);
    // Empty state cố ý **không** phải thông báo khẩn cấp: nó không phải lỗi.
    expect(empty.attributes('role')).not.toBe('alert');

    // Rỗng là một kết quả **thành công**: không có bảng, không có lỗi, không còn loading.
    expect(wrapper.find(page.table).exists()).toBe(false);
    expect(wrapper.find(ERROR).exists()).toBe(false);
    expect(wrapper.find(LOADING).exists()).toBe(false);
    // Và không bị lẫn với "không khớp tìm kiếm".
    expect(wrapper.find(page.noResults).exists()).toBe(false);
  });

  it('adapter rejection → an error state, neither empty nor an empty table', async () => {
    const fake = adapterFor();
    const { wrapper, flush } = await mountBackofficePage(page.component, { adapter: fake.adapter });

    // Hỏng ở mức adapter (mọi phương thức của nó), không phải một lời gọi đơn lẻ: đường
    // lỗi của page không được phụ thuộc vào chuyện test reject đúng một promise nào.
    await fake.failAll(new Error('đọc dữ liệu thất bại'));
    await flush();

    const error = wrapper.get(ERROR);
    expect(error.attributes('role')).toBe('alert');
    expect(error.text()).toContain(en.states.errorTitle);
    expect(error.text()).toContain(en.states.errorBody);
    expect(wrapper.get(ERROR_DETAIL).text()).toBe('đọc dữ liệu thất bại');

    // Lỗi không được biến thành dữ liệu rỗng, và cũng không được biến thành thành công.
    expect(wrapper.find(page.empty).exists()).toBe(false);
    expect(wrapper.find(page.table).exists()).toBe(false);
    expect(wrapper.find(page.noResults).exists()).toBe(false);
    expect(wrapper.find(LOADING).exists()).toBe(false);

    // Thông điệp kỹ thuật hiện dạng chi tiết một dòng; stack trace không thuộc UI.
    expect(error.text()).not.toContain('    at ');
  });

  it('retry after error → loading then ready with fresh data', async () => {
    const fake = adapterFor();
    const { wrapper, flush } = await mountBackofficePage(page.component, { adapter: fake.adapter });

    page.firstCall(fake).reject(new Error('lần đầu hỏng'));
    await flush();
    expect(wrapper.get(ERROR_RETRY).text()).toBe(en.states.retry);

    await wrapper.get(ERROR_RETRY).trigger('click');
    await flush();

    // Đã rời error state nhưng chưa có kết quả: đây là loading, không phải thành công.
    expect(wrapper.find(ERROR).exists()).toBe(false);
    expect(wrapper.find(LOADING).exists()).toBe(true);
    expect(wrapper.find(page.table).exists()).toBe(false);
    expect(page.calls(fake)).toBe(2);

    await fake.settleAll();
    await flush();

    expect(wrapper.find(page.table).exists()).toBe(true);
    for (const cell of page.cells) {
      expect(wrapper.get(page.table).text()).toContain(cell);
    }
  });

  it('a failing adapter is not replaced by mock data', async () => {
    // `isPreview: false` là dấu vân tay của adapter được inject: adapter mock có
    // `isPreview = true` nên nếu page rơi về mock, banner dữ liệu mẫu sẽ xuất hiện.
    const fake = adapterFor({ isPreview: false });
    const { wrapper, flush } = await mountBackofficePage(page.component, { adapter: fake.adapter });

    page.firstCall(fake).reject(new Error('adapter thật hỏng'));
    await flush();

    expect(wrapper.find(ERROR).exists()).toBe(true);
    expect(wrapper.find(SAMPLE_NOTICE).exists()).toBe(false);
    expect(wrapper.text()).not.toContain(page.fixtureMarker);
    expect(page.calls(fake)).toBe(1);
  });
});

describe('the sample-data banner follows the adapter in use', () => {
  it('shows the banner when the adapter reports isPreview = true', async () => {
    const fake = createFakeBackofficeAdapter({ isPreview: true });
    const { wrapper, flush } = await mountBackofficePage(StaffPage, { adapter: fake.adapter });

    await fake.settleAll();
    await flush();

    expect(wrapper.get(SAMPLE_NOTICE).text()).toBe(en.prototype.notice.body);
  });

  it('hides the banner when the adapter reports isPreview = false', async () => {
    const fake = createFakeBackofficeAdapter({ isPreview: false });
    const { wrapper, flush } = await mountBackofficePage(StaffPage, { adapter: fake.adapter });

    await fake.settleAll();
    await flush();

    expect(wrapper.find(SAMPLE_NOTICE).exists()).toBe(false);
    expect(wrapper.find('[data-testid="staff-table"]').exists()).toBe(true);
  });
});

describe('staff — tells an empty result set apart from a search miss', () => {
  it('an empty result set shows the dataset empty state, not no-results', async () => {
    const fake = createFakeBackofficeAdapter({ staff: [] });
    const { wrapper, flush } = await mountBackofficePage(StaffPage, { adapter: fake.adapter });

    await fake.settleAll();
    await flush();

    expect(wrapper.get('[data-testid="staff-empty"]').text()).toBe(en.staff.empty);
    expect(wrapper.find('[data-testid="staff-no-results"]').exists()).toBe(false);
  });

  it('a search miss shows no-results, not the dataset empty state', async () => {
    const fake = createFakeBackofficeAdapter({ staff: STAFF });
    const { wrapper, flush } = await mountBackofficePage(StaffPage, { adapter: fake.adapter });

    await fake.settleAll();
    await flush();

    await wrapper.get('[data-testid="staff-search-input"]').setValue('không có ai tên thế này');

    expect(wrapper.get('[data-testid="staff-no-results"]').text()).toBe(en.staff.noResults);
    expect(wrapper.find('[data-testid="staff-empty"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="staff-table"]').exists()).toBe(false);
  });

  it('the staff status filter narrows the table to the adapter values', async () => {
    const staff: readonly [StaffMember, StaffMember] = [
      at(STAFF),
      {
        accountId: 'acct_6T3STX00000000000000000BKM',
        displayName: 'Nhân Viên Bị Đình Chỉ',
        status: 'suspended',
        roleIds: [],
        entitlements: [],
      },
    ];
    const fake = createFakeBackofficeAdapter({ staff });
    const { wrapper, flush } = await mountBackofficePage(StaffPage, { adapter: fake.adapter });

    await fake.settleAll();
    await flush();
    expect(wrapper.findAll('tbody tr')).toHaveLength(2);

    await wrapper.get('[data-testid="staff-filter-select"]').setValue('suspended');

    expect(wrapper.findAll('tbody tr')).toHaveLength(1);
    expect(wrapper.get('[data-testid="staff-table"]').text()).toContain('Nhân Viên Bị Đình Chỉ');
    expect(wrapper.get('[data-testid="staff-table"]').text()).not.toContain(STAFF[0].displayName);
  });
});
