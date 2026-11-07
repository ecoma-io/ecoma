<script setup lang="ts">
/**
 * `/` — thông tin cá nhân. Đây là trang đích của app, nên nó dùng layout `default`.
 *
 * ⚠️ Chỉ có hai trường: tên hiển thị và ảnh đại diện — đúng những gì
 * `user_profiles` định nghĩa (`01-architecture.md` §3.2). Thêm trường để "lấp
 * layout" là tự đặt ra một lĩnh vực hồ sơ mà tài liệu chưa định nghĩa, và người
 * dùng sẽ nhập vào thứ không được lưu.
 *
 * ⚠️ Ảnh đại diện **chỉ đọc**. `AccountAdapter` không có `uploadAvatar` — upload
 * cần một đường dẫn lưu trữ đã thống nhất, và adapter thật chưa có. Hiện URL nếu
 * có, kèm một dòng nói rõ chưa có upload, thay vì một `<input type="file">` bấm
 * không được. Đó là cách "no dead buttons" được thực thi ở đây: nút bị vô hiệu
 * hoạt động thì nói ra, chứ không giả vờ là hoạt động.
 */
const i18n = useI18n();
const adapter = useAccountAdapter();

const { state, reload } = useAsyncState(() => adapter.getProfile());

const displayName = ref('');
const avatarUrl = ref('');
const result = ref<{ tone: 'success' | 'danger'; message: string } | undefined>(undefined);
const saving = ref(false);

/** Nạp profile vào form — chỉ khi có dữ liệu, để không xoá những gì đang gõ. */
watchEffect(() => {
  if (state.value.kind === 'ready') {
    displayName.value = state.value.value.displayName;
    avatarUrl.value = state.value.value.avatarUrl ?? '';
  }
});

/** Form rỗng sau khi nạp = chưa có thông tin hồ sơ (khác với đang tải). */
const profileIsEmpty = computed(() => {
  if (state.value.kind !== 'ready') {
    return false;
  }
  const profile = state.value.value;
  return profile.displayName === '' && (profile.avatarUrl ?? '') === '';
});

async function save(): Promise<void> {
  saving.value = true;
  result.value = undefined;
  try {
    const saved = await adapter.updateProfile({
      displayName: displayName.value,
      // `undefined` khi để trống: gửi chuỗi rỗng sẽ là một ảnh trỏ tới "", và
      // adapter thật không nên phải phân biệt hai thứ đó.
      avatarUrl: avatarUrl.value === '' ? undefined : avatarUrl.value,
    });
    result.value = saved.ok
      ? { tone: 'success', message: i18n.t('states.saved') }
      : { tone: 'danger', message: `${i18n.t('states.saveFailed')}: ${saved.reason}` };
    if (saved.ok) {
      await reload();
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section>
    <AccountPageHeader
      :title="i18n.t('profile.title')"
      :description="i18n.t('profile.description')"
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
      <p v-if="profileIsEmpty" class="mb-4 text-sm text-muted" data-testid="account-empty">
        {{ i18n.t('states.emptyPersonal') }}
      </p>

      <form class="account-card space-y-5 p-5" data-testid="profile-form" @submit.prevent="save">
        <div>
          <label class="account-label" for="profile-display-name">{{
            i18n.t('profile.displayName')
          }}</label>
          <input
            id="profile-display-name"
            v-model="displayName"
            class="account-field mt-1"
            type="text"
            autocomplete="name"
            aria-describedby="profile-display-name-hint"
            data-testid="profile-display-name"
          />
          <p id="profile-display-name-hint" class="account-hint">
            {{ i18n.t('profile.displayNameHint') }}
          </p>
        </div>

        <div>
          <label class="account-label" for="profile-avatar">{{ i18n.t('profile.avatar') }}</label>
          <img
            v-if="avatarUrl"
            :src="avatarUrl"
            :alt="i18n.t('profile.avatarAlt', { name: displayName })"
            class="mt-2 size-16 rounded-full border border-line object-cover"
            data-testid="profile-avatar"
          />
          <p v-else class="mt-2 text-sm text-muted" data-testid="profile-avatar-missing">
            {{ i18n.t('profile.avatarMissing') }}
          </p>
          <p class="account-hint">{{ i18n.t('profile.avatarHint') }}</p>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            class="account-button-primary"
            :disabled="saving"
            data-testid="profile-save"
          >
            {{ saving ? i18n.t('common.loading') : i18n.t('common.save') }}
          </button>
        </div>

        <AccountStatusMessage v-if="result" :tone="result.tone" :message="result.message" />
      </form>
    </template>
  </section>
</template>
