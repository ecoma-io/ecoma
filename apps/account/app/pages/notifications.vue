<script setup lang="ts">
/**
 * `/notifications` — ý định nhận thông báo.
 *
 * ⚠️ Trang này là **ý định**, không phải danh sách thiết bị. Không có subscription
 * id, không có trạng thái gửi, không có nút "đăng ký thiết bị này" — những thứ đó
 * thuộc service khác (`notification_preferences` chỉ lưu ý định,
 * `01-architecture.md` §3.4). `boundaryNote` nói điều đó ngay trên trang để không
 * ai tưởng đang xem bảng điều khiển gửi tin.
 *
 * ⚠️ Mỗi toggle **lưu ngay khi bật/tắt**, không có nút "Lưu". Với ba lựa chọn
 * độc lập, một nút lưu chung nghĩa là phải nhớ chuyện gì đã đổi; lưu ngay cho
 * trạng thái trên màn hình luôn là trạng thái đã lưu, và nhánh hỏng hiện ngay tại
 * chỗ vừa bấm.
 *
 * ⚠️ Nhánh hỏng **revert** toggle: giữ vị trí bật khi server đã từ chối sẽ nói dối
 * rằng lựa chọn đã được giữ. Đây là nơi duy nhất trong app revert — các trang khác
 * giữ nguyên form và báo lỗi, vì ở đó người dùng còn đang soạn.
 */
import type { NotificationPreferences } from '../account-data/types';

const i18n = useI18n();
const adapter = useAccountAdapter();

const { state, reload } = useAsyncState(() => adapter.getNotificationPreferences());

const pending = ref<keyof NotificationPreferences | undefined>(undefined);
const result = ref<{ tone: 'success' | 'danger'; message: string } | undefined>(undefined);

const preferences = computed(() => (state.value.kind === 'ready' ? state.value.value : undefined));

type NotificationKey = keyof NotificationPreferences;

const FIELDS: readonly { key: NotificationKey; labelKey: string; hintKey: string }[] = [
  { key: 'serviceEmail', labelKey: 'notifications.email', hintKey: 'notifications.emailHint' },
  {
    key: 'productUpdates',
    labelKey: 'notifications.product',
    hintKey: 'notifications.productHint',
  },
  { key: 'marketing', labelKey: 'notifications.marketing', hintKey: 'notifications.marketingHint' },
];

async function toggle(key: NotificationKey, next: boolean): Promise<void> {
  const current = preferences.value;
  if (!current || pending.value !== undefined) {
    return;
  }
  pending.value = key;
  result.value = undefined;
  try {
    const saved = await adapter.updateNotificationPreferences({ [key]: next });
    if (saved.ok) {
      result.value = { tone: 'success', message: i18n.t('states.saved') };
    } else {
      result.value = {
        tone: 'danger',
        message: `${i18n.t('states.saveFailed')}: ${saved.reason}`,
      };
    }
    // Reload trong cả hai nhánh để toggle trở lại giá trị server thật — xem khối
    // chú thích phía trên.
    await reload();
  } catch (error) {
    // Adapter thật chỉ trả `Result` cho lỗi nghiệp vụ; còn `$fetch` reject khi
    // mạng lỗi. Không bắt thì rejection chạy ra ngoài event handler, `result`
    // vẫn `undefined`, và checkbox giữ vị trí người dùng bấm trong khi server
    // chưa nhận — đúng thứ khối chú thích cấm. Bắt và reload để revert.
    result.value = {
      tone: 'danger',
      message: `${i18n.t('states.saveFailed')}: ${error instanceof Error ? error.message : String(error)}`,
    };
    await reload();
  } finally {
    pending.value = undefined;
  }
}
</script>

<template>
  <section>
    <AccountPageHeader
      :title="i18n.t('notifications.title')"
      :description="i18n.t('notifications.description')"
    />

    <p
      class="mb-4 rounded-card border border-line bg-surface-raised px-4 py-3 text-sm text-muted"
      data-testid="notifications-boundary"
    >
      {{ i18n.t('notifications.boundaryNote') }}
    </p>

    <AccountLoadingState v-if="state.kind === 'loading'" :label="i18n.t('common.loading')" />

    <AccountErrorState
      v-else-if="state.kind === 'error'"
      :title="i18n.t('states.errorTitle')"
      :body="i18n.t('states.errorBody')"
      :detail="state.message"
      :retry-label="i18n.t('common.retry')"
      :on-retry="reload"
    />

    <div v-else class="account-card divide-y divide-line" data-testid="notification-preferences">
      <div
        v-for="field in FIELDS"
        :key="field.key"
        class="flex flex-wrap items-start justify-between gap-3 px-5 py-4"
      >
        <div class="min-w-0">
          <p class="font-medium text-foam">{{ i18n.t(field.labelKey) }}</p>
          <p class="text-sm text-muted">{{ i18n.t(field.hintKey) }}</p>
        </div>
        <label class="flex items-center gap-2 text-sm font-medium text-foam">
          <input
            type="checkbox"
            class="size-4"
            :checked="preferences?.[field.key]"
            :disabled="pending !== undefined"
            :data-testid="`notification-${field.key}`"
            @change="toggle(field.key, ($event.target as HTMLInputElement).checked)"
          />
          <span class="sr-only">{{ i18n.t(field.labelKey) }}</span>
        </label>
      </div>
    </div>

    <AccountStatusMessage v-if="result" :tone="result.tone" :message="result.message" />
  </section>
</template>
