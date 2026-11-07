<script setup lang="ts">
/**
 * `/applications` — ứng dụng đã kết nối.
 *
 * ⚠️ Trang này **không** đọc `db-auth` và không tự phán quyền. Danh sách grant và
 * cờ `highRisk` đến từ contract qua adapter — UI chỉ render. Đó là ranh giới của
 * FR-011: `account` không query bảng của `db-auth`, và việc UI tự suy ra "scope này
 * nguy hiểm" là quyết định thuộc về bên sở hữu nó.
 *
 * ⚠️ Scope hiển thị **thẳng mã** (`profile:read`), không diễn giải. Lý do khác với
 * `/consent`: consent nhận nhãn đã diễn giải sẵn từ BFF
 * (`ConsentContext.permissions`), còn grant đã cấp không có bước đó trong contract
 * hiện tại. Tự map mã scope sang câu tiếng người ở đây là UI tự quyết định ý nghĩa
 * của một scope — chính xác điều mà kiểu của `ConsentContext` cấm. Đã ghi lại
 * làm handoff: khi contract grant có trường mô tả, hiển thị nó ở đây.
 */
const i18n = useI18n();
const adapter = useAccountAdapter();
const { formatDateTime } = useAccountFormat();

const { state, reload } = useAsyncState(() => adapter.listApplications());

const revoking = ref<string | undefined>(undefined);
const result = ref<{ tone: 'success' | 'danger'; message: string } | undefined>(undefined);
const busy = ref(false);

async function revoke(): Promise<void> {
  const id = revoking.value;
  if (id === undefined) {
    return;
  }
  busy.value = true;
  result.value = undefined;
  try {
    const revoked = await adapter.revokeApplication(id);
    revoking.value = undefined;
    result.value = revoked.ok
      ? { tone: 'success', message: i18n.t('applications.revoked') }
      : { tone: 'danger', message: `${i18n.t('states.saveFailed')}: ${revoked.reason}` };
    await reload();
  } finally {
    busy.value = false;
  }
}

function requestRevoke(id: string): void {
  result.value = undefined;
  revoking.value = id;
}
</script>

<template>
  <section>
    <AccountPageHeader
      :title="i18n.t('applications.title')"
      :description="i18n.t('applications.description')"
    />

    <AccountLoadingState v-if="state.kind === 'loading'" :label="i18n.t('common.loading')" />

    <AccountErrorState
      v-else-if="state.kind === 'error'"
      :title="i18n.t('states.errorTitle')"
      :body="i18n.t('states.errorBody')"
      :detail="state.message"
      :retry-label="i18n.t('common.retry')"
      :on-retry="reload"
    />

    <AccountEmptyState
      v-else-if="state.kind === 'empty'"
      :message="i18n.t('states.emptyApplications')"
    />

    <ul v-else class="space-y-3" data-testid="application-list">
      <li
        v-for="application in state.value"
        :key="application.id"
        class="account-card px-4 py-3"
        :data-testid="`application-row-${application.id}`"
      >
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="font-medium text-foam">{{ application.clientName }}</p>
            <p class="text-sm text-muted">
              {{ i18n.t('applications.grantedAt') }} {{ formatDateTime(application.grantedAt) }}
            </p>
            <p
              v-if="application.highRisk"
              class="mt-2 inline-flex items-center rounded-full bg-danger-soft px-2 py-1 text-xs font-semibold text-danger"
              data-testid="application-high-risk"
            >
              {{ i18n.t('consent.riskTitle') }}
            </p>
          </div>
          <button
            type="button"
            class="account-button-danger"
            :disabled="busy"
            :data-testid="`application-revoke-${application.id}`"
            @click="requestRevoke(application.id)"
          >
            {{ i18n.t('applications.revoke') }}
          </button>
        </div>
        <div class="mt-3 border-t border-line pt-3">
          <p class="text-sm font-medium text-foam">{{ i18n.t('applications.scopes') }}</p>
          <ul v-if="application.scopes.length > 0" class="mt-1 flex flex-wrap gap-2">
            <li
              v-for="scope in application.scopes"
              :key="scope"
              class="rounded-full border border-line bg-surface px-2 py-0.5 font-mono text-xs text-muted"
            >
              {{ scope }}
            </li>
          </ul>
          <p v-else class="mt-1 text-sm text-muted">{{ i18n.t('applications.noScopes') }}</p>
        </div>
      </li>
    </ul>

    <AccountStatusMessage v-if="result" :tone="result.tone" :message="result.message" />

    <AccountConfirmDialog
      :open="revoking !== undefined"
      :title="i18n.t('applications.revokeTitle')"
      :description="i18n.t('applications.revokeDescription')"
      :confirm-label="i18n.t('applications.revoke')"
      :cancel-label="i18n.t('common.cancel')"
      :danger="true"
      :confirm-disabled="busy"
      :on-confirm="revoke"
      :on-cancel="() => (revoking = undefined)"
    />
  </section>
</template>
