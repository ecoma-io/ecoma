<script setup lang="ts">
/**
 * `/security` — các yếu tố xác thực.
 *
 * ⚠️ **Không có phần quản lý mật khẩu, và không có phần "khôi phục tài khoản
 * bằng mật khẩu".** Mã khôi phục ở trang này là *mã khôi phục MFA* — dùng khi mất
 * cả email lẫn ứng dụng xác thực. Nó là hai khái niệm khác nhau và lẫn chúng là
 * một loại lỗi đã xảy ra với nhiều sản phẩm: `security.noPasswordNote` nói thẳng
 * điều đó, và không có control nào trên trang này tới một form đổi mật khẩu.
 *
 * ⚠️ Passkey ở đây là **thiết bị đã đăng nhập**, không phải phương thức đăng nhập.
 * Tài liệu chưa chốt passkey là đường đăng nhập chính, nên trang không đề nghị
 * "đăng nhập bằng passkey" — chỉ cho xem và gỡ passkey đã đăng ký. Cùng lý do,
 * `/login` không có nút passkey.
 *
 * ⚠️ MFA **không** được trình bày là bắt buộc: trạng thái TOTP chỉ cho biết đang
 * bật hay tắt, và câu mô tả không hứa bảo vệ bắt buộc.
 *
 * ⚠️ **Năng lực security là bản đồ năng lực thật của backend, không phải cờ UI.**
 * `adapter.securityCapabilities` nói năng lực nào có đường BFF hôm nay; phần
 * tử `false` được render là trạng thái "chưa khả dụng" — không có danh sách,
 * không có control — thay vì bày một hành động chỉ thành công được qua dữ liệu
 * giả. Các loader bên dưới vẫn được tạo (hook không gọi có điều kiện được) nhưng
 * trả giá trị giữ chỗ khi năng lực vắng mặt; giá trị đó **không bao giờ được
 * render** vì nhánh unavailable chặn trước nó trong template.
 */
const i18n = useI18n();
const adapter = useAccountAdapter();
const { formatDateTime, formatCount } = useAccountFormat();

const capabilities = adapter.securityCapabilities;

const { state: passkeys, reload: reloadPasskeys } = useAsyncState(() =>
  capabilities.passkeys
    ? adapter.listPasskeys()
    : // Giữ chỗ, không bao giờ render — xem chú thích capabilities ở trên.
      Promise.resolve([]),
);

/**
 * Ba khối còn lại là **một** object, không phải danh sách.
 *
 * Trạng thái `empty` của `useAsyncState` là dành cho "danh sách không có phần tử";
 * một object có mặt thì luôn có dữ liệu. Vì vậy `isEmpty` trả `false` cho mọi giá
 * trị ở đây: trạng thái rỗng là `loading` hoặc `error`, còn "chưa bật TOTP" và
 * "chưa sinh mã khôi phục" là **dữ liệu** được render bình thường, không phải
 * empty state. Truyền `isEmpty` tường minh thay vì để mặc định (chỉ bắt mảng) để
 * ý định ở đây được nói ra ở đúng chỗ.
 */
const NEVER_EMPTY = (): false => false;

const { state: totp, reload: reloadTotp } = useAsyncState(
  () =>
    capabilities.totp
      ? adapter.getTotpState()
      : // Giữ chỗ, không bao giờ render — xem chú thích capabilities ở trên.
        Promise.resolve({ enabled: false, confirmedAt: undefined }),
  NEVER_EMPTY,
);
const { state: recovery, reload: reloadRecovery } = useAsyncState(
  () =>
    capabilities['recovery-codes']
      ? adapter.getRecoveryCodesState()
      : // Giữ chỗ, không bao giờ render — xem chú thích capabilities ở trên.
        Promise.resolve({ remaining: undefined }),
  NEVER_EMPTY,
);

const removing = ref<string | undefined>(undefined);
const result = ref<{ tone: 'success' | 'danger'; message: string } | undefined>(undefined);
const busy = ref(false);

async function removePasskey(): Promise<void> {
  const id = removing.value;
  if (id === undefined) {
    return;
  }
  busy.value = true;
  result.value = undefined;
  try {
    const removed = await adapter.removePasskey(id);
    // Đóng dialog **ngay sau** thao tác, trước khi render kết quả: hai trang anh
    // em (`applications`, `sessions`) đều làm vậy. Không reset thì `open` vẫn
    // `true`, dialog treo vĩnh viễn, nút xác nhận lại được enable (busy đã false)
    // và bấm lần nữa sẽ gọi `removePasskey` cho một id đã bị gỡ.
    removing.value = undefined;
    result.value = removed.ok
      ? { tone: 'success', message: i18n.t('security.passkeyRemoved') }
      : { tone: 'danger', message: `${i18n.t('states.saveFailed')}: ${removed.reason}` };
    if (removed.ok) {
      await reloadPasskeys();
    }
  } finally {
    busy.value = false;
  }
}

function requestRemovePasskey(id: string): void {
  result.value = undefined;
  removing.value = id;
}
</script>

