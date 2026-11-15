<script setup lang="ts">
/**
 * Staff directory — đọc mọi data mode, ghi chỉ ở realtime (issue #191).
 *
 * Học theo `sessions.vue` của `apps/account` về cấu trúc trạng thái (loading/
 * error/empty/ready).
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
 *
 * ## Ghi (issue #191)
 *
 * Ở data mode **realtime** (`adapter.isPreview === false`) trang thêm: form tạo
 * staff identity, control gán role theo hàng, control thu hồi assignment. UI
 * visibility **không phải authorization** (§5): ẩn/hiện control theo data mode
 * chỉ là trải nghiệm; gọi thẳng API vẫn bị staff-access từ chối và audit. Ở
 * prototype (`isPreview === true`) **không control ghi nào render** — bảo vệ
 * S11 của readonly-boundary suite giữ nguyên.
 *
 * Kết quả ghi hiện dưới dạng dòng trạng thái trên form (thành công, denial
 * 403 kèm lý do staff-access forward nguyên vẹn — ví dụ
 * `self_revocation_last_administrator`, 409 conflict) — không toast, không
 * dialog, để người đọc thấy đúng một kết quả mỗi thao tác.
 *
 * Tính năng: search theo tên hoặc Account ID; filter theo staff status; phân
 * biệt `empty` (tập dữ liệu rỗng) và `noResults` (kết quả lọc/search không trả gì).
 */
import { computed, ref, watch } from 'vue';
import { useI18n } from '#i18n';

import { Button, Input } from '@ecoma-io/ui-app-shell';

import { useAsyncState } from '../composables/use-async-state';
import { useBackofficeAdapter } from '../composables/use-backoffice-adapter';
import type { StaffAssignment, StaffMember, StaffStatus } from '../backoffice-data';

const i18n = useI18n();
const adapter = useBackofficeAdapter();

// Ghi chỉ có nghĩa ở adapter thật; prototype/unavailable không render control.
const canWrite = computed(() => !adapter.isPreview);

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

// ---------------------------------------------------------------------------
// Ghi (realtime only — #191)
// ---------------------------------------------------------------------------

const roleCatalog = ref<readonly { readonly id: string }[]>([]);
const assignmentsByStaff = ref<Record<string, readonly StaffAssignment[]>>({});

// Catalog role cho dropdown gán — nạp một lần khi trang ready ở realtime.
const { state: rolesState } = useAsyncState(
  () => adapter.listRoles(),
  () => false,
);

watch(rolesState, (rolesReady) => {
  if (rolesReady.kind === 'ready') {
    roleCatalog.value = rolesReady.value;
  }
});

/** Assignments đang hiệu lực của một staff (đã load qua nút "quản lý role"). */
const liveAssignments = (staffId: string): readonly StaffAssignment[] =>
  (assignmentsByStaff.value[staffId] ?? []).filter((a) => a.revokedAt === null);

const loadAssignments = async (member: StaffMember): Promise<void> => {
  const result = await adapter.listAssignments(member.staffId);
  assignmentsByStaff.value = { ...assignmentsByStaff.value, [member.staffId]: result };
  expandedStaffId.value = member.staffId;
};

const expandedStaffId = ref<string | null>(null);
const busy = ref(false);
/** Kết quả của thao tác ghi gần nhất — hiện dạng dòng trạng thái trên form. */
const writeNotice = ref<{ readonly kind: 'success' | 'error'; readonly text: string } | null>(null);

// Form tạo staff identity.
const newStaffSub = ref('');
const newStaffDisplayName = ref('');

const createStaff = async (): Promise<void> => {
  if (busy.value) {
    return;
  }
  busy.value = true;
  writeNotice.value = null;
  try {
    const result = await adapter.createStaff({
      sub: newStaffSub.value.trim(),
      displayName: newStaffDisplayName.value.trim(),
    });
    if (result.ok) {
      writeNotice.value = { kind: 'success', text: i18n.t('staff.write.created') };
      newStaffSub.value = '';
      newStaffDisplayName.value = '';
      await reload();
    } else {
      writeNotice.value = {
        kind: 'error',
        text: result.message ?? i18n.t('staff.write.failed', { status: result.status ?? '' }),
      };
    }
  } catch (error) {
    // Network failure (fetch throws) hoặc response body hỏng — `postJson` reject.
    writeNotice.value = {
      kind: 'error',
      text: error instanceof Error ? error.message : String(error),
    };
  } finally {
    busy.value = false;
  }
};

// Một select role cho từng staff (không chia sẻ giữa các hàng — chọn ở hàng A
// không được lộ sang hàng B vừa expand).
const selectedRoleIds = ref<Record<string, string>>({});

const assignRole = async (member: StaffMember): Promise<void> => {
  const roleId = selectedRoleIds.value[member.staffId] ?? '';
  if (busy.value || member.staffId === '' || roleId === '') {
    return;
  }
  busy.value = true;
  writeNotice.value = null;
  try {
    const result = await adapter.assignRole({
      staffId: member.staffId,
      roleId,
    });
    if (result.ok) {
      writeNotice.value = { kind: 'success', text: i18n.t('staff.write.assigned') };
      // Xoá lựa chọn của staff này — gán về '' là reset, không cần delete.
      selectedRoleIds.value[member.staffId] = '';
      await loadAssignments(member);
    } else {
      writeNotice.value = {
        kind: 'error',
        text: result.message ?? i18n.t('staff.write.failed', { status: result.status ?? '' }),
      };
    }
  } catch (error) {
    // `loadAssignments` → `fetchJson` throws `BackofficeRouteError` trên non-OK.
    writeNotice.value = {
      kind: 'error',
      text: error instanceof Error ? error.message : String(error),
    };
  } finally {
    busy.value = false;
  }
};

