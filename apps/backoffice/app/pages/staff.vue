<script setup lang="ts">
/**
 * Staff directory — prototype-only.
 *
 * Học theo `sessions.vue` của `apps/account` về cấu trúc trạng thái (loading/
 * error/empty/ready), nhưng **không có hành động ghi** nào: không nút gán,
 * không đổi trạng thái, không xóa — tất cả là chỉ đọc.
 *
 * Hai điều cốt yếu (được ghim bởi tài liệu thiết kế):
 *
 * 1. **Không dùng email làm khoá.** `01-architecture.md` §4.1: "Account ID là
 *    cross-service identity reference… Email **không** phải primary identity
 *    key." Cột đầu tiên phải là "Staff member" với tên, nhưng **Account ID**
 *    là một cột riêng. Một UI hiển thị email thay cho Account ID là sai trái
 *    trực tiếp với design.
 * 2. **Staff status là trục riêng** (§4.2). Bao gồm cả `terminated`: hiện nó để
 *    thấy trạng thái hợp lệ, không động đến account.
 *
 * P5.4 (issue #478): thêm cột "Đăng ký sản phẩm" (entitlements) — mỗi staff
 * có thể có entitlement đối với một số sản phẩm nội bộ (ví dụ `backoffice`).
 * Adapter trả `entitlements` kèm mỗi `StaffMember` qua `listEntitlements`, và
 * cột này hiển thị trạng thái entitlement mỗi sản phẩm, các sản phẩm khác nhau
 * ngăn nhau bởi dấu phẩy. Staff không có entitlement nào hiện nhãn riêng
 * (`staff.entitlements.none`).
 *
 * Tính năng: search theo tên hoặc Account ID; filter theo staff status; phân
 * biệt `empty` (tập dữ liệu rỗng) và `noResults` (kết quả lọc/search không trả gì).
 */
import { computed, ref } from 'vue';
import { useI18n } from '#i18n';

import { Input } from '@ecoma-io/ui-app-shell';

import { useAsyncState } from '../composables/use-async-state';
import { useBackofficeAdapter } from '../composables/use-backoffice-adapter';
import type { StaffStatus } from '../backoffice-data';

const i18n = useI18n();
const adapter = useBackofficeAdapter();

// `isEmpty: () => false`: "tập dữ liệu rỗng" và "lọc ra rỗng" là hai câu chữ
// khác hẳn nhau (§2.7 của task), và trang này tự phân biệt chúng trong template.
// Giao `empty` cho `useAsyncState` sẽ biến hai trường hợp thành cùng một nhánh.
const { state, reload } = useAsyncState(
  () => adapter.listStaff(),
  () => false,
);

const search = ref('');
const filter = ref<StaffStatus | 'all'>('all');

const filtered = computed(() => {
  if (state.value.kind !== 'ready') {
    return [];
  }

  const term = search.value.trim().toLowerCase();
  return state.value.value.filter((member) => {
    if (filter.value !== 'all' && member.status !== filter.value) {
      return false;
    }
    if (term !== '') {
      // `displayName` có thể là `null` (người dùng chưa đặt tên — issue #325):
      // search theo tên khi đó chỉ còn đường Account ID, không phải lỗi.
      const byName = member.displayName !== null && member.displayName.toLowerCase().includes(term);
      const byId = member.accountId.toLowerCase().includes(term);
      if (!byName && !byId) {
        return false;
      }
    }
    return true;
  });
});

const statusLabel = (status: StaffStatus): string => {
  switch (status) {
    case 'active':
      return i18n.t('staff.status.active');
    case 'suspended':
      return i18n.t('staff.status.suspended');
    case 'terminated':
      return i18n.t('staff.status.terminated');
  }
};

/** Hiển thị entitlement của một staff: mỗi sản phẩm trong cột riêng, ngăn bằng dấu phẩy. */
const entitlementsLabel = (
  entitlements: readonly { readonly product: string; readonly status: 'entitled' | 'revoked' }[],
): string => {
  if (entitlements.length === 0) {
    return i18n.t('staff.entitlements.none');
  }
  return entitlements
    .map((e) => `${e.product}: ${i18n.t(`staff.entitlements.${e.status}`)}`)
    .join(', ');
};
</script>

