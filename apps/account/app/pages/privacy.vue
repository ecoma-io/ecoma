<script setup lang="ts">
/**
 * `/privacy` — yêu cầu quyền riêng tư và dữ liệu cá nhân.
 *
 * ⚠️ Ba khái niệm tách biệt, trang này chỉ có một: **privacy request**. Không có
 * nút "cho phép ứng dụng" (đó là `/consent`), không có toggle thông báo (đó là
 * `/notifications`). FR-013b cấm dùng chung bảng, và UI tách ba màn hình là cách
 * giữ ranh giới đó nhìn thấy được.
 *
 * ⚠️ **Nộp yêu cầu không phải là đã xong.** Yêu cầu mới vào trạng thái `pending`,
 * và trang hiện đúng vậy: badge "Đã nhận" cộng với câu `privacy.submittedBody` nói
 * rõ đây là yêu cầu chứ không phải hành động đã hoàn tất. Chỉ khi adapter nói
 * `completed` thì badge mới là "Đã hoàn thành" — nói trước là nói dối về việc đã
 * xoá dữ liệu của ai đó.
 */
import type { PrivacyRequestKind, PrivacyRequestStatus } from '../account-data/types';

const i18n = useI18n();
const adapter = useAccountAdapter();
const { formatDateTime } = useAccountFormat();

const { state, reload } = useAsyncState(() => adapter.listPrivacyRequests());

const confirmKind = ref<PrivacyRequestKind | undefined>(undefined);
const result = ref<{ tone: 'success' | 'danger'; message: string } | undefined>(undefined);
const busy = ref(false);

const KIND_KEYS: Record<PrivacyRequestKind, { title: string; description: string }> = {
  export: { title: 'privacy.export', description: 'privacy.exportDescription' },
  correct: { title: 'privacy.correct', description: 'privacy.correctDescription' },
  delete: { title: 'privacy.delete', description: 'privacy.deleteDescription' },
  restrict: { title: 'privacy.restrict', description: 'privacy.restrictDescription' },
  object: { title: 'privacy.object', description: 'privacy.objectDescription' },
};

const STATUS_KEYS: Record<PrivacyRequestStatus, string> = {
  pending: 'privacy.statusPending',
  'in-progress': 'privacy.statusInProgress',
  completed: 'privacy.statusCompleted',
  rejected: 'privacy.statusRejected',
};

const KINDS = Object.keys(KIND_KEYS) as PrivacyRequestKind[];

async function submit(): Promise<void> {
  const kind = confirmKind.value;
  if (kind === undefined) {
    return;
  }
  busy.value = true;
  result.value = undefined;
  try {
    const created = await adapter.submitPrivacyRequest(kind);
    confirmKind.value = undefined;
    result.value = created.ok
      ? { tone: 'success', message: i18n.t('privacy.submitted') }
      : { tone: 'danger', message: `${i18n.t('states.saveFailed')}: ${created.reason}` };
    if (created.ok) {
      await reload();
    }
  } finally {
    busy.value = false;
  }
}

function requestSubmit(kind: PrivacyRequestKind): void {
  result.value = undefined;
  confirmKind.value = kind;
}
</script>

<template>
  <section>
    <AccountPageHeader
      :title="i18n.t('privacy.title')"
      :description="i18n.t('privacy.description')"
    />

    <h2 class="mb-3 text-base font-semibold">{{ i18n.t('privacy.actionsHeading') }}</h2>

    <ul class="mb-8 grid gap-3 sm:grid-cols-2" data-testid="privacy-actions">
      <li
        v-for="kind in KINDS"
        :key="kind"
        class="account-card flex flex-col gap-2 p-4"
        :data-testid="`privacy-action-${kind}`"
      >
        <p class="font-medium text-foam">{{ i18n.t(KIND_KEYS[kind].title) }}</p>
        <p class="text-sm text-muted">{{ i18n.t(KIND_KEYS[kind].description) }}</p>
        <button
          type="button"
          class="account-button-secondary self-start"
          :disabled="busy"
          @click="requestSubmit(kind)"
        >
          {{ i18n.t('common.confirm') }}
        </button>
      </li>
    </ul>

    <AccountStatusMessage v-if="result" :tone="result.tone" :message="result.message" />
    <p v-if="result?.tone === 'success'" class="mt-2 text-sm text-muted">
      {{ i18n.t('privacy.submittedBody') }}
    </p>

    <h2 class="mb-3 text-base font-semibold">{{ i18n.t('privacy.yourRequests') }}</h2>

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
      :message="i18n.t('states.emptyPrivacy')"
    />

    <ul v-else class="space-y-3" data-testid="privacy-request-list">
      <li
        v-for="request in state.value"
        :key="request.id"
        class="account-card flex flex-wrap items-center justify-between gap-3 px-4 py-3"
        :data-testid="`privacy-request-${request.id}`"
      >
        <div>
          <p class="font-medium text-foam">{{ i18n.t(KIND_KEYS[request.kind].title) }}</p>
          <p class="text-sm text-muted">
            {{ i18n.t('privacy.deadline') }}: {{ formatDateTime(request.dueAt) }}
          </p>
        </div>
        <span
          class="rounded-full px-2 py-1 text-xs font-semibold"
          :class="
            request.status === 'completed'
              ? 'bg-success-soft text-success'
              : request.status === 'rejected'
                ? 'bg-danger-soft text-danger'
                : 'bg-surface text-muted'
          "
          :data-status="request.status"
          data-testid="privacy-request-status"
        >
          {{ i18n.t(STATUS_KEYS[request.status]) }}
        </span>
      </li>
    </ul>

    <AccountConfirmDialog
      :open="confirmKind !== undefined"
      :title="i18n.t('privacy.submitTitle')"
      :description="
        confirmKind === undefined
          ? ''
          : `${i18n.t(KIND_KEYS[confirmKind].title)} — ${i18n.t(KIND_KEYS[confirmKind].description)} ${i18n.t('privacy.confirmRequired')}`
      "
      :confirm-label="i18n.t('common.confirm')"
      :cancel-label="i18n.t('common.cancel')"
      :danger="confirmKind === 'delete'"
      :confirm-disabled="busy"
      :on-confirm="submit"
      :on-cancel="() => (confirmKind = undefined)"
    />
  </section>
</template>