const revokeAssignment = async (member: StaffMember, assignmentId: string): Promise<void> => {
  if (busy.value || member.staffId === '' || assignmentId === '') {
    return;
  }
  busy.value = true;
  writeNotice.value = null;
  try {
    const result = await adapter.revokeRole(assignmentId);
    if (result.ok) {
      writeNotice.value = { kind: 'success', text: i18n.t('staff.write.revoked') };
      await loadAssignments(member);
    } else {
      writeNotice.value = {
        kind: 'error',
        text: result.message ?? i18n.t('staff.write.failed', { status: result.status ?? '' }),
      };
    }
  } catch (error) {
    writeNotice.value = {
      kind: 'error',
      text: error instanceof Error ? error.message : String(error),
    };
  } finally {
    busy.value = false;
  }
};
</script>

<template>
  <section>
    <BackofficePageHeader
      :title="i18n.t('pages.staff.title')"
      :description="i18n.t('pages.staff.description')"
    />

    <BackofficeSampleNotice :message="i18n.t('prototype.notice.body')" />

    <!-- Form + controls ghi — chỉ realtime; prototype không render gì ở đây (S11). -->
    <template v-if="canWrite && state.kind === 'ready'">
      <form
        class="mb-6 rounded-lg border border-border bg-card p-4"
        data-testid="staff-create-form"
        @submit.prevent="createStaff"
      >
        <h2 class="text-sm font-semibold">{{ i18n.t('staff.write.createTitle') }}</h2>
        <div class="mt-3 grid gap-3 md:grid-cols-[2fr_2fr_auto] md:items-end">
          <div>
            <label class="text-sm font-medium" for="staff-create-sub">
              {{ i18n.t('staff.write.subLabel') }}
            </label>
            <Input
              id="staff-create-sub"
              v-model="newStaffSub"
              class="mt-1"
              type="text"
              data-testid="staff-create-sub"
              :placeholder="i18n.t('staff.write.subPlaceholder')"
              required
            />
          </div>
          <div>
            <label class="text-sm font-medium" for="staff-create-name">
              {{ i18n.t('staff.write.nameLabel') }}
            </label>
            <Input
              id="staff-create-name"
              v-model="newStaffDisplayName"
              class="mt-1"
              type="text"
              data-testid="staff-create-name"
              required
            />
          </div>
          <Button type="submit" data-testid="staff-create-submit" :disabled="busy">
            {{ i18n.t('staff.write.create') }}
          </Button>
        </div>
      </form>

      <p
        v-if="writeNotice !== null"
        class="mb-4 text-sm"
        :class="writeNotice.kind === 'success' ? 'text-green-600' : 'text-destructive'"
        data-testid="staff-write-notice"
        role="status"
      >
        {{ writeNotice.text }}
      </p>
    </template>

    <BackofficeLoadingState v-if="state.kind === 'loading'" :label="i18n.t('states.loading')" />

    <BackofficeErrorState
      v-else-if="state.kind === 'error'"
      :title="i18n.t('states.errorTitle')"
      :body="i18n.t('states.errorBody')"
      :detail="state.message"
      :retry-label="i18n.t('states.retry')"
      :on-retry="reload"
      :session-expired="state.status === 401"
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
                <th v-if="canWrite" class="text-left font-medium p-3">
                  {{ i18n.t('staff.column.manageRoles') }}
                </th>
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
                <!--
                  Cột quản lý role — chỉ realtime. Prototype giữ nguyên số control
                  cũ: readonly-boundary suite đếm control trong /staff (S11).
                -->
                <td v-if="canWrite" class="p-3">
                  <template v-if="member.staffId !== ''">
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="staff-manage-roles"
                      :disabled="busy"
                      @click="loadAssignments(member)"
                    >
                      {{ i18n.t('staff.write.manageRoles') }}
                    </Button>
                    <div
                      v-if="expandedStaffId === member.staffId"
                      class="mt-2 flex flex-col gap-2"
                      :data-testid="`staff-roles-${member.staffId}`"
                    >
                      <select
                        v-model="selectedRoleIds[member.staffId]"
                        class="border-input h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none"
                        :aria-label="i18n.t('staff.write.roleSelectLabel')"
                        data-testid="staff-role-select"
                      >
                        <option value="" disabled>
                          {{ i18n.t('staff.write.roleSelectLabel') }}
                        </option>
                        <option v-for="role in roleCatalog" :key="role.id" :value="role.id">
                          {{ role.id }}
                        </option>
                      </select>
                      <Button
                        size="sm"
                        data-testid="staff-assign-role"
                        :disabled="busy || (selectedRoleIds[member.staffId] ?? '') === ''"
                        @click="assignRole(member)"
                      >
                        {{ i18n.t('staff.write.assign') }}
                      </Button>
                      <div
                        v-for="assignment in liveAssignments(member.staffId)"
                        :key="assignment.assignmentId"
                        class="flex items-center justify-between gap-2 text-xs"
                      >
                        <span class="font-mono">{{ assignment.roleId }}</span>
                        <Button
                          variant="outline"
                          size="sm"
                          data-testid="staff-revoke-role"
                          :disabled="busy"
                          @click="revokeAssignment(member, assignment.assignmentId)"
                        >
                          {{ i18n.t('staff.write.revoke') }}
                        </Button>
                      </div>
                    </div>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </section>
</template>
