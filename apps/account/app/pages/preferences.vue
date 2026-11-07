<script setup lang="ts">
/**
 * `/preferences` — locale, timezone, chế độ màu.
 *
 * ⚠️ **Locale hỏng từ server phải hiện ra, không được sửa âm thầm.** Khi
 * `preferences.locale` là `undefined` và `invalidLocale` mang giá trị thô, trang
 * hiện một dòng lỗi nói đúng giá trị đó — đúng tinh thần FR-008a (server reject
 * giá trị lạ chứ không fallback). `useAccountLocale` xử lý cùng tình huống theo
 * hướng đối lập cho phần **hiển thị**: app về tiếng Anh, còn trang này giữ dấu vết
 * của lỗi contract để người dùng và người đọc log thấy.
 *
 * ⚠️ Chọn locale ở đây **lưu qua adapter**, khác với selector trên header: trang
 * này nằm sau đăng nhập nên nó đi qua đường có bằng chứng. Selector trên header
 * chỉ đổi ngôn ngữ hiển thị rồi lưu ở nền, và báo rõ nếu lưu hỏng.
 *
 * ⚠️ Validate timezone **ở client** chỉ để không gửi một cái chắc chắn sai
 * (`Intl.DateTimeFormat` ném `RangeError`). Server vẫn là nơi enforce (FR-008b) —
 * validate ở đây là tiện, không phải biên bảo mật.
 */
import {
  DEFAULT_ACCOUNT_LOCALE,
  parseAccountLocale,
  type AccountLocale,
} from '../i18n/locale-registry';
import type { ColorMode } from '../account-data/types';

const i18n = useI18n();
const adapter = useAccountAdapter();
const { reload } = useAccountPreferences();
const { applySavedLocale, options } = useAccountLocale();

/**
 * Preference là **một** object: có mặt thì luôn có dữ liệu, nên `empty` không
 * bao giờ đúng ở đây. Xem khối chú thích cùng nội dung ở `/security`.
 */
const { state } = useAsyncState(
  () => adapter.getPreferences(),
  (): false => false,
);

const timezone = ref('');
const colorMode = ref<ColorMode>('system');
const localeChoice = ref<AccountLocale>(DEFAULT_ACCOUNT_LOCALE);

const result = ref<{ tone: 'success' | 'danger'; message: string } | undefined>(undefined);
const timezoneInvalid = ref(false);
const saving = ref(false);

watchEffect(() => {
  if (state.value.kind === 'ready') {
    const preferences = state.value.value;
    timezone.value = preferences.timezone;
    colorMode.value = preferences.colorMode;
    // Locale hợp lệ: chọn giá trị đó. Locale hỏng: `locale` là `undefined`, và
    // select buộc phải có một giá trị — dùng default, với lỗi hiển thị bên dưới.
    localeChoice.value = preferences.locale ?? DEFAULT_ACCOUNT_LOCALE;
  }
});

/** Locale hỏng mà server trả về — nguồn của dòng lỗi. */
const invalidLocale = computed(() =>
  state.value.kind === 'ready' ? state.value.value.invalidLocale : undefined,
);

