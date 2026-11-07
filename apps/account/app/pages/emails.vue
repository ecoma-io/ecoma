<script setup lang="ts">
/**
 * `/emails` — danh sách địa chỉ email.
 *
 * ⚠️ Địa chỉ đăng nhập **không** cho xoá khi nó là địa chỉ `verified` cuối cùng.
 * Ràng buộc này xuất hiệt ở ba chỗ, và cả ba đều cần: nút bị vô hiệu hoạt động
 * kèm lý do (người dùng thấy ngay, không phải bấm rồi mới nhận lỗi), nút bị ẩn
 * hẳn trong dialog xác nhận (không có đường nào để bấm nhầm), và adapter trả
 * `Result` hỏng (server là nơi enforce thật — UI không bao giờ là security
 * boundary).
 *
 * ⚠️ Địa chỉ `pending` chưa dùng để đăng nhập được, nên nó **không** mang cờ
 * `isSignInAddress` và vẫn xoá được.
 */
import type { AccountEmail } from '../account-data/types';

const i18n = useI18n();
const adapter = useAccountAdapter();

const { state, reload } = useAsyncState(() => adapter.listEmails());

const newAddress = ref('');
const addResult = ref<{ tone: 'success' | 'danger'; message: string } | undefined>(undefined);
const adding = ref(false);

const removing = ref<AccountEmail | undefined>(undefined);
const removeResult = ref<{ tone: 'success' | 'danger'; message: string } | undefined>(undefined);
const removingBusy = ref(false);

const resending = ref<string | undefined>(undefined);
const verifyNotice = ref<string | undefined>(undefined);

async function add(): Promise<void> {
  if (newAddress.value.trim() === '') {
    return;
  }
  adding.value = true;
  addResult.value = undefined;
  try {
    const saved = await adapter.addEmail(newAddress.value.trim());
    addResult.value = saved.ok
      ? { tone: 'success', message: i18n.t('emails.verifySent') }
      : { tone: 'danger', message: i18n.t('emails.addFailed') };
    if (saved.ok) {
      newAddress.value = '';
      await reload();
    }
  } finally {
    adding.value = false;
  }
}

async function resend(email: AccountEmail): Promise<void> {
  resending.value = email.id;
  verifyNotice.value = undefined;
  try {
    const sent = await adapter.resendVerification(email.id);
    verifyNotice.value = sent.ok ? i18n.t('emails.verifySent') : i18n.t('emails.addFailed');
  } finally {
    resending.value = undefined;
  }
}

async function remove(): Promise<void> {
  const target = removing.value;
  if (!target) {
    return;
  }
  removingBusy.value = true;
  removeResult.value = undefined;
  try {
    const removed = await adapter.removeEmail(target.id);
    removing.value = undefined;
    removeResult.value = removed.ok
      ? { tone: 'success', message: i18n.t('emails.removed') }
      : { tone: 'danger', message: i18n.t('emails.removeBlocked') };
    await reload();
  } finally {
    removingBusy.value = false;
  }
}

function confirmRemove(email: AccountEmail): void {
  removeResult.value = undefined;
  removing.value = email;
}
</script>

<template>
  <section>
    <AccountPageHeader
      :title="i18n.t('emails.title')"
      :description="i18n.t('emails.description')"
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

    <AccountEmptyState v-else-if="state.kind === 'empty'" :message="i18n.t('states.emptyEmails')" />

    <ul v-else class="space-y-3" data-testid="email-list">
      <li
        v-for="email in state.value"
        :key="email.id"
        class="account-card flex flex-wrap items-center justify-between gap-3 px-4 py-3"
        :data-testid="`email-row-${email.id}`"
      >
        <div class="min-w-0">
          <p class="truncate font-medium text-foam">{{ email.address }}</p>
          <p class="text-sm text-muted">
            <span class="sr-only">{{ i18n.t('emails.status') }}: </span>
            {{
              email.status === 'verified'
                ? i18n.t('emails.statusVerified')
                : i18n.t('emails.statusPending')
            }}
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button
            v-if="email.status === 'pending'"
            type="button"
            class="account-button-secondary"
            :disabled="resending === email.id"
            @click="resend(email)"
          >
            {{ i18n.t('emails.verify') }}
          </button>
          <button
            type="button"
            class="account-button-danger"
            :disabled="email.isSignInAddress"
            :title="email.isSignInAddress ? i18n.t('emails.removeBlocked') : undefined"
            :data-testid="`email-remove-${email.id}`"
            @click="confirmRemove(email)"
          >
            {{ i18n.t('common.remove') }}
          </button>
          <p
            v-if="email.isSignInAddress"
            class="w-full text-xs text-muted sm:w-auto"
            :data-testid="`email-blocked-${email.id}`"
          >
            {{ i18n.t('emails.removeBlocked') }}
          </p>
        </div>
      </li>
    </ul>

    <p v-if="verifyNotice" class="mt-3 text-sm text-success" role="status" aria-live="polite">
      {{ verifyNotice }}
    </p>
    <AccountStatusMessage
      v-if="removeResult"
      :tone="removeResult.tone"
      :message="removeResult.message"
    />

    <form
      class="account-card mt-6 space-y-3 p-5"
      data-testid="email-add-form"
      @submit.prevent="add"
    >
      <h2 class="text-base font-semibold">{{ i18n.t('emails.addTitle') }}</h2>
      <p class="text-sm text-muted">{{ i18n.t('emails.addDescription') }}</p>
      <div class="flex flex-wrap items-end gap-3">
        <div class="min-w-64 flex-1">
          <label class="account-label" for="email-new-address">{{
            i18n.t('emails.address')
          }}</label>
          <input
            id="email-new-address"
            v-model="newAddress"
            class="account-field mt-1"
            type="email"
            autocomplete="email"
            required
            data-testid="email-new-address"
          />
        </div>
        <button
          type="submit"
          class="account-button-primary"
          :disabled="adding"
          data-testid="email-add-submit"
        >
          {{ adding ? i18n.t('common.loading') : i18n.t('emails.addSubmit') }}
        </button>
      </div>
      <AccountStatusMessage v-if="addResult" :tone="addResult.tone" :message="addResult.message" />
    </form>

    <AccountConfirmDialog
      :open="removing !== undefined"
      :title="i18n.t('emails.removeTitle')"
      :description="
        removing?.isSignInAddress
          ? i18n.t('emails.removeBlocked')
          : i18n.t('emails.removeDescription')
      "
      :confirm-label="i18n.t('common.remove')"
      :cancel-label="i18n.t('common.cancel')"
      :danger="true"
      :confirm-disabled="removingBusy || removing?.isSignInAddress === true"
      :on-confirm="remove"
      :on-cancel="() => (removing = undefined)"
    />
  </section>
</template>
