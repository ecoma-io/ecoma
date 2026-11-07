<script setup lang="ts">
/**
 * Language selector của dashboard — đặt trong slot `actions` của shell header.
 *
 * Dùng `<select>` gốc chứ không phải menu tự dựng: nó điều khiển được bằng bàn
 * phím, có hỗ trợ platform (đóng danh sách, chọn bằng chữ cái), và là một form
 * control chuẩn nên screen reader đọc đúng vai trò. Library shell cũng không có
 * primitive `select` nào để mượn, nên đây là lựa chọn duy nhất không phải viết
 * thêm một abstraction.
 *
 * ⚠️ **Không** dùng `switchLocalePath` hay bất kỳ helper dựng URL nào của
 * `nuxt-i18n`: `strategy: 'no_prefix'` khiến locale không nằm trong URL, và đổi
 * ngôn ngữ phải **giữ nguyên route**. Chọn ở đây chỉ đổi locale của composer và
 * lựa chọn đã lưu — không có navigation, nên không có chuyện mất query string
 * hay đổi trang dưới chân người dùng.
 *
 * Style lấy đúng bộ class của `Input` primitive trong shell: control này nằm
 * cạnh các primitive khác trong header nên phải cùng một ngôn ngữ thị giác,
 * và những class đó là token của shell — không tự đặt màu ở app.
 */
import { useI18n } from '#i18n';
import { parsePactBrokerLocale } from '../i18n/locale-registry';
import { usePactBrokerLocale } from '../composables/use-pact-broker-locale';

const { t } = useI18n();
const { preferred, options, chooseLocale } = usePactBrokerLocale();

function select(event: Event): void {
  const next = parsePactBrokerLocale((event.target as HTMLSelectElement).value);

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
    <label class="sr-only" for="pact-broker-language">{{ t('shell.language.label') }}</label>
    <select
      id="pact-broker-language"
      data-testid="pact-broker-language-select"
      class="border-input h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
      :value="preferred"
      :aria-label="t('shell.language.label')"
      :title="t('shell.language.hint')"
      @change="select"
    >
      <option v-for="option in options" :key="option.code" :value="option.code">
        {{ option.label }}
      </option>
    </select>
  </div>
</template>
