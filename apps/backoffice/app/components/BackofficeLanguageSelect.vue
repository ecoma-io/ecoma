<script setup lang="ts">
/**
 * Language selector của backoffice — đặt trong slot `actions` của shell header.
 *
 * Dùng `<select>` gốc chứ không phải menu tự dựng: nó điều khiển được bằng bàn
 * phím, có hỗ trợ platform (đóng danh sách, chọn bằng chữ cái), và là một form
 * control chuẩn nên screen reader đọc đúng vai trò. Một menu custom đẹp hơn
 * nhưng tự viết lại toàn bộ những thứ đó — đổi lại không có gì đáng giá ở một
 * selector ba mục. Library shell cũng không có primitive `select` nào để mượn
 * (xem `lib/ui/index.ts`), nên đây cũng là lựa chọn duy nhất không phải viết
 * thêm một abstraction trong PR này.
 *
 * ⚠️ **Không** dùng `switchLocalePath` hay bất kỳ helper dựng URL nào của
 * `nuxt-i18n`: `strategy: 'no_prefix'` khiến locale không nằm trong URL, và đổi
 * ngôn ngữ phải **giữ nguyên route**. Chọn ở đây chỉ đổi locale của composer và
 * lựa chọn đã lưu — không có navigation, nên không có chuyện mất query string
 * hay đổi trang dưới chân người dùng.
 *
 * Style lấy đúng bộ class của `Input` primitive trong shell (`h-9`, `border-input`,
 * `bg-transparent`, `focus-visible:ring-*`…): control này nằm cạnh các primitive
 * khác trong header nên phải cùng một ngôn ngữ thị giác, và những class đó là
 * token của shell — không tự đặt màu ở app.
 */
import { useI18n } from '#i18n';
import { parseBackofficeLocale } from '../i18n/locale-registry';
import { useBackofficeLocale } from '../composables/use-backoffice-locale';

const { t } = useI18n();
const { preferred, options, chooseLocale } = useBackofficeLocale();

function select(event: Event): void {
  const next = parseBackofficeLocale((event.target as HTMLSelectElement).value);

  // Giá trị không nằm trong registry thì **không** làm gì: đổi sang một locale
  // khác thay cho nó sẽ biến "giá trị lạ" thành một lựa chọn hợp lệ mà người
  // dùng không hề bấm.
  if (next === undefined || next === preferred.value) {
    return;
  }

  chooseLocale(next);
}
</script>

<template>
  <div class="flex items-center gap-2">
    <label class="sr-only" for="backoffice-language">{{ t('shell.language.label') }}</label>
    <select
      id="backoffice-language"
      data-testid="backoffice-language-select"
      class="border-input h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
      :value="preferred"
      :aria-label="t('shell.language.label')"
      :title="t('shell.language.hint')"
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
  </div>
</template>