async function save(): Promise<void> {
  if (!isValidTimeZone(timezone.value)) {
    timezoneInvalid.value = true;
    result.value = undefined;
    return;
  }
  timezoneInvalid.value = false;
  saving.value = true;
  result.value = undefined;
  try {
    // Gửi cả ba trường: form này sửa cả ba cùng lúc, và `updatePreferences` giữ
    // nguyên trường không gửi (FR-008e) — nên gửi hết vẫn đúng.
    //
    // Đúng **một** lần ghi: trước đây locale còn được lưu thêm lần thứ hai qua
    // `chooseAndPersist` — một submit ghi hai lần cùng một record, và lần thứ hai
    // hỏng trong khi lần đầu đã thành công thì UI báo thất bại cho một thay đổi
    // đã nằm trên server. `applySavedLocale` áp giá trị đã lưu vào trạng thái
    // hiển thị mà không gửi thêm request nào.
    const updated = await adapter.updatePreferences({
      locale: localeChoice.value,
      timezone: timezone.value,
      colorMode: colorMode.value,
    });
    if (!updated.ok) {
      result.value = { tone: 'danger', message: i18n.t('preferences.saveFailed') };
      return;
    }
    const savedLocale = parseAccountLocale(updated.value.locale);
    if (savedLocale === undefined) {
      // Server trả locale ngoài allowlist: lỗi contract, cũng là thất bại — đúng
      // cách `chooseAndPersist` xử lý và cách trang này hiển thị `invalidLocale`.
      result.value = { tone: 'danger', message: i18n.t('preferences.saveFailed') };
      return;
    }
    // Locale mới đã lưu xong thì locale của app cũng phải theo — nếu không,
    // select sẽ hiện `vi` trong khi cả trang vẫn tiếng Anh.
    applySavedLocale(savedLocale);
    result.value = { tone: 'success', message: i18n.t('states.saved') };
    await reload();
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section>
    <AccountPageHeader
      :title="i18n.t('preferences.title')"
      :description="i18n.t('preferences.description')"
    />

    <AccountLoadingState v-if="state.kind === 'loading'" :label="i18n.t('common.loading')" />

    <AccountErrorState
      v-else-if="state.kind === 'error'"
      :title="i18n.t('states.errorTitle')"
      :body="i18n.t('states.errorBody')"
      :detail="state.message"
    />

    <template v-else>
      <p
        v-if="invalidLocale"
        class="mb-4 rounded-card border border-danger bg-danger-soft px-4 py-3 text-sm text-danger"
        role="alert"
        data-testid="preferences-invalid-locale"
      >
        <code class="font-mono">{{ invalidLocale }}</code>
      </p>

      <form
        class="account-card space-y-5 p-5"
        data-testid="preferences-form"
        @submit.prevent="save"
      >
        <div>
          <label class="account-label" for="preferences-language">{{
            i18n.t('preferences.language')
          }}</label>
          <select
            id="preferences-language"
            v-model="localeChoice"
            class="account-field mt-1"
            data-testid="preferences-language"
          >
            <option v-for="option in options" :key="option.code" :value="option.code">
              {{ option.label }}
            </option>
          </select>
        </div>

        <div>
          <label class="account-label" for="preferences-timezone">{{
            i18n.t('preferences.timezone')
          }}</label>
          <input
            id="preferences-timezone"
            v-model="timezone"
            class="account-field mt-1 font-mono"
            type="text"
            :aria-invalid="timezoneInvalid"
            aria-describedby="preferences-timezone-hint"
            data-testid="preferences-timezone"
          />
          <p id="preferences-timezone-hint" class="account-hint">
            {{ i18n.t('preferences.timezoneHint') }}
          </p>
          <p
            v-if="timezoneInvalid"
            class="mt-1 text-sm text-danger"
            role="alert"
            data-testid="preferences-timezone-invalid"
          >
            {{ i18n.t('preferences.timezoneInvalid') }}
          </p>
        </div>

        <!--
          `disabled` + hint: colour mode là control chỉ-ghi cho tới khi shell thật
          sự áp `preferences.colorMode` (class theme + token dark trong styles.css —
          `@nuxtjs/color-mode` chưa có trong modules). Lưu xong "Saved" mà không có
          gì đổi chính là thứ khối chú thích của trang cấm, nên control nói ra
          trạng thái thật của nó thay vì giả vờ hoạt động.
        -->
        <fieldset disabled data-testid="preferences-color-mode">
          <legend class="account-label">{{ i18n.t('preferences.colorMode') }}</legend>
          <div class="mt-2 flex flex-wrap gap-4">
            <label class="flex items-center gap-2 text-sm text-foam">
              <input v-model="colorMode" type="radio" value="system" name="color-mode" />
              {{ i18n.t('preferences.colorModeSystem') }}
            </label>
            <label class="flex items-center gap-2 text-sm text-foam">
              <input v-model="colorMode" type="radio" value="light" name="color-mode" />
              {{ i18n.t('preferences.colorModeLight') }}
            </label>
            <label class="flex items-center gap-2 text-sm text-foam">
              <input v-model="colorMode" type="radio" value="dark" name="color-mode" />
              {{ i18n.t('preferences.colorModeDark') }}
            </label>
          </div>
          <p
            class="mt-2 text-xs text-muted"
            id="preferences-color-mode-hint"
            data-testid="preferences-color-mode-hint"
          >
            {{ i18n.t('preferences.colorModeHint') }}
          </p>
        </fieldset>

        <button
          type="submit"
          class="account-button-primary"
          :disabled="saving"
          data-testid="preferences-save"
        >
          {{ saving ? i18n.t('common.loading') : i18n.t('common.save') }}
        </button>

        <AccountStatusMessage v-if="result" :tone="result.tone" :message="result.message" />
      </form>
    </template>
  </section>
</template>