<template>
  <section>
    <BackofficePageHeader
      :title="i18n.t('pages.staff.title')"
      :description="i18n.t('pages.staff.description')"
    />

    <BackofficeSampleNotice :message="i18n.t('prototype.notice.body')" />

    <BackofficeLoadingState v-if="state.kind === 'loading'" :label="i18n.t('states.loading')" />

    <BackofficeErrorState
      v-else-if="state.kind === 'error'"
      :title="i18n.t('states.errorTitle')"
      :body="i18n.t('states.errorBody')"
      :detail="state.message"
      :retry-label="i18n.t('states.retry')"
      :on-retry="reload"
    />

    <template v-else-if="state.kind === 'ready'">
      <div class="mb-4 grid gap-3 md:grid-cols-2">
        <div>
          <label class="text-sm font-medium" for="staff-search">
            {{ i18n.t('staff.search.label') }}
          </label>
          <Input
            id="staff-search"
            v-model="search"
            class="mt-1"
            type="search"
            data-testid="staff-search-input"
            :placeholder="i18n.t('staff.search.placeholder')"
          />
        </div>
        <div>
          <label class="text-sm font-medium" for="staff-filter">
            {{ i18n.t('staff.filter.label') }}
          </label>
          <select
            id="staff-filter"
            v-model="filter"
            class="border-input mt-1 h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            data-testid="staff-filter-select"
          >
            <option value="all">{{ i18n.t('staff.filter.all') }}</option>
            <option value="active">{{ i18n.t('staff.status.active') }}</option>
            <option value="suspended">{{ i18n.t('staff.status.suspended') }}</option>
            <option value="terminated">{{ i18n.t('staff.status.terminated') }}</option>
          </select>
        </div>
      </div>

      <p
        v-if="state.value.length === 0"
        class="text-sm text-muted-foreground"
        data-testid="staff-empty"
      >
        {{ i18n.t('staff.empty') }}
      </p>

      <template v-else>
        <p
          v-if="filtered.length === 0"
          class="text-sm text-muted-foreground"
          data-testid="staff-no-results"
        >
          {{ i18n.t('staff.noResults') }}
        </p>

        <div v-else class="overflow-x-auto rounded-lg border border-border bg-card">
          <table class="w-full text-sm" data-testid="staff-table">
            <thead class="bg-muted/50">
              <tr>
                <th class="text-left font-medium p-3">{{ i18n.t('staff.column.member') }}</th>
                <th class="text-left font-medium p-3">{{ i18n.t('staff.column.accountId') }}</th>
                <th class="text-left font-medium p-3">{{ i18n.t('staff.column.status') }}</th>
                <th class="text-left font-medium p-3">{{ i18n.t('staff.column.roles') }}</th>
                <th class="text-left font-medium p-3">{{ i18n.t('staff.column.entitlements') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="member in filtered" :key="member.accountId" class="border-t border-border">
                <td class="p-3 font-medium">
                  <!--
                    `null` = người dùng chưa đặt tên ở `account` (issue #325):
                    hiện nhãn riêng thay vì ô trống, để "không có dữ liệu" không
                    lẫn vào "dữ liệu rỗng".
                  -->
                  <template v-if="member.displayName !== null">{{ member.displayName }}</template>
                  <template v-else>
                    <span
                      class="font-normal italic text-muted-foreground"
                      data-testid="staff-no-display-name"
                    >
                      {{ i18n.t('onboarding.noDisplayName') }}
                    </span>
                  </template>
                </td>
                <td class="p-3 font-mono text-xs text-muted-foreground">{{ member.accountId }}</td>
                <td class="p-3">{{ statusLabel(member.status) }}</td>
                <td class="p-3 text-muted-foreground">
                  <template v-if="member.roleIds.length === 0">
                    {{ i18n.t('staff.noRoles') }}
                  </template>
                  <template v-else>
                    {{ member.roleIds.join(', ') }}
                  </template>
                </td>
                <td class="p-3 text-muted-foreground">
                  {{ entitlementsLabel(member.entitlements) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </section>
</template>
