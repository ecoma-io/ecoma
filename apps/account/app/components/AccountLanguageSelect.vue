<script setup lang="ts">
/**
 * Language selector.
 *
 * Dùng `<select>` chứ không phải menu tự dựng: nó điều khiển được bằng bàn phím,
 * có hỗ trợ platform (đóng danh sách, chọn bằng chữ cái), và là một form control
 * chuẩn nên screen reader đọc đúng vai trò. Một menu custom đẹp hơn nhưng tự
 * viết lại toàn bộ những thứ đó — đổi lại không có gì đáng giá ở một selector
 * ba mục.
 *
 * ⚠️ **Không** dùng `switchLocalePath` hay bất kỳ đường dựng URL nào của
 * `nuxt-i18n`: `strategy: 'no_prefix'` khiến locale không nằm trong URL, và đổi
 * ngôn ngữ phải **giữ nguyên route** (kể cả `?handle=` của luồng OAuth). Chọn ở
 * đây chỉ đổi `vue-i18n` locale và preference — không có navigation.
 *
 * ⚠️ Thứ tự chuyển ngôn ngữ khi **đã đăng nhập**: đổi ngay (để người dùng thấy
 * ngôn ngữ mới ngay), rồi lưu qua adapter. Nếu lưu hỏng thì **giữ** ngôn ngữ đang
 * hiển thị và báo lỗi — không revert, vì người dùng đã dùng app bằng ngôn ngữ đó
 * trong vài giây; còn preference trên server thì vẫn là giá trị cũ, đúng như
 * trạng thái "chưa lưu" phải nói.
 */
import { parseAccountLocale } from '../i18n/locale-registry';

const {
  authenticated,
  saveFailedLabel = undefined,
  savedLabel = undefined,
  // oxlint-disable-next-line vue/max-props
} = defineProps<{
  /** `true` khi người dùng đã đăng nhập → lựa chọn phải lưu vào tài khoản. */
  readonly authenticated: boolean;
  /** Nhãn thông báo lỗi khi lưu thất bại; bỏ trắng thì không báo. */
  readonly saveFailedLabel?: string;
  /** Nhãn khi đã lưu thành công. */
  readonly savedLabel?: string;
}>();

const i18n = useI18n();
const { preferred, options, chooseLocal, chooseAndPersist } = useAccountLocale();
const adapter = useAccountAdapter();

const saving = ref(false);
const savedNotice = ref<string | undefined>(undefined);
const failedNotice = ref<string | undefined>(undefined);

async function select(event: Event): Promise<void> {
  const target = event.target as HTMLSelectElement;
  const next = parseAccountLocale(target.value);
  if (next === undefined || next === preferred.value) {
    return;
  }

  // Chuyển trước, lưu sau: xem khối chú thích ở trên.
  chooseLocal(next);
  savedNotice.value = undefined;
  failedNotice.value = undefined;

  if (!authenticated) {
    return;
  }

  saving.value = true;
  try {
    const outcome = await chooseAndPersist(next, adapter);
    if (outcome === 'saved') {
      savedNotice.value = savedLabel;
    } else {
      failedNotice.value = saveFailedLabel;
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <label class="account-label" for="account-language">{{ i18n.t('shell.languageLabel') }}</label>
    <select
      id="account-language"
      class="account-field"
      :value="preferred"
      aria-describedby="account-language-hint"
      :aria-busy="saving"
      :disabled="saving"
      data-testid="account-language-select"
      @change="select"
    >
      <option
        v-for="option in options"
        :key="option.code"
        :value="option.code"
        :lang="option.language"
      >
        {{ option.label }}
      </option>
    </select>
    <p id="account-language-hint" class="text-xs text-muted">
      {{ i18n.t('shell.languageHint') }}
    </p>
    <p
      v-if="savedNotice"
      class="text-xs text-success"
      role="status"
      aria-live="polite"
      data-testid="account-language-saved"
    >
      {{ savedNotice }}
    </p>
    <p
      v-if="failedNotice"
      class="text-xs text-danger"
      role="status"
      aria-live="polite"
      data-testid="account-language-failed"
    >
      {{ failedNotice }}
    </p>
  </div>
</template>
