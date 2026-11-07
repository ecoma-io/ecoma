<script setup lang="ts">
/**
 * `/sessions` — các phiên đang hoạt động.
 *
 * ⚠️ Phiên hiện tại **không** có nút thu hồi. Đăng xuất chính phiên này là một
 * hành động khác hẳn về hệ quả so với thu hồi một thiết bị khác, và adapter từ
 * chối nó (`revokeSession` trả hỏng cho `isCurrent`). Hiện nhãn "Thiết bị này"
 * để người dùng biết vì sao không có nút — im lặng bỏ nút sẽ trông như một thiếu
 * sót, còn thêm nút thì là một nút chết.
 */
const i18n = useI18n();
const adapter = useAccountAdapter();
const { formatDateTime } = useAccountFormat();

const { state, reload } = useAsyncState(() => adapter.listSessions());

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
    const revoked = await adapter.revokeSession(id);
    revoking.value = undefined;
    result.value = revoked.ok
      ? { tone: 'success', message: i18n.t('sessions.revoked') }
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
      :title="i18n.t('sessions.title')"
      :description="i18n.t('sessions.description')"
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

    <template v-else>
      <p v-if="state.kind === 'empty'" class="mb-4 text-sm text-muted" data-testid="account-empty">
        {{ i18n.t('states.emptySessions') }}
      </p>

      <ul v-else class="space-y-3" data-testid="session-list">
        <li
          v-for="session in state.value"
          :key="session.id"
          class="account-card px-4 py-3"
          :data-testid="`session-row-${session.id}`"
          :data-current="session.isCurrent"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="font-medium text-foam">
                {{ session.device }}
                <span
                  v-if="session.isCurrent"
                  class="ml-2 rounded-full bg-surface px-2 py-0.5 text-xs font-semibold text-muted"
                  data-testid="session-current-badge"
                >
                  {{ i18n.t('sessions.current') }}
                </span>
              </p>
              <dl class="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-muted sm:grid-cols-2">
                <div class="flex gap-2">
                  <dt class="font-medium text-foam">{{ i18n.t('sessions.lastSeen') }}</dt>
                  <dd>{{ formatDateTime(session.lastSeenAt) }}</dd>
                </div>
                <div v-if="session.location" class="flex gap-2">
                  <dt class="font-medium text-foam">{{ i18n.t('sessions.location') }}</dt>
                  <dd>{{ session.location }}</dd>
                </div>
                <div class="flex gap-2">
                  <dt class="font-medium text-foam">{{ i18n.t('sessions.signedInAt') }}</dt>
                  <dd>{{ formatDateTime(session.signedInAt) }}</dd>
                </div>
                <div class="flex gap-2">
                  <dt class="font-medium text-foam">{{ i18n.t('sessions.expiresAt') }}</dt>
                  <dd>{{ formatDateTime(session.expiresAt) }}</dd>
                </div>
              </dl>
            </div>
            <button
              v-if="!session.isCurrent"
              type="button"
              class="account-button-danger"
              :disabled="busy"
              :data-testid="`session-revoke-${session.id}`"
              @click="requestRevoke(session.id)"
            >
              {{ i18n.t('sessions.revoke') }}
            </button>
          </div>
        </li>
      </ul>
    </template>

    <AccountStatusMessage v-if="result" :tone="result.tone" :message="result.message" />

    <AccountConfirmDialog
      :open="revoking !== undefined"
      :title="i18n.t('sessions.revokeTitle')"
      :description="i18n.t('sessions.revokeDescription')"
      :confirm-label="i18n.t('sessions.revoke')"
      :cancel-label="i18n.t('common.cancel')"
      :danger="true"
      :confirm-disabled="busy"
      :on-confirm="revoke"
      :on-cancel="() => (revoking = undefined)"
    />
  </section>
</template>