<template>
  <section>
    <AccountPageHeader
      :title="i18n.t('security.title')"
      :description="i18n.t('security.description')"
    />

    <p
      class="account-card mb-6 border-brand/40 bg-surface-raised px-4 py-3 text-sm text-muted"
      data-testid="security-no-password"
    >
      {{ i18n.t('security.noPasswordNote') }}
    </p>

    <h2 class="mb-2 text-base font-semibold">{{ i18n.t('security.passkeys') }}</h2>
    <p v-if="capabilities.passkeys" class="mb-3 text-sm text-muted">
      {{ i18n.t('security.passkeyHint') }}
    </p>

    <!-- Năng lực vắng mặt: nói rõ trạng thái thay vì bày danh sách hay control. -->
    <p
      v-if="!capabilities.passkeys"
      class="mb-3 text-sm text-muted"
      data-testid="passkeys-unavailable"
    >
      {{ i18n.t('security.capabilityUnavailable') }}
    </p>
    <AccountLoadingState
      v-else-if="passkeys.kind === 'loading'"
      :label="i18n.t('common.loading')"
    />
    <AccountErrorState
      v-else-if="passkeys.kind === 'error'"
      :title="i18n.t('states.errorTitle')"
      :body="i18n.t('states.errorBody')"
      :detail="passkeys.message"
      :retry-label="i18n.t('common.retry')"
      :on-retry="reloadPasskeys"
    />
    <AccountEmptyState
      v-else-if="passkeys.kind === 'empty'"
      :message="i18n.t('security.passkeyEmpty')"
    />
    <ul v-else class="space-y-3" data-testid="passkey-list">
      <li
        v-for="passkey in passkeys.value"
        :key="passkey.id"
        class="account-card flex flex-wrap items-center justify-between gap-3 px-4 py-3"
      >
        <div>
          <p class="font-medium text-foam">{{ passkey.name }}</p>
          <p class="text-sm text-muted">{{ formatDateTime(passkey.createdAt) }}</p>
        </div>
        <button
          type="button"
          class="account-button-danger"
          :disabled="busy"
          :data-testid="`passkey-remove-${passkey.id}`"
          @click="requestRemovePasskey(passkey.id)"
        >
          {{ i18n.t('common.remove') }}
        </button>
      </li>
    </ul>

    <AccountStatusMessage v-if="result" :tone="result.tone" :message="result.message" />

    <div v-if="capabilities.passkeys" class="mt-3">
      <button
        type="button"
        class="account-button-secondary"
        disabled
        data-testid="passkey-add-disabled"
      >
        {{ i18n.t('security.passkeyAdd') }}
      </button>
    </div>

    <div class="mt-8 border-t border-line pt-6">
      <h2 class="mb-2 text-base font-semibold">{{ i18n.t('security.totp') }}</h2>
      <!-- Năng lực vắng mặt: nói rõ trạng thái thay vì bày control. -->
      <p v-if="!capabilities.totp" class="mb-3 text-sm text-muted" data-testid="totp-unavailable">
        {{ i18n.t('security.capabilityUnavailable') }}
      </p>
      <template v-else>
        <p class="mb-3 text-sm text-muted">{{ i18n.t('security.totpHint') }}</p>
        <AccountLoadingState v-if="totp.kind === 'loading'" :label="i18n.t('common.loading')" />
        <AccountErrorState
          v-else-if="totp.kind === 'error'"
          :title="i18n.t('states.errorTitle')"
          :body="i18n.t('states.errorBody')"
          :detail="totp.message"
          :retry-label="i18n.t('common.retry')"
          :on-retry="reloadTotp"
        />
        <div v-else class="flex flex-wrap items-center gap-3">
          <p class="text-sm text-muted" data-testid="totp-state">
            {{
              totp.value.enabled ? i18n.t('emails.statusVerified') : i18n.t('common.unavailable')
            }}
          </p>
          <button
            type="button"
            class="account-button-secondary"
            disabled
            data-testid="totp-toggle-disabled"
          >
            {{
              totp.value.enabled ? i18n.t('security.totpDisable') : i18n.t('security.totpEnroll')
            }}
          </button>
        </div>
      </template>
    </div>

    <div class="mt-8 border-t border-line pt-6">
      <h2 class="mb-2 text-base font-semibold">{{ i18n.t('security.recoveryCodes') }}</h2>
      <!-- Năng lực vắng mặt: nói rõ trạng thái thay vì bày control. -->
      <p
        v-if="!capabilities['recovery-codes']"
        class="mb-3 text-sm text-muted"
        data-testid="recovery-codes-unavailable"
      >
        {{ i18n.t('security.capabilityUnavailable') }}
      </p>
      <template v-else>
        <p class="mb-3 text-sm text-muted">{{ i18n.t('security.recoveryCodesHint') }}</p>
        <AccountLoadingState v-if="recovery.kind === 'loading'" :label="i18n.t('common.loading')" />
        <AccountErrorState
          v-else-if="recovery.kind === 'error'"
          :title="i18n.t('states.errorTitle')"
          :body="i18n.t('states.errorBody')"
          :detail="recovery.message"
          :retry-label="i18n.t('common.retry')"
          :on-retry="reloadRecovery"
        />
        <div v-else class="space-y-3">
          <p class="text-sm text-muted" data-testid="recovery-codes-state">
            {{
              recovery.value.remaining === undefined
                ? i18n.t('common.unavailable')
                : i18n.t('security.recoveryCodesRemaining', {
                    count: formatCount(recovery.value.remaining),
                  })
            }}
          </p>
          <p class="text-xs text-muted">{{ i18n.t('security.recoveryCodesWarning') }}</p>
          <button
            type="button"
            class="account-button-secondary"
            disabled
            data-testid="recovery-codes-regenerate-disabled"
          >
            {{ i18n.t('security.recoveryCodesRegenerate') }}
          </button>
        </div>
      </template>
    </div>

    <AccountConfirmDialog
      :open="removing !== undefined"
      :title="i18n.t('security.passkeys')"
      :description="i18n.t('security.passkeyHint')"
      :confirm-label="i18n.t('common.remove')"
      :cancel-label="i18n.t('common.cancel')"
      :danger="true"
      :confirm-disabled="busy"
      :on-confirm="removePasskey"
      :on-cancel="() => (removing = undefined)"
    />
  </section>
</template>
